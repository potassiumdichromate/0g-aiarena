/**
 * Background indexer — listens for the arena-economy contract events on 0G
 * Chain and mirrors them into Postgres (OnChainEvent), plus periodic
 * TreasurySnapshot captures.
 *
 * Design choice: `contract.on(eventName, handler)` (ethers' websocket/polling
 * event subscription) rather than a manual queryFilter poll loop. 0G Chain's
 * JSON-RPC endpoint doesn't advertise a websocket URL in this deployment, so
 * ethers falls back to its built-in polling provider under the hood anyway —
 * but `contract.on` gives us automatic re-poll/backoff and per-log dedup for
 * free, versus hand-rolling a queryFilter loop with block-range bookkeeping.
 * The tradeoff is that a dropped provider connection silently stops new
 * events until the process restarts; the 15-minute TreasurySnapshot interval
 * below is the safety net for that failure mode (it doesn't backfill missed
 * OnChainEvent rows, but it keeps the treasury dashboard from going stale,
 * and OnChainEvent upserts are idempotent so a service restart / listener
 * re-attach naturally recovers via ethers' own log replay on reconnect).
 */
import { ethers } from 'ethers';
import { prisma, ArenaEventName, Prisma } from '@ai-arena/db-client';
import {
  arenaTreasuryRead,
  arenaEscrowRead,
  arenaTournamentRead,
  rewardDistributorRead,
  contractAddresses,
} from './contracts';

const TREASURY_SNAPSHOT_INTERVAL_MS = 15 * 60 * 1000;

type EventArgMapper = (args: ethers.Result) => { playerAddress: string | null; args: Record<string, unknown> };

function toDecimalString(value: unknown): string {
  return ethers.formatEther(value as bigint);
}

// ── Per-event argument mappers ──────────────────────────────────────────────

const rewardDistributorMappers: Record<string, EventArgMapper> = {
  AgentRewardGranted: (a) => ({
    playerAddress: a.player,
    args: { player: a.player, agentTokenId: a.agentTokenId.toString(), amount: toDecimalString(a.amount) },
  }),
  RewardGranted: (a) => ({
    playerAddress: a.player,
    args: { player: a.player, amount: toDecimalString(a.amount), category: a.category, reason: a.reason },
  }),
  DailyRewardClaimed: (a) => ({
    playerAddress: a.player,
    args: { player: a.player, amount: toDecimalString(a.amount), day: a.day.toString() },
  }),
  TournamentRewardGranted: (a) => ({
    playerAddress: a.player,
    args: { player: a.player, tournamentId: a.tournamentId.toString(), rank: a.rank.toString(), amount: toDecimalString(a.amount) },
  }),
  ReferralRewardGranted: (a) => ({
    playerAddress: a.referrer,
    args: { referrer: a.referrer, referee: a.referee, amount: toDecimalString(a.amount) },
  }),
};

const escrowMappers: Record<string, EventArgMapper> = {
  MatchCreated: (a) => ({
    playerAddress: a.playerA,
    args: { matchId: a.matchId, playerA: a.playerA, stakeAmount: toDecimalString(a.stakeAmount) },
  }),
  MatchJoined: (a) => ({
    playerAddress: a.playerB,
    args: { matchId: a.matchId, playerB: a.playerB, pool: toDecimalString(a.pool) },
  }),
  MatchStarted: (a) => ({
    playerAddress: null,
    args: { matchId: a.matchId },
  }),
  MatchSettled: (a) => ({
    playerAddress: a.winner,
    args: { matchId: a.matchId, winner: a.winner, payout: toDecimalString(a.payout), commission: toDecimalString(a.commission) },
  }),
  MatchCancelled: (a) => ({
    playerAddress: null,
    args: { matchId: a.matchId },
  }),
  CommissionCollected: (a) => ({
    playerAddress: null,
    args: { matchId: a.matchId, amount: toDecimalString(a.amount) },
  }),
};

const tournamentMappers: Record<string, EventArgMapper> = {
  CommissionCollected: (a) => ({
    playerAddress: null,
    args: { tournamentId: a.tournamentId.toString(), amount: toDecimalString(a.amount) },
  }),
  TournamentRewardGranted: (a) => ({
    playerAddress: a.player,
    args: { player: a.player, tournamentId: a.tournamentId.toString(), rank: a.rank.toString(), amount: toDecimalString(a.amount) },
  }),
};

const treasuryMappers: Record<string, EventArgMapper> = {
  TreasuryUpdated: (a) => ({
    playerAddress: null,
    args: { balance: toDecimalString(a.balance), totalRewardsPaid: toDecimalString(a.totalRewardsPaid), totalCommissions: toDecimalString(a.totalCommissions) },
  }),
  CommissionCollected: (a) => ({
    playerAddress: null,
    args: { spender: a.spender, amount: toDecimalString(a.amount) },
  }),
};

