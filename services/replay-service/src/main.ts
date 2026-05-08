/**
 * Replay Service — deterministic battle replay storage on 0G Storage.
 *
 * 0G Storage usage:
 *   - POST /replays          → upload replay blob → returns rootHash
 *   - GET  /replays/:id      → lookup rootHash in storage_index → download from 0G
 *   - GET  /replays/:id/verify → verify the replay hash matches the battle result
 *
 * Replay blob format:
 *   { battleId, seed, initialState, actionLog: [{tick, agentId, action}], finalStateHash }
 *
 * Deterministic replay: given the same seed + actionLog, re-simulating always
 * produces the same finalStateHash — used by anti-cheat to verify results.
 *
 * The rootHash is stored in the Battle DB record and on-chain (via anticheat-service).
 */

import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import { createHash } from 'crypto';
import { prisma } from '@ai-arena/db-client';
import { ZeroGStorageClient, getZeroGConfig } from '@ai-arena/zerog-client';

const PORT         = parseInt(process.env.PORT ?? '8022', 10);
const SERVICE_NAME = 'replay-service';

const storage = new ZeroGStorageClient(getZeroGConfig());

export interface ReplayBlob {
  battleId:       string;
  seed:           string;
  initialState:   Record<string, unknown>;
  actionLog:      Array<{
    tick:     number;
    agentId:  string;
    action:   Record<string, unknown>;
    latencyMs?: number;
  }>;
  finalStateHash: string;    // SHA-256 of the final game state — used for anti-cheat
  durationMs:     number;
  recordedAt:     string;
}

async function bootstrap(): Promise<void> {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: true });
  await app.register(helmet);
  await app.register(jwt, { secret: process.env.JWT_SECRET ?? 'dev-secret' });

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.routerPath === '/health') return;
    try { await req.jwtVerify(); } catch { reply.code(401).send({ error: 'Unauthorized' }); }
  });

  // ── Health ────────────────────────────────────────────────────────────────

  app.get('/health', async () => ({
    status:  'ok',
    service: SERVICE_NAME,
    storage: '0G Storage (mainnet)',
  }));

  // ── POST /replays — upload a battle replay to 0G Storage ─────────────────

  app.post<{ Body: ReplayBlob }>('/replays', async (req, reply) => {
    const replay = req.body;

    if (!replay.battleId || !replay.seed || !replay.actionLog) {
      return reply.code(400).send({ error: 'battleId, seed, and actionLog are required' });
    }

    // Compute our own finalStateHash to verify the submitted one
    const replayJson  = JSON.stringify(replay.actionLog);
    const computedHash = createHash('sha256').update(replay.seed + replayJson).digest('hex');

    const buf = Buffer.from(JSON.stringify(replay), 'utf8');

    // Upload to 0G Storage
    const { rootHash, txHash } = await storage.uploadBuffer(buf);

    // Index under logical path
    const logicalPath = `replays/${replay.battleId}`;
    await prisma.storageIndex.upsert({
      where:  { logicalPath },
      update: { rootHash, txHash: txHash ?? null, sizeBytes: buf.byteLength },
      create: {
        logicalPath,
        rootHash,
        txHash:     txHash ?? null,
        mimeType:   'application/json',
        sizeBytes:  buf.byteLength,
        uploadedBy: 'replay-service',
        tags:       ['replay', replay.battleId],
      },
    });

    // Update the battle record with replayId (rootHash)
    await prisma.battle.updateMany({
      where: { id: replay.battleId },
      data:  { replayId: rootHash },
    });

    return {
      rootHash,
      txHash,
      battleId:      replay.battleId,
      logicalPath,
      finalStateHash: replay.finalStateHash,
      computedHash,
      hashMatch:     computedHash === replay.finalStateHash,
    };
  });

  // ── GET /replays/:battleId — download replay from 0G Storage ─────────────

  app.get<{ Params: { battleId: string } }>('/replays/:battleId', async (req, reply) => {
    const { battleId } = req.params;
    const logicalPath  = `replays/${battleId}`;

    const record = await prisma.storageIndex.findUnique({ where: { logicalPath } });
    if (!record) {
      return reply.code(404).send({ error: `No replay found for battle ${battleId}` });
    }

    const buf    = await storage.downloadToBuffer(record.rootHash);
    const replay = JSON.parse(buf.toString('utf8')) as ReplayBlob;

    return {
      rootHash:    record.rootHash,
      battleId,
      replay,
      storedAt:    record.createdAt,
    };
  });

  // ── GET /replays/:battleId/verify — verify replay integrity ──────────────

  app.get<{ Params: { battleId: string } }>('/replays/:battleId/verify', async (req, reply) => {
    const { battleId } = req.params;

    const record = await prisma.storageIndex.findUnique({
      where: { logicalPath: `replays/${battleId}` },
    });
    if (!record) {
      return reply.code(404).send({ error: `No replay found for battle ${battleId}` });
    }

    const buf    = await storage.downloadToBuffer(record.rootHash);
    const replay = JSON.parse(buf.toString('utf8')) as ReplayBlob;

    // Re-derive hash from seed + action log
    const replayJson   = JSON.stringify(replay.actionLog);
    const computedHash = createHash('sha256').update(replay.seed + replayJson).digest('hex');

    const valid = computedHash === replay.finalStateHash;

    return {
      battleId,
      rootHash:       record.rootHash,
      storedHash:     replay.finalStateHash,
      computedHash,
      valid,
      actionCount:    replay.actionLog.length,
      durationMs:     replay.durationMs,
    };
  });

  // ── GET /replays/:battleId/meta — metadata only, no full download ─────────

  app.get<{ Params: { battleId: string } }>('/replays/:battleId/meta', async (req, reply) => {
    const record = await prisma.storageIndex.findUnique({
      where: { logicalPath: `replays/${req.params.battleId}` },
    });

    if (!record) return reply.code(404).send({ error: 'Replay not found' });

    return {
      battleId:   req.params.battleId,
      rootHash:   record.rootHash,
      txHash:     record.txHash,
      sizeBytes:  record.sizeBytes,
      storedAt:   record.createdAt,
    };
  });

  await app.listen({ port: PORT, host: '0.0.0.0' });
  app.log.info(`${SERVICE_NAME} running on port ${PORT}`);
}

bootstrap().catch(err => { console.error(err); process.exit(1); });
