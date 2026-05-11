# agent-service

**Port: 8002**

Manages the full AI agent lifecycle. Agent creation runs a 0G pipeline with graceful fallbacks at each step — the agent is always saved to the database even if 0G Compute or 0G Storage are unavailable.

## Agent Creation Pipeline

| Step | 0G Service | Timeout | Fallback |
|------|-----------|---------|----------|
| 1. Personality traits | 0G Compute `zai-org/GLM-5.1-FP8` | 10s | Default trait values (all 50) |
| 2. Avatar generation | 0G Compute `z-image` | 20s | Skipped (opt-in via env var) |
| 3. Avatar upload | 0G Storage mainnet | — | Skipped if avatar not generated |
| 4. Metadata upload | 0G Storage mainnet | 10s | Skipped with warning |
| 5. DB persist | PostgreSQL | — | **Always runs** |
| 6. INFT mint trigger | NATS → inft-service | — | Event published if NATS available |

### Avatar Generation

Avatar generation via `z-image` is **disabled by default** because it is slow (5–30s) and consumes 0G Compute credits. Enable it explicitly:

```bash
ENABLE_AVATAR_GEN=true   # in .env
```

## API Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/agents` | JWT | Create agent — runs 0G pipeline |
| `GET` | `/agents` | **Public** | List agents (filter: `clan`, `archetype`, `page`, `limit`, `pageSize`) |
| `GET` | `/agents/:id` | **Public** | Full agent profile |
| `PUT` | `/agents/:id` | JWT | Update name / metadata |
| `DELETE` | `/agents/:id` | JWT | Retire agent |
| `POST` | `/agents/:id/train` | JWT | Queue training job |
| `GET` | `/agents/:id/training` | **Public** | Training job history |
| `GET` | `/agents/:id/memory` | **Public** | Memory summary (counts) |
| `POST` | `/agents/:id/clone` | JWT | Clone agent (re-runs full creation) |
| `GET` | `/agents/:id/evolution` | **Public** | Evolution status and eligibility |

> Read endpoints (`GET`) are public — no JWT required. Write endpoints require a valid JWT from the identity-service.

## Valid Enum Values

### `clan` (ClanType)
`CYBER` | `BIO` | `ARCANE` | `MECH` | `SHADOW`

### `archetype` (CombatArchetype)
`BERSERKER` | `TACTICIAN` | `DEFENDER` | `ASSASSIN` | `SUPPORT` | `HYBRID`

> **Note:** `STRATEGIST` and `WILDCARD` are **not** valid — they will cause a Prisma validation error.

### `evolutionStage` (EvolutionStage)
`GENESIS` | `AWAKENED` | `ASCENDED` | `LEGENDARY` | `MYTHIC`

## List Response Shape

```json
{
  "agents": [ { "id": "...", "name": "...", "clan": "CYBER", "eloRating": 1000, ... } ],
  "total": 42
}
```

## Environment Variables

```bash
PORT=8002
DATABASE_URL=postgresql://...
NATS_URL=nats://localhost:4222
JWT_SECRET=...                            # Must match identity-service

# 0G Compute
ZEROG_COMPUTE_API_KEY=sk-...
ZEROG_COMPUTE_BASE_URL=https://router-api.0g.ai/v1
ZEROG_MODEL_CHAT=zai-org/GLM-5.1-FP8
ZEROG_MODEL_IMAGE=z-image

# 0G Storage
ZEROG_STORAGE_PRIVATE_KEY=0x...
ZEROG_NETWORK=mainnet

# Feature flags
ENABLE_AVATAR_GEN=false                   # true = generate+upload avatar at creation
```
