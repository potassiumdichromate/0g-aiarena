/**
 * Token Service — REST Routes
 *
 * Base path: /v1/token  (mounted in main.ts)
 *
 * Public (no auth):
 *   GET  /price               — current backing ratio
 *   GET  /reserve/snapshot    — full reserve state
 *   POST /deposit/preview     — how many $ARENA for X USDC
 *   POST /redeem/preview      — how much USDC for Y $ARENA
 *
 * Authenticated:
 *   GET  /balance/:address    — $ARENA balance + USD value
 *   POST /bridge/deposit      — record a pending bridge deposit (user-initiated)
 *   GET  /bridge/deposits     — list user's bridge deposits
 *   GET  /treasury/stats      — fee routing stats (admin)
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ReserveService }  from '../services/reserve.service';
import { TreasuryService } from '../services/treasury.service';
import { prisma }          from '@ai-arena/db-client';

const reserve  = new ReserveService();
const treasury = new TreasuryService();

// ── Schema helpers ────────────────────────────────────────────────────────────

const bigintReplacer = (_: string, v: unknown) =>
  typeof v === 'bigint' ? v.toString() : v;

function sendJson(reply: FastifyReply, data: unknown, status = 200) {
  return reply
    .status(status)
    .header('Content-Type', 'application/json')
    .send(JSON.stringify({ ok: true, data }, bigintReplacer));
}

function sendError(reply: FastifyReply, message: string, status = 400) {
  return reply.status(status).send({ ok: false, error: message });
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export async function tokenRoutes(app: FastifyInstance) {

  // ── GET /price ──────────────────────────────────────────────────────────────
  app.get('/price', async (_req: FastifyRequest, reply: FastifyReply) => {
    const snap = await reserve.getReserveSnapshot();
    return sendJson(reply, {
      backingRatio:     snap.backingRatioHuman,
      backingRatioBps:  snap.backingRatioBps,
      totalReserveUsdc: snap.totalReserveUsdc,
      totalReserveUsdt: snap.totalReserveUsdt,
      totalShares:      snap.totalShares,
      isPaused:         snap.isPaused,
    });
  });

  // ── GET /reserve/snapshot ───────────────────────────────────────────────────
  app.get('/reserve/snapshot', async (_req: FastifyRequest, reply: FastifyReply) => {
    const snap = await reserve.getReserveSnapshot();
    return sendJson(reply, snap);
  });

  // ── POST /deposit/preview ───────────────────────────────────────────────────
  app.post<{ Body: { usdcAmount: string } }>(
    '/deposit/preview',
    {
      schema: {
        body: {
          type: 'object',
          required: ['usdcAmount'],
          properties: { usdcAmount: { type: 'string' } },
        },
      },
    },
    async (req, reply) => {
      const raw = BigInt(req.body.usdcAmount);
      if (raw <= 0n) return sendError(reply, 'usdcAmount must be > 0');
      const preview = await reserve.previewDeposit(raw);
      return sendJson(reply, preview);
    },
  );

  // ── POST /redeem/preview ────────────────────────────────────────────────────
  app.post<{ Body: { arenaAmount: string } }>(
    '/redeem/preview',
    {
      schema: {
        body: {
          type: 'object',
          required: ['arenaAmount'],
          properties: { arenaAmount: { type: 'string' } },
        },
      },
    },
    async (req, reply) => {
      const raw = BigInt(req.body.arenaAmount);
      if (raw <= 0n) return sendError(reply, 'arenaAmount must be > 0');
      const preview = await reserve.previewRedeem(raw);
      return sendJson(reply, preview);
    },
  );

  // ── GET /balance/:address ───────────────────────────────────────────────────
  app.get<{ Params: { address: string } }>(
    '/balance/:address',
    async (req, reply) => {
      const { address } = req.params;
      if (!address || address.length < 32 || address.length > 44) {
        return sendError(reply, 'Invalid Solana address');
      }
      const bal = await reserve.getUserArenaBalance(address);
      return sendJson(reply, bal);
    },
  );

  // ── POST /bridge/deposit ────────────────────────────────────────────────────
  // Called by the client to pre-register a deposit *before* submitting on-chain.
  // The BridgeService's on-chain listener is the source of truth — this just
  // gives the user a record ID to poll.
  app.post<{
    Body: {
      userId:       string;
      sourceChain:  string;
      sourceTxHash: string;
      solanaAddress: string;
      usdcAmount:   string;
      depositId:    string;
    };
  }>(
    '/bridge/deposit',
    {
      schema: {
        body: {
          type: 'object',
          required: ['userId', 'sourceChain', 'sourceTxHash', 'solanaAddress', 'usdcAmount', 'depositId'],
          properties: {
            userId:        { type: 'string' },
            sourceChain:   { type: 'string', enum: ['base', '0g', 'solana'] },
            sourceTxHash:  { type: 'string' },
            solanaAddress: { type: 'string' },
            usdcAmount:    { type: 'string' },
            depositId:     { type: 'string' },
          },
        },
      },
    },
    async (req, reply) => {
      const { userId, sourceChain, sourceTxHash, solanaAddress, usdcAmount, depositId } = req.body;

      // Idempotency: return existing record if already registered
      const existing = await prisma.bridgeDeposit.findFirst({
        where: { sourceTxHash, sourceChain },
      });
      if (existing) {
        return sendJson(reply, { depositRecordId: existing.id, status: existing.status });
      }

      const record = await reserve.recordPendingBridgeDeposit({
        userId,
        sourceChain,
        sourceTxHash,
        solanaAddress,
        usdcAmount:  BigInt(usdcAmount),
        depositId:   BigInt(depositId),
      });

      return sendJson(reply, { depositRecordId: record, status: 'PENDING' }, 201);
    },
  );

  // ── GET /bridge/deposits ────────────────────────────────────────────────────
  app.get<{ Querystring: { solanaAddress?: string; userId?: string; limit?: string } }>(
    '/bridge/deposits',
    async (req, reply) => {
      const { solanaAddress, userId, limit } = req.query;
      if (!solanaAddress && !userId) {
        return sendError(reply, 'Provide solanaAddress or userId');
      }

      const deposits = await prisma.bridgeDeposit.findMany({
        where: {
          ...(solanaAddress ? { solanaAddress } : {}),
          ...(userId        ? { userId }        : {}),
        },
        orderBy: { createdAt: 'desc' },
        take:    Math.min(Number(limit ?? 20), 100),
      });

      return sendJson(reply, deposits);
    },
  );

  // ── GET /bridge/deposit/:id ─────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    '/bridge/deposit/:id',
    async (req, reply) => {
      const record = await prisma.bridgeDeposit.findUnique({
        where: { id: req.params.id },
      });
      if (!record) return sendError(reply, 'Not found', 404);
      return sendJson(reply, record);
    },
  );

  // ── GET /treasury/stats ─────────────────────────────────────────────────────
  app.get('/treasury/stats', async (_req, reply) => {
    const stats = await treasury.getTreasuryStats();
    return sendJson(reply, stats);
  });

  // ── GET /treasury/rebalance-history ────────────────────────────────────────
  app.get<{ Querystring: { limit?: string } }>(
    '/treasury/rebalance-history',
    async (req, reply) => {
      const history = await prisma.reserveRebalance.findMany({
        orderBy: { createdAt: 'desc' },
        take: Math.min(Number(req.query.limit ?? 20), 50),
      });
      return sendJson(reply, history);
    },
  );
}
