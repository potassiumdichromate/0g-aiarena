/**
 * EscrowService — 1v1 wager and League Battle escrow, now backed by the
 * on-chain ArenaEscrow contract (see contracts/evm/contracts/arena/ArenaEscrow.sol)
 * instead of Postgres fund math. financial-service's job here is to be the
 * caller that talks to arena-chain-service (the only relayer/signer for the
 * $ARENA 0G Chain economy) rather than writing settlement math into Postgres.
 *
 * Flow (mirrors ArenaEscrow.sol exactly, driven through arena-chain-service):
 *   1. lockEscrow(agentId1, agentId2, stakeAmount, battleId)
 *      → resolves each agent's owner wallet address
 *      → arena-chain-service: createMatch (playerA stakes) + joinMatch (playerB stakes) + startMatch
 *
 *   2. settleEscrow(battleId, winnerId)
 *      → arena-chain-service: settleMatch(winner) — on-chain 90/10 split,
 *        commission routed to ArenaTreasury automatically by the contract.
 *
 * `EscrowRecord` rows are still written (state/idempotency bookkeeping only,
 * e.g. `LeagueBattle.escrowId` needs a row to point at) but are no longer the
 * source of truth for fund movement — `OnChainEvent` is. Balances are no
 * longer read from or written to `AgentWallet.balanceArena` / `LedgerEntry`
 * for wager/League settlement; a player's real balance now lives on-chain
 * (query via GET /v1/arena/wallet/:address on arena-chain-service).
 *
 * IMPORTANT: before create/join, each player must have approved the
 * ArenaEscrow contract to spend their ARENA from their own wallet — this
 * service (like arena-chain-service) never signs on a player's behalf.
 * arena-chain-service's create/join calls will revert if the player hasn't
 * approved yet; that surfaces here as an ArenaChainError.
 */

import { prisma, FinancialRepository, LeagueRepository } from '@ai-arena/db-client';
import { getEventBus } from '@ai-arena/event-bus';
import { arenaChain, ArenaChainError } from './arena-chain.client';

const finRepo = new FinancialRepository(prisma);
const leagueRepo = new LeagueRepository(prisma);

export const COMMISSION_RATE = 0.10; // mirrors ArenaEscrow.commissionBps default (1000 = 10%)

/** Resolves an agent's owner wallet address (User.walletAddress) — the address that stakes/receives ARENA on-chain. */
async function resolveOwnerWalletAddress(agentId: string): Promise<string> {
  const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { userId: true } });
  if (!agent) throw new Error(`Agent ${agentId} not found`);
  const user = await prisma.user.findUnique({ where: { id: agent.userId }, select: { walletAddress: true } });
  if (!user?.walletAddress) throw new Error(`No walletAddress for owner of agent ${agentId}`);
  return user.walletAddress;
}

export class EscrowService {

  // ── Lock (ad-hoc wager) ──────────────────────────────────────────────────

  async lockEscrow(
    agentId1:    string,
    agentId2:    string,
    stakeAmount: number,   // per-agent stake (e.g. 5 ARENA each)
    battleId:    string,
  ): Promise<{ escrowId: string; totalPool: number }> {
    const existing = await prisma.escrowRecord.findFirst({ where: { battleId, state: 'LOCKED' } });
    if (existing) return { escrowId: existing.id, totalPool: stakeAmount * 2 };

    const [playerA, playerB] = await Promise.all([
      resolveOwnerWalletAddress(agentId1),
      resolveOwnerWalletAddress(agentId2),
    ]);

    const stakeStr = String(stakeAmount);
    await arenaChain.createMatch(battleId, playerA, stakeStr);
    await arenaChain.joinMatch(battleId, playerB);
    await arenaChain.startMatch(battleId);

    const escrow = await prisma.escrowRecord.create({
      data: {
        battleId,
        agentIds:      [agentId1, agentId2],
        amounts:       { [agentId1]: stakeAmount, [agentId2]: stakeAmount },
        solanaAddress: `onchain_escrow_${battleId}`, // legacy column name — now just a marker this is on-chain-backed
        state:         'LOCKED',
      },
    });

    console.log(`[EscrowService] On-chain match created+joined+started for battle ${battleId}: ${playerA} vs ${playerB}, stake ${stakeAmount} ARENA each`);

    return { escrowId: escrow.id, totalPool: stakeAmount * 2 };
  }

