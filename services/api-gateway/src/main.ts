import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import httpProxy from '@fastify/http-proxy';
import { registerX402Middleware } from './middleware/x402';

// ── Optional Redis for distributed rate limiting ──────────────────────────────
// Falls back to in-memory rate limiting when Redis is unavailable (local dev).
let rateLimitRedis: import('ioredis').Redis | undefined;

async function tryConnectRedis() {
  try {
    const { Redis } = await import('ioredis');
    const client = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
      maxRetriesPerRequest: 1,
      enableReadyCheck:     true,
      lazyConnect:          true,
      connectTimeout:       2000,
    });
    await client.connect();
    await client.ping();
    rateLimitRedis = client;
    console.log('[API Gateway] Redis connected — using distributed rate limiting');
  } catch {
    rateLimitRedis = undefined;
    console.warn('[API Gateway] Redis unavailable — using in-memory rate limiting (dev mode)');
  }
}

async function main() {
  await tryConnectRedis();

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport: process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty' }
        : undefined,
    },
    genReqId: () => crypto.randomUUID(),
    bodyLimit:         parseInt(process.env.BODY_LIMIT_BYTES ?? String(1_048_576)),
    connectionTimeout: 60_000,
    requestTimeout:    60_000,
  });

  // ── Security plugins ────────────────────────────────────────────────────────
  await app.register(cors, {
    origin: process.env.ALLOWED_ORIGINS?.split(',') ?? ['http://localhost:3000'],
    credentials: true,
  });

  await app.register(helmet, {
    contentSecurityPolicy: false,
    frameguard: { action: 'deny' },
    hsts: process.env.NODE_ENV === 'production'
      ? { maxAge: 31_536_000, includeSubDomains: true }
      : false,
  });

  // ── x402 Payment Middleware ─────────────────────────────────────────────────
  registerX402Middleware(app);

  // ── Rate limiting (Redis-backed if available, in-memory otherwise) ──────────
  await app.register(rateLimit, {
    global:     true,
    max:        parseInt(process.env.RATE_LIMIT_MAX       ?? '500'),
    timeWindow: parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '60000'),
    ...(rateLimitRedis ? { redis: rateLimitRedis } : {}),
    keyGenerator: (req) =>
      (req.headers['x-wallet-address'] as string | undefined) ?? req.ip ?? 'unknown',
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      error: 'Too Many Requests',
      message: `Rate limit exceeded. Try again in ${Math.ceil(context.ttl / 1000)}s.`,
      retryAfter: Math.ceil(context.ttl / 1000),
    }),
  });

  // ── Auth rate limiting (only when Redis is available) ──────────────────────
  if (rateLimitRedis) {
    const redis = rateLimitRedis;
    app.addHook('onRequest', async (req, reply) => {
      if (req.url.startsWith('/v1/auth')) {
        try {
          const key   = `rl:auth:${req.ip ?? 'unknown'}`;
          const limit = parseInt(process.env.AUTH_RATE_LIMIT_MAX ?? '10');
          const win   = parseInt(process.env.AUTH_RATE_LIMIT_WINDOW_MS ?? '60000');
          const count = await redis.incr(key);
          if (count === 1) await redis.pexpire(key, win);
          if (count > limit) {
            return reply.status(429).send({
              statusCode: 429,
              error: 'Too Many Requests',
              message: 'Authentication rate limit exceeded. Try again in 60 seconds.',
            });
          }
        } catch {
          // Redis error — skip rate limiting for this request
        }
      }
    });
  }

  // ── Health check ────────────────────────────────────────────────────────────
  app.get('/health', async () => ({
    status: 'ok',
    service: 'api-gateway',
    ts: Date.now(),
    redis: !!rateLimitRedis,
  }));

  // ── Service routing table ───────────────────────────────────────────────────
  // Render's fromService.host gives bare hostname (no scheme). Add https:// when missing.
  const toUrl = (raw: string | undefined, fallback: string): string => {
    if (!raw) return fallback;
    // All service URLs are full https:// values — passed through unchanged.
    // Bare strings (local dev fallbacks) get https:// prepended.
    return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  };

  const SERVICES: Array<{ prefix: string; upstream: string; rewritePrefix: string }> = [
    { prefix: '/v1/auth',          upstream: toUrl(process.env.IDENTITY_SERVICE_URL,    'http://localhost:8001'), rewritePrefix: '/auth'        },
    { prefix: '/v1/users',         upstream: toUrl(process.env.IDENTITY_SERVICE_URL,    'http://localhost:8001'), rewritePrefix: '/users'       },
    { prefix: '/v1/agents',        upstream: toUrl(process.env.AGENT_SERVICE_URL,       'http://localhost:8002'), rewritePrefix: '/agents'      },
    // financial-service handles /v1/financial/* and /v1/wallets/* and /v1/escrow/*
    { prefix: '/v1/financial',     upstream: toUrl(process.env.FINANCIAL_SERVICE_URL,   'http://localhost:8005'), rewritePrefix: ''             },
    { prefix: '/v1/wallets',       upstream: toUrl(process.env.FINANCIAL_SERVICE_URL,   'http://localhost:8005'), rewritePrefix: '/wallets'     },
    { prefix: '/v1/escrow',        upstream: toUrl(process.env.FINANCIAL_SERVICE_URL,   'http://localhost:8005'), rewritePrefix: '/escrow'      },
    { prefix: '/v1/games',         upstream: toUrl(process.env.GAME_SERVICE_URL,        'http://localhost:8004'), rewritePrefix: ''             },
    { prefix: '/v1/telemetry',     upstream: toUrl(process.env.TELEMETRY_SERVICE_URL,   'http://localhost:8010'), rewritePrefix: '/sessions'    },
    { prefix: '/v1/behaviour',     upstream: toUrl(process.env.BEHAVIOUR_SERVICE_URL,   'http://localhost:8011'), rewritePrefix: ''             },
    { prefix: '/v1/training',      upstream: toUrl(process.env.TRAINING_SERVICE_URL,    'http://localhost:8012'), rewritePrefix: '/jobs'        },
    { prefix: '/v1/inference',     upstream: toUrl(process.env.INFERENCE_SERVICE_URL,   'http://localhost:8013'), rewritePrefix: ''             },
    { prefix: '/v1/memory',        upstream: toUrl(process.env.MEMORY_SERVICE_URL,      'http://localhost:8014'), rewritePrefix: '/agents'      },
    { prefix: '/v1/matchmaking',   upstream: toUrl(process.env.MATCHMAKING_SERVICE_URL, 'http://localhost:8004'), rewritePrefix: '/queue'       },
    { prefix: '/v1/battles',       upstream: toUrl(process.env.BATTLE_SERVICE_URL,      'http://localhost:8003'), rewritePrefix: '/battles'     },
    { prefix: '/v1/replays',       upstream: toUrl(process.env.REPLAY_SERVICE_URL,      'http://localhost:8022'), rewritePrefix: ''             },
    { prefix: '/v1/tournaments',   upstream: toUrl(process.env.TOURNAMENT_SERVICE_URL,  'http://localhost:8023'), rewritePrefix: ''             },
    { prefix: '/v1/inft',          upstream: toUrl(process.env.INFT_SERVICE_URL,        'http://localhost:8032'), rewritePrefix: ''             },
    { prefix: '/v1/payments',      upstream: toUrl(process.env.PAYMENT_SERVICE_URL,     'http://localhost:8033'), rewritePrefix: ''             },
    { prefix: '/v1/analytics',     upstream: toUrl(process.env.ANALYTICS_SERVICE_URL,   'http://localhost:8040'), rewritePrefix: ''             },
    { prefix: '/v1/leaderboards',  upstream: toUrl(process.env.LEADERBOARD_SERVICE_URL, 'http://localhost:8041'), rewritePrefix: '/leaderboards'},
    { prefix: '/v1/storage',       upstream: toUrl(process.env.STORAGE_SERVICE_URL,     'http://localhost:8042'), rewritePrefix: ''             },
    { prefix: '/v1/notifications', upstream: toUrl(process.env.NOTIFICATION_SERVICE_URL,'http://localhost:8043'), rewritePrefix: ''             },
    { prefix: '/v1/token',         upstream: toUrl(process.env.TOKEN_SERVICE_URL,       'http://localhost:8050'), rewritePrefix: '/v1/token'    },
  ];

  for (const { prefix, upstream, rewritePrefix } of SERVICES) {
    await app.register(httpProxy, {
      upstream,
      prefix,
      rewritePrefix,
      http2: false,
    });
  }

  // ── Start ───────────────────────────────────────────────────────────────────
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
