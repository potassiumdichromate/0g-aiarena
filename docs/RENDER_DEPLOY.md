# AI Arena — Render Deployment Guide

Deploy the full AI Arena backend to [Render.com](https://render.com) using a monorepo setup.

---

## Architecture on Render

```
Render Managed PostgreSQL  ←── all services
Render Managed Redis        ←── api-gateway, matchmaking
NATS (Synadia Cloud / self-hosted) ←── event bus
```

**Services deployed as Render Web Services (8 required):**

| Render Service Name | Internal Port | Monthly Cost (Starter) |
|---------------------|--------------|----------------------|
| `aiarena-gateway` | 8000 | ~$7 |
| `aiarena-identity` | 8001 | ~$7 |
| `aiarena-agent` | 8002 | ~$7 |
| `aiarena-battle` | 8003 | ~$7 |
| `aiarena-matchmaking` | 8004 | ~$7 |
| `aiarena-financial` | 8005 | ~$7 |
| `aiarena-token` | 8006 | ~$7 |
| `aiarena-leaderboard` | 8008 | ~$7 |
| PostgreSQL (managed) | 5432 | ~$7 |
| Redis (managed) | 6379 | ~$10 |
| **Total** | | **~$77/month** |

---

## Step 1 — External Services Setup (do this first)

### 1a. NATS (event bus)

Render doesn't offer managed NATS. Two options:

**Option A — Synadia NGS (recommended, free tier):**
1. Go to [app.ngs.global](https://app.ngs.global) → Sign up
2. Create a new account → Create a user → Download credentials file
3. Your NATS URL: `tls://connect.ngs.global` (with NGS credentials)

**Option B — Deploy NATS on Render (free):**
1. In Render dashboard → New → Web Service → Deploy from Docker image
2. Image: `nats:2.10-alpine`
3. Start command: `nats-server -p 4222`
4. Set `NATS_URL=nats://aiarena-nats:4222` using internal hostname

> For simplicity, use Synadia NGS free tier. It handles millions of messages/month for free.

### 1b. Privy (auth)
1. Go to [privy.io](https://privy.io) → Dashboard → Create App
2. Copy `App ID` and `App Secret`
3. Under **Login Methods** → enable Wallet (MetaMask) + Email
4. Under **Allowed Origins** → add your Render URLs

### 1c. 0G Compute API Key
1. Go to [pc.0g.ai](https://pc.0g.ai) → Dashboard → API Keys
2. Create key with **inference** permission
3. Deposit 0G tokens for billing

---

## Step 2 — Create Render Managed Services

### PostgreSQL

1. Render Dashboard → **New** → **PostgreSQL**
2. Name: `aiarena-db`
3. Plan: **Starter** ($7/month) or **Standard** for production
4. Region: **Oregon (US West)** — pick one and use same for all services
5. After creation, copy the **Internal Database URL** (format: `postgresql://user:pass@host/db`)

### Redis

1. Render Dashboard → **New** → **Redis**
2. Name: `aiarena-redis`
3. Plan: **Starter** ($10/month)
4. Copy the **Internal Redis URL**

---

## Step 3 — Environment Variables (shared across services)

Create these in Render's **Environment Groups** (Dashboard → Environment Groups → New Group → name it `aiarena-shared`):

```bash
# Database (use Internal URL from Step 2)
DATABASE_URL=postgresql://aiarena_user:password@dpg-xxx.oregon-postgres.render.com/aiarena_db

# Redis (use Internal URL from Step 2)
REDIS_URL=redis://red-xxx.oregon-redis.render.com:6379

# NATS
NATS_URL=nats://aiarena-nats:4222        # if self-hosted on Render
# OR for Synadia NGS:
NATS_URL=tls://connect.ngs.global

# Auth
JWT_SECRET=<run: openssl rand -hex 64>
JWT_ACCESS_EXPIRY=15m
JWT_REFRESH_EXPIRY=7d

# Privy
PRIVY_APP_ID=your-privy-app-id
PRIVY_APP_SECRET=your-privy-app-secret

# 0G Compute
ZEROG_COMPUTE_BASE_URL=https://router-api.0g.ai/v1
ZEROG_COMPUTE_API_KEY=sk-your-key-here
ZEROG_MODEL_CHAT=zai-org/GLM-5.1-FP8
ZEROG_MODEL_IMAGE=z-image
ZEROG_NETWORK=mainnet

# 0G Storage
ZEROG_STORAGE_PRIVATE_KEY=0x_your_private_key
ZEROG_STORAGE_RPC=https://evmrpc-testnet.0g.ai   # or mainnet RPC

# Solana
SOLANA_RPC_URL=https://api.devnet.solana.com   # devnet; change for mainnet
AGENT_WALLET_PROGRAM_ID=<your deployed program ID>
ESCROW_VAULT_PROGRAM_ID=<your deployed program ID>
ARENA_TOKEN_PROGRAM_ID=<your deployed program ID>
ARENA_RESERVE_PROGRAM_ID=<your deployed program ID>

# Custodial wallet encryption (generate: openssl rand -hex 32)
CUSTODIAL_WALLET_ENCRYPTION_KEY=<32-byte hex key>

# Feature flags
ENABLE_AVATAR_GEN=false      # true once 0G credits are loaded
NODE_ENV=production
LOG_LEVEL=info
```

---

## Step 4 — Deploy Each Service

For each service below, go to:
**Render Dashboard → New → Web Service → Connect GitHub repo → select your repo**

Use these settings for every service unless noted otherwise:
- **Environment**: Node
- **Branch**: `main`
- **Root Directory**: `services/<service-name>`
- **Build Command**: `cd ../.. && pnpm install --frozen-lockfile && pnpm build --filter=<service-name>`
- **Start Command**: `node dist/main.js`
- **Health Check Path**: `/health`
- **Environment Group**: `aiarena-shared` (attach the group you created)

---

### 4a. API Gateway

| Setting | Value |
|---------|-------|
| Name | `aiarena-gateway` |
| Root Directory | `services/api-gateway` |
| Build Command | `cd ../.. && pnpm install --frozen-lockfile && pnpm --filter @ai-arena/api-gateway build` |
| Start Command | `node dist/main.js` |
| Port | `8000` |

**Extra env vars for this service:**
```bash
PORT=8000
IDENTITY_SERVICE_URL=https://aiarena-identity.onrender.com
AGENT_SERVICE_URL=https://aiarena-agent.onrender.com
BATTLE_SERVICE_URL=https://aiarena-battle.onrender.com
MATCHMAKING_SERVICE_URL=https://aiarena-matchmaking.onrender.com
FINANCIAL_SERVICE_URL=https://aiarena-financial.onrender.com
TOKEN_SERVICE_URL=https://aiarena-token.onrender.com
LEADERBOARD_SERVICE_URL=https://aiarena-leaderboard.onrender.com
```

> **This is your public URL.** Point your frontend's `NEXT_PUBLIC_API_URL` to this service's Render URL.

---

### 4b. Identity Service

| Setting | Value |
|---------|-------|
| Name | `aiarena-identity` |
| Root Directory | `services/identity-service` |
| Build Command | `cd ../.. && pnpm install --frozen-lockfile && pnpm --filter @ai-arena/identity-service build` |
| Port | `8001` |

**Extra env vars:**
```bash
PORT=8001
```

---

### 4c. Agent Service

| Setting | Value |
|---------|-------|
| Name | `aiarena-agent` |
| Root Directory | `services/agent-service` |
| Build Command | `cd ../.. && pnpm install --frozen-lockfile && pnpm --filter @ai-arena/agent-service build` |
| Port | `8002` |

**Extra env vars:**
```bash
PORT=8002
ENABLE_AVATAR_GEN=false
```

---

### 4d. Battle Service

| Setting | Value |
|---------|-------|
| Name | `aiarena-battle` |
| Root Directory | `services/battle-service` |
| Build Command | `cd ../.. && pnpm install --frozen-lockfile && pnpm --filter @ai-arena/battle-service build` |
| Port | `8003` |

**Extra env vars:**
```bash
PORT=8003
```

---

### 4e. Matchmaking Service

| Setting | Value |
|---------|-------|
| Name | `aiarena-matchmaking` |
| Root Directory | `services/matchmaking-service` |
| Build Command | `cd ../.. && pnpm install --frozen-lockfile && pnpm --filter @ai-arena/matchmaking-service build` |
| Port | `8004` |

**Extra env vars:**
```bash
PORT=8004
```

---

### 4f. Financial Service

| Setting | Value |
|---------|-------|
| Name | `aiarena-financial` |
| Root Directory | `services/financial-service` |
| Build Command | `cd ../.. && pnpm install --frozen-lockfile && pnpm --filter @ai-arena/financial-service build` |
| Port | `8005` |

**Extra env vars:**
```bash
PORT=8005
```

---

### 4g. Token Service

| Setting | Value |
|---------|-------|
| Name | `aiarena-token` |
| Root Directory | `services/token-service` |
| Build Command | `cd ../.. && pnpm install --frozen-lockfile && pnpm --filter @ai-arena/token-service build` |
| Port | `8006` |

**Extra env vars:**
```bash
PORT=8006
```

---

### 4h. Leaderboard Service

| Setting | Value |
|---------|-------|
| Name | `aiarena-leaderboard` |
| Root Directory | `services/leaderboard-service` |
| Build Command | `cd ../.. && pnpm install --frozen-lockfile && pnpm --filter @ai-arena/leaderboard-service build` |
| Port | `8008` |

**Extra env vars:**
```bash
PORT=8008
```

---

## Step 5 — Run Database Migrations (one-time)

After all services are created, run the Prisma migration using Render's **Shell** feature:

1. Open `aiarena-agent` service on Render → **Shell** tab
2. Run:

```bash
cd /app
npx prisma migrate deploy
npx prisma generate
```

This applies all migrations including the clan rename.

---

## Step 6 — Deploy Order

Deploy in this exact order (dependencies first):

```
1. PostgreSQL          ← no deps
2. Redis               ← no deps
3. aiarena-identity    ← needs DB
4. aiarena-agent       ← needs DB + NATS
5. aiarena-battle      ← needs DB + NATS
6. aiarena-financial   ← needs DB + NATS
7. aiarena-token       ← needs DB
8. aiarena-leaderboard ← needs DB
9. aiarena-matchmaking ← needs DB + Redis + NATS
10. aiarena-gateway    ← needs all services running
```

---

## Step 7 — Verify Deployment

After all services are up, hit the gateway health endpoint:

```bash
curl https://aiarena-gateway.onrender.com/health
```

Expected response:
```json
{
  "status": "ok",
  "uptime": 42,
  "redis": true,
  "version": "0.1.0"
}
```

Then test the full auth flow:
```bash
# 1. Create a dev user (only works with NODE_ENV != production — remove after testing)
curl -X POST https://aiarena-gateway.onrender.com/v1/auth/dev-login \
  -H "Content-Type: application/json" \
  -d '{"username": "TestDeploy"}'

# 2. Create an agent (use the accessToken from step 1)
curl -X POST https://aiarena-gateway.onrender.com/v1/agents \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{"name": "RenderBot-1", "clan": "ZEROG", "archetype": "TACTICIAN"}'

# 3. List agents (public)
curl https://aiarena-gateway.onrender.com/v1/agents
```

---

## Step 8 — Custom Domain (optional)

1. Render Dashboard → `aiarena-gateway` → **Settings** → **Custom Domain**
2. Add `api.yourdomain.com`
3. Add CNAME record in your DNS: `api.yourdomain.com → aiarena-gateway.onrender.com`

Then update your frontend to use `https://api.yourdomain.com`.

---

## Render render.yaml (Infrastructure as Code)

Create `render.yaml` in your repo root to automate the whole setup with one click:

```yaml
databases:
  - name: aiarena-db
    databaseName: aiarena
    user: aiarena_user
    plan: starter

services:
  - type: redis
    name: aiarena-redis
    plan: starter
    maxmemoryPolicy: allkeys-lru

  - type: web
    name: aiarena-identity
    env: node
    plan: starter
    rootDir: services/identity-service
    buildCommand: cd ../.. && pnpm install --frozen-lockfile && pnpm --filter @ai-arena/identity-service build
    startCommand: node dist/main.js
    healthCheckPath: /health
    envVars:
      - key: PORT
        value: 8001
      - key: NODE_ENV
        value: production
      - fromGroup: aiarena-shared

  - type: web
    name: aiarena-agent
    env: node
    plan: starter
    rootDir: services/agent-service
    buildCommand: cd ../.. && pnpm install --frozen-lockfile && pnpm --filter @ai-arena/agent-service build
    startCommand: node dist/main.js
    healthCheckPath: /health
    envVars:
      - key: PORT
        value: 8002
      - key: NODE_ENV
        value: production
      - key: ENABLE_AVATAR_GEN
        value: "false"
      - fromGroup: aiarena-shared

  - type: web
    name: aiarena-battle
    env: node
    plan: starter
    rootDir: services/battle-service
    buildCommand: cd ../.. && pnpm install --frozen-lockfile && pnpm --filter @ai-arena/battle-service build
    startCommand: node dist/main.js
    healthCheckPath: /health
    envVars:
      - key: PORT
        value: 8003
      - key: NODE_ENV
        value: production
      - fromGroup: aiarena-shared

  - type: web
    name: aiarena-matchmaking
    env: node
    plan: starter
    rootDir: services/matchmaking-service
    buildCommand: cd ../.. && pnpm install --frozen-lockfile && pnpm --filter @ai-arena/matchmaking-service build
    startCommand: node dist/main.js
    healthCheckPath: /health
    envVars:
      - key: PORT
        value: 8004
      - key: NODE_ENV
        value: production
      - fromGroup: aiarena-shared

  - type: web
    name: aiarena-financial
    env: node
    plan: starter
    rootDir: services/financial-service
    buildCommand: cd ../.. && pnpm install --frozen-lockfile && pnpm --filter @ai-arena/financial-service build
    startCommand: node dist/main.js
    healthCheckPath: /health
    envVars:
      - key: PORT
        value: 8005
      - key: NODE_ENV
        value: production
      - fromGroup: aiarena-shared

  - type: web
    name: aiarena-token
    env: node
    plan: starter
    rootDir: services/token-service
    buildCommand: cd ../.. && pnpm install --frozen-lockfile && pnpm --filter @ai-arena/token-service build
    startCommand: node dist/main.js
    healthCheckPath: /health
    envVars:
      - key: PORT
        value: 8006
      - key: NODE_ENV
        value: production
      - fromGroup: aiarena-shared

  - type: web
    name: aiarena-leaderboard
    env: node
    plan: starter
    rootDir: services/leaderboard-service
    buildCommand: cd ../.. && pnpm install --frozen-lockfile && pnpm --filter @ai-arena/leaderboard-service build
    startCommand: node dist/main.js
    healthCheckPath: /health
    envVars:
      - key: PORT
        value: 8008
      - key: NODE_ENV
        value: production
      - fromGroup: aiarena-shared

  - type: web
    name: aiarena-gateway
    env: node
    plan: starter
    rootDir: services/api-gateway
    buildCommand: cd ../.. && pnpm install --frozen-lockfile && pnpm --filter @ai-arena/api-gateway build
    startCommand: node dist/main.js
    healthCheckPath: /health
    envVars:
      - key: PORT
        value: 8000
      - key: NODE_ENV
        value: production
      - key: IDENTITY_SERVICE_URL
        fromService:
          name: aiarena-identity
          type: web
          property: host
      - key: AGENT_SERVICE_URL
        fromService:
          name: aiarena-agent
          type: web
          property: host
      - key: BATTLE_SERVICE_URL
        fromService:
          name: aiarena-battle
          type: web
          property: host
      - key: MATCHMAKING_SERVICE_URL
        fromService:
          name: aiarena-matchmaking
          type: web
          property: host
      - key: FINANCIAL_SERVICE_URL
        fromService:
          name: aiarena-financial
          type: web
          property: host
      - key: TOKEN_SERVICE_URL
        fromService:
          name: aiarena-token
          type: web
          property: host
      - key: LEADERBOARD_SERVICE_URL
        fromService:
          name: aiarena-leaderboard
          type: web
          property: host
      - fromGroup: aiarena-shared
```

> With `render.yaml` in your repo root, just go to Render → **New** → **Blueprint** → connect your repo → it provisions everything automatically.

---

## Troubleshooting

### Build fails — "workspace:* not found"
Render builds from the service's root directory, but `pnpm workspace:*` dependencies need the root `package.json`. The build command `cd ../..` handles this. Make sure your root `package.json` has:
```json
{ "packageManager": "pnpm@9.x.x" }
```

### Service crashes on startup — "Cannot connect to DB"
- Make sure PostgreSQL is fully created before deploying services
- Use the **Internal Database URL** from Render (not the external one — it's faster and free within Render)

### Matchmaking not finding matches
Redis is required. Confirm `aiarena-redis` is running and `REDIS_URL` is the internal URL.

### 0G Compute timeouts
- Check your 0G Compute balance at `pc.0g.ai`
- `ENABLE_AVATAR_GEN=false` (default) avoids the slowest call
- Inference calls have 10s timeout with auto-fallback

### NATS not connecting
- If using Synadia NGS: the URL format is `tls://connect.ngs.global` and you need to set credentials via `NATS_CREDS` env var (base64 the .creds file)
- If self-hosting on Render: make sure the NATS service is using the internal hostname

---

## Security Checklist Before Going Live

- [ ] `NODE_ENV=production` on all services
- [ ] `JWT_SECRET` is at least 64 random hex characters
- [ ] `CUSTODIAL_WALLET_ENCRYPTION_KEY` stored in Render secret env (never committed)
- [ ] `ZEROG_STORAGE_PRIVATE_KEY` stored in Render secret env
- [ ] `PRIVY_APP_SECRET` stored in Render secret env
- [ ] Dev login endpoint returns 403 (tested with `NODE_ENV=production`)
- [ ] CORS origins in gateway set to your frontend domain only
- [ ] PostgreSQL not exposed externally (use internal URL)
- [ ] Redis not exposed externally (use internal URL)