// Map contract event name -> OnChainEvent ArenaEventName enum value
const EVENT_NAME_MAP: Record<string, ArenaEventName> = {
  AgentRewardGranted: 'AGENT_REWARD_GRANTED',
  RewardGranted: 'REWARD_GRANTED',
  DailyRewardClaimed: 'DAILY_REWARD_CLAIMED',
  ReferralRewardGranted: 'REFERRAL_REWARD_GRANTED',
  TournamentRewardGranted: 'TOURNAMENT_REWARD_GRANTED',
  MatchCreated: 'MATCH_CREATED',
  MatchJoined: 'MATCH_JOINED',
  MatchStarted: 'MATCH_STARTED',
  MatchSettled: 'MATCH_SETTLED',
  MatchCancelled: 'MATCH_CANCELLED',
  CommissionCollected: 'COMMISSION_COLLECTED',
  TreasuryUpdated: 'TREASURY_UPDATED',
};

async function upsertOnChainEvent(params: {
  eventName: ArenaEventName;
  contractAddress: string;
  txHash: string;
  logIndex: number;
  blockNumber: bigint;
  playerAddress: string | null;
  args: Record<string, unknown>;
  occurredAt: Date;
}): Promise<void> {
  await prisma.onChainEvent.upsert({
    where: { txHash_logIndex: { txHash: params.txHash, logIndex: params.logIndex } },
    update: {},
    create: { ...params, args: params.args as Prisma.InputJsonValue },
  });
}

async function captureTreasurySnapshot(): Promise<void> {
  try {
    const treasury = arenaTreasuryRead();
    const [balance, totalRewardsPaid, totalCommissions] = await Promise.all([
      treasury.balance(),
      treasury.totalRewardsPaid(),
      treasury.totalCommissions(),
    ]);
    const balanceStr = toDecimalString(balance);
    const totalRewardsPaidStr = toDecimalString(totalRewardsPaid);
    const totalCommissionsStr = toDecimalString(totalCommissions);
    // circulatingSupply = INITIAL_SUPPLY (1,000,000) - treasury balance
    const circulating = 1_000_000 - Number(balanceStr);

    await prisma.treasurySnapshot.create({
      data: {
        balance: balanceStr,
        totalDistributed: totalRewardsPaidStr,
        totalCommissions: totalCommissionsStr,
        totalRewardsPaid: totalRewardsPaidStr,
        circulatingSupply: circulating.toString(),
      },
    });
  } catch (err) {
    console.warn('[indexer] Failed to capture treasury snapshot:', (err as Error).message);
  }
}

async function handleEvent(
  contract: ethers.Contract,
  eventName: string,
  mapper: EventArgMapper,
  payload: ethers.ContractEventPayload,
): Promise<void> {
  const log = payload.log;
  try {
    const mapped = mapper(payload.args);
    const block = await log.getBlock();

    await upsertOnChainEvent({
      eventName: EVENT_NAME_MAP[eventName],
      contractAddress: await contract.getAddress(),
      txHash: log.transactionHash,
      logIndex: log.index,
      blockNumber: BigInt(log.blockNumber),
      playerAddress: mapped.playerAddress,
      args: mapped.args,
      occurredAt: new Date(block.timestamp * 1000),
    });

    if (eventName === 'MatchSettled' || eventName === 'CommissionCollected' || eventName === 'TournamentRewardGranted') {
      await captureTreasurySnapshot();
    }
  } catch (err) {
    console.error(`[indexer] Failed to process ${eventName} log (tx ${log?.transactionHash}):`, (err as Error).message);
  }
}

export function startIndexer(): void {
  const addresses = contractAddresses();
  if (!addresses.rewardDistributor || !addresses.escrow || !addresses.tournament || !addresses.treasury) {
    console.warn('[indexer] One or more ARENA_*_ADDRESS env vars not set — indexer not started');
    return;
  }

  const rewardDistributor = rewardDistributorRead();
  const escrow = arenaEscrowRead();
  const tournament = arenaTournamentRead();
  const treasury = arenaTreasuryRead();

  for (const [eventName, mapper] of Object.entries(rewardDistributorMappers)) {
    rewardDistributor.on(eventName, (...args) => {
      const payload = args[args.length - 1] as ethers.ContractEventPayload;
      void handleEvent(rewardDistributor, eventName, mapper, payload);
    });
  }
  for (const [eventName, mapper] of Object.entries(escrowMappers)) {
    escrow.on(eventName, (...args) => {
      const payload = args[args.length - 1] as ethers.ContractEventPayload;
      void handleEvent(escrow, eventName, mapper, payload);
    });
  }
  for (const [eventName, mapper] of Object.entries(tournamentMappers)) {
    tournament.on(eventName, (...args) => {
      const payload = args[args.length - 1] as ethers.ContractEventPayload;
      void handleEvent(tournament, eventName, mapper, payload);
    });
  }
  for (const [eventName, mapper] of Object.entries(treasuryMappers)) {
    treasury.on(eventName, (...args) => {
      const payload = args[args.length - 1] as ethers.ContractEventPayload;
      void handleEvent(treasury, eventName, mapper, payload);
    });
  }

  console.log('[indexer] Listening for ARENA economy events on 0G Chain');

  // Safety-net snapshot every 15 minutes regardless of event-listener health.
  setInterval(() => { captureTreasurySnapshot().catch(() => {}); }, TREASURY_SNAPSHOT_INTERVAL_MS);
  // Capture one immediately on boot so the dashboard has data right away.
  captureTreasurySnapshot().catch(() => {});
}
