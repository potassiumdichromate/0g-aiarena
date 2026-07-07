/**
 * Arena Chain Service — the only relayer/signer for the $ARENA 0G Chain
 * economy.
 *
 * Holds the single relayer signer (ethers.Wallet from
 * ARENA_RELAYER_PRIVATE_KEY) for all 5 arena contracts (ArenaToken,
 * ArenaTreasury, RewardDistributor, ArenaEscrow, ArenaTournament) and is the
 * only service in the system that submits transactions to them. Every other
 * service calls this one over HTTP (X-Service-Key auth, same pattern as
 * inft-service) instead of holding its own key.
 *
 * Also runs a background indexer (src/indexer.ts) that mirrors contract
 * events into Postgres (OnChainEvent / TreasurySnapshot) so the read
 * endpoints below never have to hit the chain live for history.
 */

import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { ethers } from 'ethers';
import { prisma, ArenaEventName, Prisma } from '@ai-arena/db-client';
import {
  arenaTokenRead,
  arenaTreasuryRead,
  rewardDistributorWrite,
  arenaEscrowRead,
  arenaEscrowWrite,
  arenaTournamentRead,
  arenaTournamentWrite,
  hashMatchId,
  contractAddresses,
} from './contracts';
import { startIndexer } from './indexer';

const PORT = parseInt(process.env.PORT ?? '8050', 10);
const SERVICE_NAME = 'arena-chain-service';

function parseArena(amountArena: string | number): bigint {
  return ethers.parseEther(String(amountArena));
}

function formatArena(value: bigint): string {
  return ethers.formatEther(value);
}

/** Extract a clean revert reason from an ethers error for a clean API response. */
function revertReason(err: unknown): string {
  const e = err as { shortMessage?: string; reason?: string; message?: string };
  return e.shortMessage ?? e.reason ?? e.message ?? 'unknown error';
}

