import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import httpProxy from '@fastify/http-proxy';

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

  // NOTE: the old x402 payment middleware (middleware/x402.ts) that gated
  // /train, /clone, and wager matchmaking behind a payment proof is disabled.
  // It verified against financial-service's /escrow/x402/verify, which
  // checks/debits the pre-ARENA-migration Postgres AgentWallet.balanceArena
  // -- a balance system nobody has funds in anymore, since real ARENA now
  // lives on-chain (arena-chain-service). Training/clone are free for now;
  // wager staking already goes through the real on-chain ArenaEscrow permit
  // flow independently (see useArenaStaking.ts) and was never dependent on
  // this middleware succeeding. A real on-chain training/clone fee (signed
  // permit + relayer-submitted transferFrom to Treasury, same pattern as
  // staking) can replace this later if wanted.

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

  // ── OKX bridge rate limiting (only when Redis is available) ────────────────
  // Tighter than the global default since this is an externally-billed, pay-per-call
  // surface (no OKX-side sandbox to absorb retries/abuse) — see docs/okx/.
  if (rateLimitRedis) {
    const redis = rateLimitRedis;
    app.addHook('onRequest', async (req, reply) => {
      if (req.url.startsWith('/v1/okx')) {
        try {
          const key   = `rl:okx:${req.ip ?? 'unknown'}`;
          const limit = parseInt(process.env.OKX_RATE_LIMIT_MAX ?? '30');
          const win   = parseInt(process.env.OKX_RATE_LIMIT_WINDOW_MS ?? '60000');
          const count = await redis.incr(key);
          if (count === 1) await redis.pexpire(key, win);
          if (count > limit) {
            return reply.status(429).send({
              statusCode: 429,
              error: 'Too Many Requests',
              message: 'OKX bridge rate limit exceeded. Try again in 60 seconds.',
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
    // arena-chain-service — $ARENA 0G Chain economy (replaces the archived Solana token-service)
    { prefix: '/v1/arena',        envKey: 'ARENA_CHAIN_SERVICE_URL', fallback: 'http://localhost:8050', rewritePrefix: '/v1/arena'     },
    { prefix: '/v1/leaderboards', envKey: 'LEADERBOARD_SERVICE_URL', fallback: 'http://localhost:8041', rewritePrefix: '/leaderboards' },
    // league-service handles /v1/league/* itself — keep the prefix on the way through
    { prefix: '/v1/league',       envKey: 'LEAGUE_SERVICE_URL',      fallback: 'http://localhost:8060', rewritePrefix: '/v1/league'    },
    // Polymarket signals live in league-service too (docs/polymarket) — same rationale, own prefix
    { prefix: '/v1/polymarket',   envKey: 'LEAGUE_SERVICE_URL',      fallback: 'http://localhost:8060', rewritePrefix: '/v1/polymarket'},
    // F1 League also lives in league-service (docs/league/F1_LEAGUE_CONTEXT.md) — same rationale, own prefix
    { prefix: '/v1/f1',           envKey: 'LEAGUE_SERVICE_URL',      fallback: 'http://localhost:8060', rewritePrefix: '/v1/f1'        },
    // OKX Agent Marketplace — routed through payment proxy (x402 v2 gate), which
    // verifies payment then forwards to agent-service. Strip /v1/okx so the proxy
    // receives /create-agent (its own route). Fallback hits agent-service directly in dev.
    { prefix: '/v1/okx',          envKey: 'OKX_PAYMENT_PROXY_URL',   fallback: 'http://localhost:8090', rewritePrefix: ''              },
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
