# API Gateway Service

Central entry point for all AI Arena API traffic. Routes requests to 24 downstream microservices, enforces rate limiting, and handles CORS.

## Port
`8000`

## Responsibilities

- Request routing to all downstream microservices via `@fastify/http-proxy`
- Rate limiting per IP / wallet address (Redis-backed when available, in-memory fallback for local dev)
- CORS header management
- Request/response logging with trace IDs
- Health check aggregation

## Redis-Optional Design

The gateway attempts to connect to Redis on startup. If Redis is unavailable (common in local dev), it **automatically falls back to in-memory rate limiting** — the gateway still starts and proxies all traffic normally. A log warning is emitted:

```
[API Gateway] Redis unavailable — using in-memory rate limiting (dev mode)
```

When Redis is available:
```
[API Gateway] Redis connected — using distributed rate limiting
```

## Routes Proxied

| Prefix | Downstream Service | Port |
|--------|-------------------|------|
| `/v1/auth` | identity-service | 8001 |
| `/v1/users` | identity-service | 8001 |
| `/v1/agents` | agent-service | 8002 |
| `/v1/financial` | financial-service | 8003 |
| `/v1/games` | game-service | 8004 |
| `/v1/telemetry` | telemetry-service | 8010 |
| `/v1/behaviour` | behaviour-service | 8011 |
| `/v1/training` | training-service | 8012 |
| `/v1/inference` | inference-service | 8013 |
| `/v1/memory` | memory-service | 8014 |
| `/v1/matchmaking` | matchmaking-service | 8020 |
| `/v1/battles` | battle-service | 8021 |
| `/v1/replays` | replay-service | 8022 |
| `/v1/tournaments` | tournament-service | 8023 |
| `/v1/wallets` | wallet-service | 8030 |
| `/v1/escrow` | escrow-service | 8031 |
| `/v1/inft` | inft-service | 8032 |
| `/v1/payments` | payment-service | 8033 |
| `/v1/analytics` | analytics-service | 8040 |
| `/v1/leaderboards` | leaderboard-service | 8041 |
| `/v1/storage` | storage-service | 8042 |
| `/v1/notifications` | notification-service | 8043 |
| `/v1/token` | token-service | 8050 |

## Health Check

```
GET /health → { status: "ok", service: "api-gateway", ts: <epoch_ms>, redis: <bool> }
```

The `redis` field indicates whether the distributed Redis rate limiter is active.

## Environment Variables

```bash
PORT=8000
REDIS_URL=redis://localhost:6379          # Optional — falls back to in-memory
RATE_LIMIT_MAX=500                        # Requests per window (default 500)
RATE_LIMIT_WINDOW_MS=60000               # Window size in ms (default 60s)
AUTH_RATE_LIMIT_MAX=10                    # Extra limit on /v1/auth/* (Redis only)
AUTH_RATE_LIMIT_WINDOW_MS=60000
ALLOWED_ORIGINS=http://localhost:3000     # Comma-separated CORS origins
LOG_LEVEL=info

# Downstream service URLs (defaults shown — override for Docker/k8s)
IDENTITY_SERVICE_URL=http://localhost:8001
AGENT_SERVICE_URL=http://localhost:8002
FINANCIAL_SERVICE_URL=http://localhost:8003
BATTLE_SERVICE_URL=http://localhost:8021
LEADERBOARD_SERVICE_URL=http://localhost:8041
TOKEN_SERVICE_URL=http://localhost:8050
# ... (all other service URLs follow the same pattern)
```

## Run Locally

```bash
# Via pnpm dev (recommended — loads .env automatically)
pnpm dev

# Or directly
npx tsx src/main.ts
```