  // ── Settle (ad-hoc wager) ────────────────────────────────────────────────

  async settleEscrow(
    battleId: string,
    winnerId: string,
  ): Promise<{ winnerId: string; winnerPayout: number; commission: number }> {
    const escrow = await prisma.escrowRecord.findFirst({
      where: { battleId, state: 'LOCKED' },
    });

    if (!escrow) {
      // No escrow = not a wager battle, silently skip
      console.log(`[EscrowService] No locked escrow for battle ${battleId} — skipping settlement`);
      return { winnerId, winnerPayout: 0, commission: 0 };
    }

    const amounts = escrow.amounts as Record<string, number>;
    const totalPool = Object.values(amounts).reduce((sum, v) => sum + v, 0);
    const commission   = parseFloat((totalPool * COMMISSION_RATE).toFixed(6));
    const winnerPayout = parseFloat((totalPool - commission).toFixed(6));

    const winnerAddress = await resolveOwnerWalletAddress(winnerId);

    let txHash: string | null = null;
    try {
      const result = await arenaChain.settleMatch(battleId, winnerAddress);
      txHash = result.txHash;
    } catch (err) {
      if (err instanceof ArenaChainError) {
        console.error(`[EscrowService] On-chain settle failed for battle ${battleId}:`, err.message);
      }
      throw err;
    }

    await prisma.escrowRecord.update({
      where: { id: escrow.id },
      data: {
        state:     'SETTLED',
        winnerId,
        settledAt: new Date(),
        txHashes:  { settlement: txHash ?? `settle_${battleId}_${Date.now()}` },
      },
    });

    try {
      const bus = await getEventBus();
      await bus.publish('financial.escrow.settled', {
        battleId,
        escrowId:    escrow.id,
        winnerId,
        winnerPayout,
        commission,
        totalPool,
        txHash,
        occurredAt:  new Date(),
      });
    } catch { /* NATS optional */ }

    console.log(`[EscrowService] Settled battle ${battleId} on-chain: winner ${winnerId} (${winnerAddress}) receives ${winnerPayout} ARENA, commission ${commission} ARENA, tx ${txHash}`);

    return { winnerId, winnerPayout, commission };
  }

  // ── League: Lock ─────────────────────────────────────────────────────────

  /**
   * §9.2 — locks `LeagueBattle.stakeArena` from both the challenger and
   * opponent's on-chain wallets via ArenaEscrow (createMatch/joinMatch/
   * startMatch), creates an `EscrowRecord` (state LOCKED, linked via
   * `leagueBattleId`), and transitions the battle PENDING -> LOCKED.
   * Idempotent: a battle already LOCKED returns its existing `escrowId`
   * rather than locking funds twice.
   */
  async lockLeagueEscrow(battleId: string): Promise<{ escrowId: string }> {
    const battle = await prisma.leagueBattle.findUnique({ where: { id: battleId } });
    if (!battle) throw new Error(`League battle ${battleId} not found`);

    if (battle.status === 'LOCKED' && battle.escrowId) {
      return { escrowId: battle.escrowId };
    }
    if (battle.status !== 'PENDING') {
      throw new Error(`League battle ${battleId} is not PENDING (status=${battle.status})`);
    }

    const stake = battle.stakeArena;
    const [challengerAddress, opponentAddress] = await Promise.all([
      resolveOwnerWalletAddress(battle.challengerId),
      resolveOwnerWalletAddress(battle.opponentId),
    ]);

    const stakeStr = String(stake);
    await arenaChain.createMatch(battleId, challengerAddress, stakeStr);
    await arenaChain.joinMatch(battleId, opponentAddress);
    await arenaChain.startMatch(battleId);

    const escrow = await prisma.escrowRecord.create({
      data: {
        battleId,
        agentIds:       [battle.challengerId, battle.opponentId],
        amounts:        { [battle.challengerId]: stake, [battle.opponentId]: stake },
        solanaAddress:  `onchain_escrow_league_${battleId}`,
        state:          'LOCKED',
        leagueBattleId: battle.id,
      },
    });

    await leagueRepo.transitionBattleStatus(battle.id, 'PENDING', 'LOCKED', {
      escrow:     { connect: { id: escrow.id } },
      acceptedAt: new Date(),
    });

    console.log(`[EscrowService] League escrow locked on-chain: battle ${battleId}, ${stake} ARENA each, escrow ${escrow.id}`);
    return { escrowId: escrow.id };
  }

