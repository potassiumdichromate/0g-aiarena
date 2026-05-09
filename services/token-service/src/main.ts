/**
 * Token Service — Fastify entry point
 *
 * Port: 8050  (add to API gateway upstream list)
 *
 * Routes:
 *   /health          — liveness probe
 *   /v1/token/*      — all token endpoints (see token.routes.ts)
 *
 * Workers (run as separate processes):
 *   src/workers/bridge-listener.ts  — EVM DepositQueued event relay
 *   src/workers/rebalancer.ts       — periodic 60/40 USDC/USDT rebalance check
 */

import Fastify from 'fastify';
import cors    from '@fastify/cors';
import helmet  from '@fastify/helmet';
import { tokenRoutes } from './routes/token.routes';

const PORT = parseInt(process.env.PORT ?? '8050', 10);
const HOST = process.env.HOST ?? '0.0.0.0';

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    transport: process.env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
  },
  bodyLimit: 1_048_576, // 1 MB
  requestTimeout: 30_000,
  connectionTimeout: 30_000,
});

// ── Plugins ──────────────────────────────────────────────────────────────────

await app.register(cors, {
  origin:      process.env.ALLOWED_ORIGINS?.split(',') ?? ['http://localhost:3000'],
  credentials: true,
});

await app.register(helmet, {
  contentSecurityPolicy: false, // API — no HTML
  frameguard: { action: 'deny' },
  hsts: process.env.NODE_ENV === 'production'
    ? { maxAge: 31_536_000, includeSubDomains: true }
    : false,
});

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/health', async () => ({ ok: true, service: 'token-service', ts: new Date() }));

await app.register(tokenRoutes, { prefix: '/v1/token' });

// ── Start ─────────────────────────────────────────────────────────────────────

try {
  await app.listen({ port: PORT, host: HOST });
  app.log.info(`token-service listening on ${HOST}:${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

async function shutdown(signal: string) {
  app.log.info(`Received ${signal} — shutting down token-service`);
  await app.close();
  process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
