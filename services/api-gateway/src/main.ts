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
    return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  };

  // Returns true when a real upstream URL is configured (not a localhost dev fallback).
  const hasRealUrl = (envKey: string): boolean => {
    const v = process.env[envKey];
    return !!v && !/^https?:\/\/localhost/i.test(v);
  };

  // 503 stub — used for services that are not yet deployed in this environment.
  const stub503 = (prefix: string) => async (_req: any, reply: any) =>
    reply.status(503).send({
      ok: false,
      error: 'This service is not yet deployed in this environment.',
      service: prefix,
    });

  // ── Deployed services — always proxied ─────────────────────────────────────
  type SvcDef = { prefix: string; envKey: string; fallback: string; rewritePrefix: string };

  const DEPLOYED: SvcDef[] = [
    { prefix: '/v1/auth',         envKey: 'IDENTITY_SERVICE_URL',    fallback: 'http://localhost:8001', rewritePrefix: '/auth'         },
    { prefix: '/v1/users',        envKey: 'IDENTITY_SERVICE_URL',    fallback: 'http://localhost:8001', rewritePrefix: '/users'        },
    { prefix: '/v1/agents',       envKey: 'AGENT_SERVICE_URL',       fallback: 'http://localhost:8002', rewritePrefix: '/agents'       },
    // Training lives in agent-service (/v1/training/* → agent-service /*)
    { prefix: '/v1/training',     envKey: 'AGENT_SERVICE_URL',       fallback: 'http://localhost:8002', rewritePrefix: ''              },
    // financial-service handles /v1/financial/*, /v1/wallets/*, /v1/escrow/*
    { prefix: '/v1/financial',    envKey: 'FINANCIAL_SERVICE_URL',   fallback: 'http://localhost:8005', rewritePrefix: ''              },
    { prefix: '/v1/wallets',      envKey: 'FINANCIAL_SERVICE_URL',   fallback: 'http://localhost:8005', rewritePrefix: '/wallets'      },
    { prefix: '/v1/escrow',       envKey: 'FINANCIAL_SERVICE_URL',   fallback: 'http://localhost:8005', rewritePrefix: '/escrow'       },
    { prefix: '/v1/battles',      envKey: 'BATTLE_SERVICE_URL',      fallback: 'http://localhost:8003', rewritePrefix: '/battles'      },
    { prefix: '/v1/matchmaking',  envKey: 'MATCHMAKING_SERVICE_URL', fallback: 'http://localhost:8004', rewritePrefix: '/queue'        },
    { prefix: '/v1/token',        envKey: 'TOKEN_SERVICE_URL',       fallback: 'http://localhost:8050', rewritePrefix: '/v1/token'     },
    { prefix: '/v1/leaderboards', envKey: 'LEADERBOARD_SERVICE_URL', fallback: 'http://localhost:8041', rewritePrefix: '/leaderboards' },
  ];

  // ── Optional / not-yet-deployed services — proxy if URL set, else 503 ──────
  const OPTIONAL: SvcDef[] = [
    { prefix: '/v1/games',        envKey: 'GAME_SERVICE_URL',        fallback: 'http://localhost:8008', rewritePrefix: ''              },
    { prefix: '/v1/telemetry',    envKey: 'TELEMETRY_SERVICE_URL',   fallback: 'http://localhost:8010', rewritePrefix: '/sessions'     },
    { prefix: '/v1/behaviour',    envKey: 'BEHAVIOUR_SERVICE_URL',   fallback: 'http://localhost:8011', rewritePrefix: ''              },
    { prefix: '/v1/inference',    envKey: 'INFERENCE_SERVICE_URL',   fallback: 'http://localhost:8013', rewritePrefix: ''              },
    { prefix: '/v1/memory',       envKey: 'MEMORY_SERVICE_URL',      fallback: 'http://localhost:8014', rewritePrefix: '/agents'       },
    { prefix: '/v1/replays',      envKey: 'REPLAY_SERVICE_URL',      fallback: 'http://localhost:8022', rewritePrefix: ''              },
    { prefix: '/v1/tournaments',  envKey: 'TOURNAMENT_SERVICE_URL',  fallback: 'http://localhost:8023', rewritePrefix: ''              },
    { prefix: '/v1/inft',         envKey: 'INFT_SERVICE_URL',        fallback: 'http://localhost:8032', rewritePrefix: ''              },
    { prefix: '/v1/payments',     envKey: 'PAYMENT_SERVICE_URL',     fallback: 'http://localhost:8033', rewritePrefix: ''              },
    { prefix: '/v1/analytics',    envKey: 'ANALYTICS_SERVICE_URL',   fallback: 'http://localhost:8040', rewritePrefix: ''              },
    { prefix: '/v1/storage',      envKey: 'STORAGE_SERVICE_URL',     fallback: 'http://localhost:8042', rewritePrefix: ''              },
    { prefix: '/v1/notifications',envKey: 'NOTIFICATION_SERVICE_URL',fallback: 'http://localhost:8043', rewritePrefix: ''              },
  ];

  const registerService = async (svc: SvcDef) => {
    const upstream = toUrl(process.env[svc.envKey], svc.fallback);
    await app.register(httpProxy, { upstream, prefix: svc.prefix, rewritePrefix: svc.rewritePrefix, http2: false });
  };

  // Always register deployed services
  for (const svc of DEPLOYED) {
    await registerService(svc);
  }

  // Optional: proxy if URL is configured; otherwise return 503 (avoids ECONNREFUSED in prod)
  for (const svc of OPTIONAL) {
    if (hasRealUrl(svc.envKey) || process.env.NODE_ENV !== 'production') {
      await registerService(svc);
    } else {
      const handler = stub503(svc.prefix);
      app.all(svc.prefix as any, handler);
      app.all(`${svc.prefix}/*` as any, handler);
    }
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