async function bootstrap(): Promise<void> {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: true });
  await app.register(helmet);

  // GET routes here are all read-only balance/treasury/explorer data — the same
  // information anyone could read directly off 0G chainscan, and the admin
  // Explorer/Treasury pages are meant to be reachable by whoever has the URL,
  // not gated behind app login. Only state-changing (POST) routes — the
  // reward/escrow/tournament actions that actually move funds — are
  // restricted to trusted internal callers via X-Service-Key.
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.routerPath === '/health') return;
    if (req.method === 'GET') return;
    const serviceKey = req.headers['x-service-key'];
    const internalSecret = process.env.INTERNAL_SERVICE_SECRET;
    if (internalSecret && serviceKey === internalSecret) return;
    reply.code(401).send({ error: 'Unauthorized' });
  });

  // ── Health ──────────────────────────────────────────────────────────────

  app.get('/health', async () => ({
    status: 'ok',
    service: SERVICE_NAME,
    rpc: process.env.ZEROG_RPC_URL ?? 'NOT_SET',
  }));

  // ── Config ──────────────────────────────────────────────────────────────
  // Contract addresses are public information (same as reading them off
  // chainscan) — the frontend needs these to know what to approve() before
  // staking into escrow/tournament, since that's the one step only the
  // player's own wallet can sign.

  app.get('/v1/arena/config', async () => {
    const addresses = contractAddresses();
    return {
      arenaTokenAddress: addresses.token,
      treasuryAddress: addresses.treasury,
      escrowAddress: addresses.escrow,
      tournamentAddress: addresses.tournament,
      rewardDistributorAddress: addresses.rewardDistributor,
    };
  });

  // ── Reward endpoints ────────────────────────────────────────────────────

  app.post<{ Body: { playerAddress: string; agentTokenId: string | number } }>(
    '/v1/arena/rewards/agent-mint',
    async (req, reply) => {
      const { playerAddress, agentTokenId } = req.body;
      try {
        const distributor = rewardDistributorWrite();
        const tx = await distributor.grantAgentMintReward(playerAddress, BigInt(agentTokenId));
        const receipt = await tx.wait();
        const amount: bigint = await distributor.agentMintReward();
        return reply.send({ txHash: receipt.hash, amountArena: formatArena(amount) });
      } catch (err) {
        return reply.code(400).send({ error: revertReason(err) });
      }
    },
  );

  app.post<{ Body: { playerAddress: string } }>(
    '/v1/arena/rewards/daily-login',
    async (req, reply) => {
      const { playerAddress } = req.body;
      try {
        const distributor = rewardDistributorWrite();
        const tx = await distributor.grantDailyLoginReward(playerAddress);
        const receipt = await tx.wait();
        const amount: bigint = await distributor.dailyLoginReward();
        return reply.send({ txHash: receipt.hash, amountArena: formatArena(amount) });
      } catch (err) {
        const reason = revertReason(err);
        if (reason.includes('already claimed today')) {
          return reply.code(409).send({ error: 'already claimed today' });
        }
        return reply.code(400).send({ error: reason });
      }
    },
  );

  app.post<{ Body: { referrerAddress: string; refereeAddress: string; amountArena: string } }>(
    '/v1/arena/rewards/referral',
    async (req, reply) => {
      const { referrerAddress, refereeAddress, amountArena } = req.body;
      try {
        const distributor = rewardDistributorWrite();
        const amount = parseArena(amountArena);
        const tx = await distributor.grantReferralReward(referrerAddress, refereeAddress, amount);
        const receipt = await tx.wait();
        return reply.send({ txHash: receipt.hash, amountArena });
      } catch (err) {
        return reply.code(400).send({ error: revertReason(err) });
      }
    },
  );

  app.post<{ Body: { playerAddress: string; amountArena: string; reason: string } }>(
    '/v1/arena/rewards/training',
    async (req, reply) => {
      const { playerAddress, amountArena, reason } = req.body;
      try {
        const distributor = rewardDistributorWrite();
        const amount = parseArena(amountArena);
        const tx = await distributor.grantTrainingReward(playerAddress, amount, reason ?? '');
        const receipt = await tx.wait();
        return reply.send({ txHash: receipt.hash, amountArena });
      } catch (err) {
        return reply.code(400).send({ error: revertReason(err) });
      }
    },
  );

  app.post<{ Body: { playerAddress: string; amountArena: string; reason: string } }>(
    '/v1/arena/rewards/quest',
    async (req, reply) => {
      const { playerAddress, amountArena, reason } = req.body;
      try {
        const distributor = rewardDistributorWrite();
        const amount = parseArena(amountArena);
        const tx = await distributor.grantQuestReward(playerAddress, amount, reason ?? '');
        const receipt = await tx.wait();
        return reply.send({ txHash: receipt.hash, amountArena });
      } catch (err) {
        return reply.code(400).send({ error: revertReason(err) });
      }
    },
  );

  app.post<{ Body: { playerAddress: string; amountArena: string; reason: string } }>(
    '/v1/arena/rewards/seasonal',
    async (req, reply) => {
      const { playerAddress, amountArena, reason } = req.body;
      try {
        const distributor = rewardDistributorWrite();
        const amount = parseArena(amountArena);
        const tx = await distributor.grantSeasonalReward(playerAddress, amount, reason ?? '');
        const receipt = await tx.wait();
        return reply.send({ txHash: receipt.hash, amountArena });
      } catch (err) {
        return reply.code(400).send({ error: revertReason(err) });
      }
    },
  );

  app.post<{ Body: { playerAddress: string; tournamentId: string | number; rank: number; amountArena: string } }>(
    '/v1/arena/rewards/tournament-bonus',
    async (req, reply) => {
      const { playerAddress, tournamentId, rank, amountArena } = req.body;
      try {
        const distributor = rewardDistributorWrite();
        const amount = parseArena(amountArena);
        const tx = await distributor.grantTournamentReward(playerAddress, BigInt(tournamentId), BigInt(rank), amount);
        const receipt = await tx.wait();
        return reply.send({ txHash: receipt.hash, amountArena });
      } catch (err) {
        return reply.code(400).send({ error: revertReason(err) });
      }
    },
  );

  // ── Escrow endpoints (1v1 wager) ────────────────────────────────────────
  //
  // IMPORTANT: before create/join, each player must have approved the
  // ArenaEscrow contract to spend their ARENA (ERC20 approve). This service
  // holds only the relayer key — it can never sign as a player, and
  // `approve()` can only ever be authorized by the token owner's own wallet.
  // So the ONE step in this entire system a player's own wallet must sign is
  // the escrow/tournament approve() transaction; every other on-chain action
  // (create/join/start/settle, reward grants, etc.) is relayer-submitted.
  // The frontend should use GET /v1/arena/wallet/:address/allowance/:spender
  // to check whether that approve() is still needed before calling
  // create/join here.

  app.post<{ Body: { matchId: string; playerAAddress: string; stakeAmountArena: string } }>(
    '/v1/arena/escrow/create',
    async (req, reply) => {
      const { matchId, playerAAddress, stakeAmountArena } = req.body;
      try {
        const escrow = arenaEscrowWrite();
        const idHash = hashMatchId(matchId);
        const stake = parseArena(stakeAmountArena);
        const tx = await escrow.createMatch(idHash, playerAAddress, stake);
        const receipt = await tx.wait();
        return reply.send({ txHash: receipt.hash, matchId });
      } catch (err) {
        return reply.code(400).send({ error: revertReason(err) });
      }
    },
  );

  app.post<{ Body: { matchId: string; playerBAddress: string } }>(
    '/v1/arena/escrow/join',
    async (req, reply) => {
      const { matchId, playerBAddress } = req.body;
      try {
        const escrow = arenaEscrowWrite();
        const idHash = hashMatchId(matchId);
        const tx = await escrow.joinMatch(idHash, playerBAddress);
        const receipt = await tx.wait();
        return reply.send({ txHash: receipt.hash, matchId });
      } catch (err) {
        return reply.code(400).send({ error: revertReason(err) });
      }
    },
  );

  app.post<{ Body: { matchId: string } }>(
    '/v1/arena/escrow/start',
    async (req, reply) => {
      const { matchId } = req.body;
      try {
        const escrow = arenaEscrowWrite();
        const idHash = hashMatchId(matchId);
        const tx = await escrow.startMatch(idHash);
        const receipt = await tx.wait();
        return reply.send({ txHash: receipt.hash, matchId });
      } catch (err) {
        return reply.code(400).send({ error: revertReason(err) });
      }
    },
  );

  app.post<{ Body: { matchId: string; winnerAddress: string } }>(
    '/v1/arena/escrow/settle',
    async (req, reply) => {
      const { matchId, winnerAddress } = req.body;
      try {
        const escrow = arenaEscrowWrite();
        const idHash = hashMatchId(matchId);
        const tx = await escrow.settleMatch(idHash, winnerAddress);
        const receipt = await tx.wait();
        return reply.send({ txHash: receipt.hash, matchId, winnerAddress });
      } catch (err) {
        return reply.code(400).send({ error: revertReason(err) });
      }
    },
  );

  app.post<{ Body: { matchId: string } }>(
    '/v1/arena/escrow/cancel',
    async (req, reply) => {
      const { matchId } = req.body;
      try {
        const escrow = arenaEscrowWrite();
        const idHash = hashMatchId(matchId);
        const tx = await escrow.cancelMatch(idHash);
        const receipt = await tx.wait();
        return reply.send({ txHash: receipt.hash, matchId });
      } catch (err) {
        return reply.code(400).send({ error: revertReason(err) });
      }
    },
  );

  const MATCH_STATE_NAMES = ['NONE', 'CREATED', 'JOINED', 'STARTED', 'SETTLED', 'CANCELLED'] as const;

  app.get<{ Params: { matchId: string } }>('/v1/arena/escrow/:matchId', async (req, reply) => {
    try {
      const escrow = arenaEscrowRead();
      const idHash = hashMatchId(req.params.matchId);
      const m = await escrow.getMatch(idHash);
      return reply.send({
        matchId: req.params.matchId,
        playerA: m.playerA,
        playerB: m.playerB,
        stakeAmountArena: formatArena(m.stakeAmount),
        state: MATCH_STATE_NAMES[Number(m.state)] ?? 'UNKNOWN',
      });
    } catch (err) {
      return reply.code(400).send({ error: revertReason(err) });
    }
  });

  // ── Allowance check (player must self-sign approve()) ──────────────────

  app.get<{ Params: { address: string; spender: string } }>(
    '/v1/arena/wallet/:address/allowance/:spender',
    async (req, reply) => {
      try {
        const token = arenaTokenRead();
        const allowance: bigint = await token.allowance(req.params.address, req.params.spender);
        return reply.send({
          address: req.params.address,
          spender: req.params.spender,
          allowanceArena: formatArena(allowance),
        });
      } catch (err) {
        return reply.code(400).send({ error: revertReason(err) });
      }
    },
  );

  // ── Tournament endpoints ─────────────────────────────────────────────────

  app.post<{ Body: { tournamentId: string | number; entryFeeArena: string; maxParticipants: number } }>(
    '/v1/arena/tournament/create',
    async (req, reply) => {
      const { tournamentId, entryFeeArena, maxParticipants } = req.body;
      try {
        const tournament = arenaTournamentWrite();
        const entryFee = parseArena(entryFeeArena);
        const tx = await tournament.createTournament(BigInt(tournamentId), entryFee, BigInt(maxParticipants));
        const receipt = await tx.wait();
        return reply.send({ txHash: receipt.hash, tournamentId: String(tournamentId) });
      } catch (err) {
        return reply.code(400).send({ error: revertReason(err) });
      }
    },
  );

  app.post<{ Body: { tournamentId: string | number; playerAddress: string } }>(
    '/v1/arena/tournament/enter',
    async (req, reply) => {
      const { tournamentId, playerAddress } = req.body;
      try {
        const tournament = arenaTournamentWrite();
        const tx = await tournament.enterTournament(BigInt(tournamentId), playerAddress);
        const receipt = await tx.wait();
        return reply.send({ txHash: receipt.hash, tournamentId: String(tournamentId) });
      } catch (err) {
        return reply.code(400).send({ error: revertReason(err) });
      }
    },
  );

  app.post<{ Body: { tournamentId: string | number } }>(
    '/v1/arena/tournament/start',
    async (req, reply) => {
      const { tournamentId } = req.body;
      try {
        const tournament = arenaTournamentWrite();
        const tx = await tournament.startTournament(BigInt(tournamentId));
        const receipt = await tx.wait();
        return reply.send({ txHash: receipt.hash, tournamentId: String(tournamentId) });
      } catch (err) {
        return reply.code(400).send({ error: revertReason(err) });
      }
    },
  );

  app.post<{ Body: { tournamentId: string | number; winners: string[]; prizeBps: number[] } }>(
    '/v1/arena/tournament/settle',
    async (req, reply) => {
      const { tournamentId, winners, prizeBps } = req.body;
      try {
        const tournament = arenaTournamentWrite();
        const tx = await tournament.settleTournament(BigInt(tournamentId), winners, prizeBps.map(BigInt));
        const receipt = await tx.wait();
        return reply.send({ txHash: receipt.hash, tournamentId: String(tournamentId) });
      } catch (err) {
        return reply.code(400).send({ error: revertReason(err) });
      }
    },
  );

  app.post<{ Body: { tournamentId: string | number } }>(
    '/v1/arena/tournament/cancel',
    async (req, reply) => {
      const { tournamentId } = req.body;
      try {
        const tournament = arenaTournamentWrite();
        const tx = await tournament.cancelTournament(BigInt(tournamentId));
        const receipt = await tx.wait();
        return reply.send({ txHash: receipt.hash, tournamentId: String(tournamentId) });
      } catch (err) {
        return reply.code(400).send({ error: revertReason(err) });
      }
    },
  );

  const TOURNAMENT_STATE_NAMES = ['NONE', 'OPEN', 'STARTED', 'SETTLED', 'CANCELLED'] as const;

  app.get<{ Params: { tournamentId: string } }>('/v1/arena/tournament/:tournamentId', async (req, reply) => {
    try {
      const tournament = arenaTournamentRead();
      const id = BigInt(req.params.tournamentId);
      const [info, participants] = await Promise.all([
        tournament.tournaments(id),
        tournament.getParticipants(id),
      ]);
      return reply.send({
        tournamentId: req.params.tournamentId,
        entryFeeArena: formatArena(info.entryFee),
        maxParticipants: Number(info.maxParticipants),
        state: TOURNAMENT_STATE_NAMES[Number(info.state)] ?? 'UNKNOWN',
        participants,
      });
    } catch (err) {
      return reply.code(400).send({ error: revertReason(err) });
    }
  });

  // ── Read endpoints ───────────────────────────────────────────────────────

  app.get<{ Params: { address: string } }>('/v1/arena/wallet/:address', async (req, reply) => {
    try {
      const token = arenaTokenRead();
      const balance: bigint = await token.balanceOf(req.params.address);
      return reply.send({ address: req.params.address, balanceArena: formatArena(balance) });
    } catch (err) {
      return reply.code(400).send({ error: revertReason(err) });
    }
  });

  app.get('/v1/arena/treasury', async (_req, reply) => {
    try {
      const treasury = arenaTreasuryRead();
      const [balance, distributed, remaining, totalCommissions, totalRewardsPaid] = await Promise.all([
        treasury.balance(),
        treasury.distributed(),
        treasury.remaining(),
        treasury.totalCommissions(),
        treasury.totalRewardsPaid(),
      ]);
      return reply.send({
        balance: formatArena(balance),
        distributed: formatArena(distributed),
        remaining: formatArena(remaining),
        totalCommissions: formatArena(totalCommissions),
        totalRewardsPaid: formatArena(totalRewardsPaid),
      });
    } catch (err) {
      return reply.code(400).send({ error: revertReason(err) });
    }
  });

  app.get<{ Params: { address: string }; Querystring: { page?: string; limit?: string } }>(
    '/v1/arena/transactions/:address',
    async (req, reply) => {
      const page = Math.max(1, parseInt(req.query.page ?? '1', 10));
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit ?? '20', 10)));

      const [rows, total] = await Promise.all([
        prisma.onChainEvent.findMany({
          where: { playerAddress: req.params.address },
          orderBy: { occurredAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.onChainEvent.count({ where: { playerAddress: req.params.address } }),
      ]);

      return reply.send({ transactions: rows, page, limit, total });
    },
  );

  app.get<{ Querystring: { eventName?: string; page?: string; limit?: string } }>(
    '/v1/arena/explorer/events',
    async (req, reply) => {
      const page = Math.max(1, parseInt(req.query.page ?? '1', 10));
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit ?? '20', 10)));
      const where: Prisma.OnChainEventWhereInput = {};
      if (req.query.eventName) {
        where.eventName = req.query.eventName as ArenaEventName;
      }

      const [rows, total] = await Promise.all([
        prisma.onChainEvent.findMany({
          where,
          orderBy: { occurredAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
        }),
        prisma.onChainEvent.count({ where }),
      ]);

      return reply.send({ events: rows, page, limit, total });
    },
  );

  app.get<{ Querystring: { limit?: string } }>('/v1/arena/explorer/treasury-history', async (req, reply) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit ?? '50', 10)));
    const rows = await prisma.treasurySnapshot.findMany({
      orderBy: { capturedAt: 'desc' },
      take: limit,
    });
    return reply.send({ snapshots: rows });
  });

  startIndexer();

  await app.listen({ port: PORT, host: '0.0.0.0' });
  app.log.info(`${SERVICE_NAME} running on port ${PORT}`);
}

bootstrap().catch((err) => { console.error(err); process.exit(1); });
