# API Gateway Service

Central entry point for all AI Arena API traffic. Routes requests to downstream microservices, enforces authentication, applies rate limiting, and handles CORS.

## Port
`8000`

## Responsibilities

- JWT authentication validation (delegated to identity-service)
- Rate limiting per IP and per wallet
- Request routing to all 24 downstream microservices
- WebSocket proxying for battle and notification streams
- CORS header management
- Request/response logging with trace IDs

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

## Environment Variables

```
PORT=8000
JWT_SECRET=your_jwt_secret
RATE_LIMIT_MAX=100
RATE_LIMIT_WINDOW_MS=60000
IDENTITY_SERVICE_URL=http://identity-service:8001
AGENT_SERVICE_URL=http://agent-service:8002
BATTLE_SERVICE_URL=http://battle-service:8021
# ... (all service URLs)
```

## Run Locally

```bash
pnpm install
pnpm dev
```