  // ── League: Settle ───────────────────────────────────────────────────────

  /**
   * §9.3/§9.4 — settles a LOCKED League Battle escrow via ArenaEscrow.
   *   winnerId set  -> on-chain settleMatch(winner): winner receives 90% of
   *                    the pool, 10% commission routed to ArenaTreasury by
   *                    the contract itself.
   *   winnerId null -> on-chain cancelMatch: both stakes refunded in full
   *                    (tie or the match was cancelled).
   * Idempotent: a battle already SETTLED/VOID, or an escrow already
   * SETTLED/CANCELLED, is a no-op.
   */
  async settleLeagueBattle(battleId: string, winnerId: string | null): Promise<void> {
    const battle = await prisma.leagueBattle.findUnique({ where: { id: battleId } });
    if (!battle) throw new Error(`League battle ${battleId} not found`);

    if (battle.status === 'SETTLED' || battle.status === 'VOID') return;
    if (battle.status !== 'LOCKED' || !battle.escrowId) {
      throw new Error(`League battle ${battleId} is not LOCKED (status=${battle.status})`);
    }

    const escrow = await prisma.escrowRecord.findUnique({ where: { id: battle.escrowId } });
    if (!escrow) throw new Error(`Escrow ${battle.escrowId} not found for battle ${battleId}`);
    if (escrow.state === 'SETTLED' || escrow.state === 'CANCELLED') return;
    if (escrow.state !== 'LOCKED') {
      throw new Error(`Escrow ${escrow.id} is not LOCKED (state=${escrow.state})`);
    }

    const now = new Date();

    if (winnerId) {
      const winnerAddress = await resolveOwnerWalletAddress(winnerId);
      const { txHash } = await arenaChain.settleMatch(battleId, winnerAddress);

      await prisma.escrowRecord.update({
        where: { id: escrow.id },
        data:  { state: 'SETTLED', winnerId, settledAt: now, txHashes: { settlement: txHash } },
      });

      await leagueRepo.transitionBattleStatus(battle.id, 'LOCKED', 'SETTLED', { winnerId, settledAt: now });

      console.log(`[EscrowService] League battle ${battleId} settled on-chain: winner ${winnerId} (${winnerAddress}), tx ${txHash}`);
    } else {
      const { txHash } = await arenaChain.cancelMatch(battleId);

      await prisma.escrowRecord.update({
        where: { id: escrow.id },
        data:  { state: 'CANCELLED', settledAt: now, txHashes: { cancellation: txHash } },
      });

      await leagueRepo.transitionBattleStatus(battle.id, 'LOCKED', 'VOID', { settledAt: now });

      console.log(`[EscrowService] League battle ${battleId} voided on-chain (refund), tx ${txHash}`);
    }
  }

  // ── League: Prediction reward ───────────────────────────────────────────
  //
  // §5.6/§10.2 step 4 — grants the on-chain "TRAINING"-category ARENA reward
  // for a settled League prediction via arena-chain-service instead of
  // crediting AgentWallet.balanceArena in Postgres. Idempotency now lives at
  // the arena-chain-service/on-chain layer's caller (league-worker still
  // guards on `(predictionId, LEAGUE_PREDICTION_REWARD)` via its own
  // settlement log — see services/league-worker/src/lib/settlement.ts).

  async creditLeaguePrediction(
    agentId:      string,
    predictionId: string,
    amount:       number,
    metadata:     Record<string, unknown>,
  ): Promise<void> {
    const playerAddress = await resolveOwnerWalletAddress(agentId);
    const reason = `LEAGUE_PREDICTION:${predictionId}`;
    await arenaChain.grantTrainingReward(playerAddress, String(amount), reason);
    console.log(`[EscrowService] League prediction reward granted on-chain: ${amount} ARENA to ${playerAddress} (prediction ${predictionId})`, metadata);
  }

