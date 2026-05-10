import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import httpProxy from '@fastify/http-proxy';
import Redis from 'ioredis';

// ── Redis store for distributed rate limiting ─────────────────────────────────
// Shared across all gateway instances so limits are enforced cluster-wide.
const rateLimitRedis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: 2,
  enableReadyCheck: false,
  lazyConnect: true,
});

async function main() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport: process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty' }
        : undefined,
    },
    genReqId: () => crypto.randomUUID(),
    // Cap request body at 1 MB — rejects oversized payloads before they reach
    // services, protecting against memory-exhaustion DDoS vectors.
    bodyLimit: parseInt(process.env.BODY_LIMIT_BYTES ?? String(1_048_576)),
    // Keep-alive + header timeouts to drop slow-loris connections.
    connectionTimeout: 30_000,
    requestTimeout:    30_000,
  });

  // ── Security plugins ──────────────────────────────────────────────────────────
  await app.register(cors, {
    origin: process.env.ALLOWED_ORIGINS?.split(',') ?? ['http://localhost:3000'],
    credentials: true,
  });

  await app.register(helmet, {
    contentSecurityPolicy: false,
    // Prevent clickjacking
    frameguard: { action: 'deny' },
    // Force HTTPS in production
    hsts: process.env.NODE_ENV === 'production'
      ? { maxAge: 31_536_000, includeSubDomains: true }
      : false,
  });

  // ── Global rate limit (Redis-backed, distributed) ─────────────────────────────
  // Key = wallet address (authenticated) or IP (unauthenticated).
  // Behind a reverse proxy / load balancer set TRUSTED_PROXIES to honour
  // X-Forwarded-For; default trusts the immediate upstream only.
  await app.register(rateLimit, {
    global:     true,
    max:        parseInt(process.env.RATE_LIMIT_MAX        ?? '200'),
    timeWindow: parseInt(process.env.RATE_LIMIT_WINDOW_MS  ?? '60000'),
    redis:      rateLimitRedis,
    keyGenerator: (req) =>
      (req.headers['x-wallet-address'] as string | undefined) ?? req.ip ?? 'unknown',
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Try again in ${Math.ceil(context.ttl / 1000)}s.`,
      retryAfter: Math.ceil(context.ttl / 1000),
    }),
  });

  // ── Strict rate limit on authentication endpoints ─────────────────────────────
  // Credential-stuffing / brute-force protection: 10 req/min per IP on /v1/auth.
  app.addHook('onRequest', async (req, reply) => {
    if (req.url.startsWith('/v1/auth')) {
      const key   = `rl:auth:${req.ip ?? 'unknown'}`;
      const limit = parseInt(process.env.AUTH_RATE_LIMIT_MAX ?? '10');
      const win   = parseInt(process.env.AUTH_RATE_LIMIT_WINDOW_MS ?? '60000');
      const count = await rateLimitRedis.incr(key);
      if (count === 1) await rateLimitRedis.pexpire(key, win);
      if (count > limit) {
        reply.status(429).send({
          statusCode: 429,
          error: 'Too Many Requests',
          message: 'Authentication rate limit exceeded. Try again in 60 seconds.',
        });
      }
    }
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
    { prefix: '/v1/token',         upstream: process.env.TOKEN_SERVICE_URL        ?? 'http://localhost:8050' },
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
  try {
    await app.listen({ port, host: '0.0.0.0' });
    app.log.info(`API Gateway listening on port ${port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  process.on('SIGINT',  async () => { await app.close(); process.exit(0); });
  process.on('SIGTERM', async () => { await app.close(); process.exit(0); });
}

main().catch((err) => { console.error(err); process.exit(1); });
