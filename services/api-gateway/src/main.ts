import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import httpProxy from '@fastify/http-proxy';

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    transport: process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty' }
      : undefined,
  },
  genReqId: () => crypto.randomUUID(),
});

// ── Security plugins ──────────────────────────────────────────────────────────
await app.register(cors, {
  origin: process.env.ALLOWED_ORIGINS?.split(',') ?? ['http://localhost:3000'],
  credentials: true,
});

await app.register(helmet, { contentSecurityPolicy: false });

await app.register(rateLimit, {
  max: parseInt(process.env.RATE_LIMIT_MAX ?? '100'),
  timeWindow: parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '60000'),
  keyGenerator: (req) =>
    req.headers['x-wallet-address'] as string ?? req.ip,
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', async () => ({ status: 'ok', service: 'api-gateway', ts: Date.now() }));

// ── Service routing table ─────────────────────────────────────────────────────
const SERVICES: Array<{ prefix: string; upstream: string }> = [
  { prefix: '/v1/auth',          upstream: process.env.IDENTITY_SERVICE_URL     ?? 'http://localhost:8001' },
  { prefix: '/v1/users',         upstream: process.env.IDENTITY_SERVICE_URL     ?? 'http://localhost:8001' },
  { prefix: '/v1/agents',        upstream: process.env.AGENT_SERVICE_URL        ?? 'http://localhost:8002' },
  { prefix: '/v1/financial',     upstream: process.env.FINANCIAL_SERVICE_URL    ?? 'http://localhost:8003' },
  { prefix: '/v1/games',         upstream: process.env.GAME_SERVICE_URL         ?? 'http://localhost:8004' },
  { prefix: '/v1/telemetry',     upstream: process.env.TELEMETRY_SERVICE_URL    ?? 'http://localhost:8010' },
  { prefix: '/v1/behaviour',     upstream: process.env.BEHAVIOUR_SERVICE_URL    ?? 'http://localhost:8011' },
  { prefix: '/v1/training',      upstream: process.env.TRAINING_SERVICE_URL     ?? 'http://localhost:8012' },
  { prefix: '/v1/inference',     upstream: process.env.INFERENCE_SERVICE_URL    ?? 'http://localhost:8013' },
  { prefix: '/v1/memory',        upstream: process.env.MEMORY_SERVICE_URL       ?? 'http://localhost:8014' },
  { prefix: '/v1/matchmaking',   upstream: process.env.MATCHMAKING_SERVICE_URL  ?? 'http://localhost:8020' },
  { prefix: '/v1/battles',       upstream: process.env.BATTLE_SERVICE_URL       ?? 'http://localhost:8021' },
  { prefix: '/v1/replays',       upstream: process.env.REPLAY_SERVICE_URL       ?? 'http://localhost:8022' },
  { prefix: '/v1/tournaments',   upstream: process.env.TOURNAMENT_SERVICE_URL   ?? 'http://localhost:8023' },
  { prefix: '/v1/wallets',       upstream: process.env.WALLET_SERVICE_URL       ?? 'http://localhost:8030' },
  { prefix: '/v1/escrow',        upstream: process.env.ESCROW_SERVICE_URL       ?? 'http://localhost:8031' },
  { prefix: '/v1/inft',          upstream: process.env.INFT_SERVICE_URL         ?? 'http://localhost:8032' },
  { prefix: '/v1/payments',      upstream: process.env.PAYMENT_SERVICE_URL      ?? 'http://localhost:8033' },
  { prefix: '/v1/analytics',     upstream: process.env.ANALYTICS_SERVICE_URL    ?? 'http://localhost:8040' },
  { prefix: '/v1/leaderboards',  upstream: process.env.LEADERBOARD_SERVICE_URL  ?? 'http://localhost:8041' },
  { prefix: '/v1/storage',       upstream: process.env.STORAGE_SERVICE_URL      ?? 'http://localhost:8042' },
  { prefix: '/v1/notifications', upstream: process.env.NOTIFICATION_SERVICE_URL ?? 'http://localhost:8043' },
];

for (const { prefix, upstream } of SERVICES) {
  await app.register(httpProxy, {
    upstream,
    prefix,
    rewritePrefix: prefix,
    http2: false,
  });
}

// ── Start ─────────────────────────────────────────────────────────────────────
const port = parseInt(process.env.PORT ?? '8000');
await app.listen({ port, host: '0.0.0.0' });
app.log.info(`API Gateway listening on port ${port}`);