  // ── x402 Auto-Pay (custodial wallet) ─────────────────────────────────────
  //
  // Left on the old off-chain Postgres path — x402 is a distinct
  // pay-per-request compute-fee mechanism (training/inference/clone fees),
  // not part of the wager/League escrow-settlement rewiring in this pass.

  async initiateX402Payment(
    agentId: string,
    amount:  number,
    purpose: string,
  ): Promise<{ txHash: string }> {
    const wallet = await finRepo.getWallet(agentId);
    if (!wallet)        throw new Error('Wallet not found');
    if (wallet.isFrozen) throw new Error('Wallet is frozen');
    if (wallet.balanceArena < amount) {
      throw new Error(`Insufficient ARENA balance (need ${amount}, have ${wallet.balanceArena})`);
    }

    await finRepo.updateBalance(agentId, -amount, 0);

    const txHash = `x402_internal_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    await finRepo.createLedgerEntry({
      wallet:   { connect: { id: wallet.id } },
      type:     'BATTLE_WAGER',
      amount,
      currency: 'ARENA',
      status:   'CONFIRMED',
      txHash,
      metadata: { x402_prepaid: true, x402_used: false, purpose } as any,
    });

    console.log(`[EscrowService] x402 pre-paid: agent ${agentId}, ${amount} ARENA, purpose=${purpose}, tx=${txHash}`);
    return { txHash };
  }

  // ── x402 Payment Verification ──────────────────────────────────────────────

  async verifyX402Payment(
    txHash:         string,
    agentId:        string,
    expectedAmount: number,
  ): Promise<{ valid: boolean; reason?: string }> {
    const wallet = await finRepo.getWallet(agentId);
    if (!wallet) return { valid: false, reason: 'Wallet not found' };

    const prePaid = await prisma.ledgerEntry.findFirst({
      where: {
        walletId: wallet.id,
        txHash,
        metadata: { path: ['x402_prepaid'], equals: true },
      },
    });

    if (prePaid) {
      const meta = prePaid.metadata as Record<string, unknown>;
      if (meta.x402_used) return { valid: false, reason: 'Payment already used' };
      if ((prePaid.amount as number) < expectedAmount) {
        return { valid: false, reason: `Pre-paid amount ${prePaid.amount} < required ${expectedAmount}` };
      }
      return { valid: true };
    }

    const existing = await prisma.ledgerEntry.findFirst({
      where: {
        walletId: wallet.id,
        txHash,
        metadata: { path: ['x402'], equals: true },
      },
    });
    if (existing) return { valid: false, reason: 'Payment already used' };

    if (wallet.balanceArena < expectedAmount) {
      return { valid: false, reason: `Insufficient balance (need ${expectedAmount}, have ${wallet.balanceArena})` };
    }

    return { valid: true };
  }

  // ── Charge x402 ───────────────────────────────────────────────────────────

  async chargeX402(
    txHash:   string,
    agentId:  string,
    amount:   number,
    purpose:  string,
  ): Promise<void> {
    const wallet = await finRepo.getWallet(agentId);
    if (!wallet) throw new Error('Wallet not found');

    const prePaid = await prisma.ledgerEntry.findFirst({
      where: {
        walletId: wallet.id,
        txHash,
        metadata: { path: ['x402_prepaid'], equals: true },
      },
    });

    if (prePaid) {
      await prisma.ledgerEntry.update({
        where: { id: prePaid.id },
        data:  { metadata: { ...(prePaid.metadata as object), x402_used: true } },
      });
      return;
    }

    await finRepo.updateBalance(agentId, -amount, 0);
    await finRepo.createLedgerEntry({
      wallet:   { connect: { id: wallet.id } },
      type:     'BATTLE_WAGER',
      amount,
      currency: 'ARENA',
      status:   'CONFIRMED',
      txHash,
      metadata: { x402: true, purpose } as any,
    });
  }
}
