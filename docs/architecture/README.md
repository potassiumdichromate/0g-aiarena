# AI Arena — System Architecture

## Overview

AI Arena is a decentralised Web3 AI gaming platform built on the **0G ecosystem** (official partner).
Players own AI agents as ERC-7857 Living NFTs (INFTs), battle them in real-time, and train them
using on-chain verified ML pipelines. All AI compute, file storage, and NFT identity run on 0G infrastructure.

---

## High-Level System Diagram

```
                    ┌──────────────────────────────────────────────────────┐
                    │                    CLIENT LAYER                      │
                    │  Next.js 14 Web App  │  Unity SDK (C#)  │  Unreal SDK (C++)  │
                    └──────────┬───────────────┴──────────────┬────────────┘
                               │                               │
                    ┌──────────▼───────────────────────────────▼────────────┐
                    │               API GATEWAY  :8000                      │
                    │         JWT Auth │ Rate Limit │ Service Routing        │
                    └──────┬──────────┬──────────┬──────────┬───────────────┘
                           │          │          │          │
              ┌────────────▼─┐  ┌─────▼──────┐  │  ┌───────▼────────┐
              │ identity-svc │  │ agent-svc  │  │  │ battle-svc     │
              │    :8001     │  │   :8002    │  │  │   :8021        │
              └──────────────┘  └─────┬──────┘  │  └───────┬────────┘
                                      │          │          │
              ┌───────────────────────▼──────────▼──────────▼────────────────────────────┐
              │                        CORE SERVICES                                      │
              │  matchmaking :8020  │  memory :8014   │  inference :8013  │  telemetry :8010  │
              │  training    :8012  │  replay :8022   │  inft      :8032  │  anticheat :8024  │
              │  embedding   :8015  │  storage:8042   │  leaderboard:8041 │  tournament:8023  │
              └──────────────────────────────────────────────────────────────────────────┘
                           │                    │                    │
              ┌────────────▼────────────────────▼────────────────────▼──────────────────┐
              │                       INFRASTRUCTURE                                     │
              │  PostgreSQL 16  │  ClickHouse 24  │  Redis 7  │  NATS JetStream         │
              │  Qdrant 1.8 (vector search)                                              │
              └──────────────────────────────────────────────────────────────────────────┘
                           │
              ┌────────────▼──────────────────────────────────────────────────────────┐
              │                     OBSERVABILITY                                      │
              │  Prometheus :9090 (metrics)  │  Grafana :3001 (dashboards)            │
              │  Jaeger     :16686 (traces)  │  OTLP gRPC :4317 (trace ingest)        │
              └───────────────────────────────────────────────────────────────────────┘
                           │                    │
              ┌────────────▼────────────────────▼──────────────────────────────────────┐
              │                       0G ECOSYSTEM (mainnet)                            │
              │                                                                         │
              │  0G Compute Router  https://router-api.0g.ai/v1                        │
              │  ├── Chat:  zai-org/GLM-5.1-FP8, deepseek/deepseek-chat-v3-0324        │
              │  │          qwen/qwen3-vl-30b-a3b-instruct, qwen3.6-plus               │
              │  ├── Image: z-image  (avatar generation, b64_json)                     │
              │  └── Audio: openai/whisper-large-v3                                    │
              │                                                                         │
              │  0G Storage  https://indexer-storage-turbo.0g.ai                       │
              │  ├── Agent avatars      (PNG, rootHash in storage_index)               │
              │  ├── Agent metadata     (JSON blob, rootHash → INFT encryptedMeta)     │
              │  ├── Memory snapshots   (JSON, rootHash → INFT memoryRootHash on-chain)│
              │  ├── LoRA model weights (tar.gz, rootHash → INFT modelRootHash)        │
              │  ├── Training datasets  (JSONL, rootHash in job config)                │
              │  └── Battle replays     (JSON, rootHash in Battle DB record)           │
              │                                                                         │
              │  0G Chain (EVM)  Chain ID 16661  https://evmrpc.0g.ai                  │
              │  ├── AIArenaINFT.sol  (ERC-7857 Living NFT)                            │
              │  ├── AgentRegistry.sol (UUID → tokenId mapping)                        │
              │  └── ModuleMarketplace.sol (skill module trading)                      │
              └─────────────────────────────────────────────────────────────────────────┘
                           │
              ┌────────────▼──────────────────────────────────────────────────────────┐
              │                      BLOCKCHAIN LAYER                                  │
              │  Solana Programs (Anchor)                                              │
              │  ├── agent-wallet    (PDA wallets, daily spend limits)                │
              │  ├── escrow-vault    (battle stakes: Open→Funded→Locked→Settled)      │
              │  ├── tournament      (bracket management, prize distribution)          │
              │  └── staking         (ARENA token staking + rewards)                  │
              └───────────────────────────────────────────────────────────────────────┘
```

---

## 0G Storage — Content-Addressing Pattern

**Critical concept:** 0G Storage is Merkle-root-addressed. Files have **no path strings on-chain**.

```
upload(data) → rootHash (hex string)
download(rootHash) → data
```

AI Arena bridges this with a `storage_index` PostgreSQL table:

```
logical_path                              →  rootHash
─────────────────────────────────────── ── ─────────────────────────────────────
agents/{id}/avatar/v1                    →  0xabc123...
agents/{id}/metadata/v1                  →  0xdef456...
agents/{id}/memory/snapshot-latest       →  0x789abc...
agents/{id}/memory/snapshot-{timestamp}  →  0x...  (versioned history)
agents/{id}/memory/episodes/{memoryId}   →  0x...
agents/{id}/models/v{n}                  →  0x...  (LoRA weights)
training/{agentId}/datasets/{timestamp}  →  0x...  (JSONL for fine-tuning)
replays/{battleId}                       →  0x...
battles/{battleId}/result                →  0x...
```

The `rootHash` is also stored **on-chain** in the INFT:
- `memoryRootHash` (bytes32) — updated after each memory compaction
- `modelRootHash` (string)  — updated after each fine-tune delivery

---

## Data Flow: Agent Creation

```
POST /agents
   │
   ├─ 1. 0G Compute: generatePersonality({name, clan, description})
   │       → structured trait vector (aggression, intelligence, etc.)
   │
   ├─ 2. 0G Compute: generateAvatar({agentId, archetype, clan, evolutionStage: 1})
   │       → b64_json PNG (model: z-image)
   │
   ├─ 3. 0G Storage: upload(avatarPNG)
   │       → avatarRootHash
   │       → stored in storage_index: agents/{id}/avatar/v1
   │
   ├─ 4. 0G Storage: upload(metadataJSON)
   │       → metadataRootHash
   │       → stored in storage_index: agents/{id}/metadata/v1
   │
   ├─ 5. PostgreSQL: create Agent record
   │       → metadata.avatarRootHash, metadata.metadataRootHash
   │
   └─ 6. NATS: publish AGENT_CREATED { agentId, metadataRootHash, avatarRootHash }
           → inft-service subscribes → mints ERC-7857 INFT on 0G Chain
```

---

## Data Flow: Battle Lifecycle

```
1.  Player joins queue      → matchmaking-service    → Redis ZADD by ELO
2.  Match found             → NATS: match.found       → battle-service
3.  Battle created          → NATS: battle.created    → all subscribers
4.  Unity: StartBattle      → battle-service POST      → returns battleId
5.  Unity: TelemetryBatch   → telemetry-service POST   → ClickHouse + NATS
6.  Unity: GetNextAction    → inference-service POST   → 0G Compute (GLM-5.1-FP8)
                                                       → tool_choice: required
                                                       → TEE proof if ZEROG_VERIFY_TEE=true
7.  Battle ends             → battle-service.endBattle()
    │
    ├─ 7a. 0G Storage: upload(battleResultJSON)  → resultRootHash
    │
    ├─ 7b. NATS: BATTLE_ENDED { battleId, winnerId, actionLog, seed, resultRootHash }
    │
    ├─ 7c. replay-service:
    │       → upload(replayBlob) to 0G Storage    → replayRootHash
    │       → verify: SHA256(seed + actionLog) === finalStateHash
    │       → update Battle.replayId = replayRootHash
    │
    ├─ 7d. memory-service (for each participant):
    │       → storeEpisode() → Postgres + Qdrant + 0G Storage episode snapshot
    │       → compactMemory() → serialize all memories → 0G Storage
    │                        → rootHash → INFT updateMemoryRoot() on-chain
    │
    ├─ 7e. inft-service:
    │       → recordBattleResult(tokenId, won, eloChange) on 0G Chain
    │       → updateMemoryRoot(tokenId, newRootHash) on 0G Chain
    │
    └─ 7f. financial-service:
            → settle Solana escrow → transfer $ARENA to winner
```

---

## Data Flow: Agent Training (0G Fine-Tuning)

```
POST /training/jobs { agentId, trainingData: [...state-action pairs] }
   │
   ├─ 1. training-service:
   │     → serialise trainingData → JSONL
   │     → 0G Storage: upload(JSONL) → datasetRootHash
   │     → store in storage_index: training/{agentId}/datasets/{ts}
   │     → create TrainingJob { config.datasetRootHash }
   │     → NATS: TRAINING_QUEUED { jobId, datasetRootHash, baseModel }
   │
   ├─ 2. training-worker (Python):
   │     → download JSONL from 0G Storage by datasetRootHash
   │     → submit to 0G Compute CLI:
   │         0g-compute-cli fine-tuning create-task \
   │           --provider <ADDR> --model Qwen2.5-0.5B-Instruct \
   │           --dataset-path dataset.jsonl --config-path config.json
   │     → poll until status = Delivered
   │     → CRITICAL: acknowledge within 48h (avoid 30% fee penalty)
   │     → download fine-tuned model
   │     → 0G Storage: upload(model.tar.gz) → modelRootHash
   │
   └─ 3. training-service.completeJob():
         → create AIModel { loraAdapterPath: modelRootHash, isActive: true }
         → storage_index: agents/{id}/models/v{n} → modelRootHash
         → NATS: TRAINING_COMPLETED { modelRootHash }
         → inft-service: updateModelRoot(tokenId, modelRootHash) on 0G Chain
```

---

## Data Flow: Memory System

```
4-tier memory architecture:

Tier 1 — Working (Redis, TTL=1h)
  → Per-battle real-time state, sub-ms access
  → Cleared after battle ends

Tier 2 — Episodic (PostgreSQL + Qdrant)
  → Battle episode records, importance-scored
  → BGE-M3 1024-dim vectors in Qdrant for RAG retrieval
  → Each episode ALSO uploaded to 0G Storage as episode snapshot

Tier 3 — Semantic (Qdrant)
  → Abstracted patterns from multiple episodes
  → Enables cross-battle learning

Tier 4 — Procedural (0G Storage)
  → Full serialised memory snapshots (up to 500 most important records)
  → Called after every battle (compactMemory)
  → rootHash anchored on-chain via INFT.updateMemoryRoot()
  → Versioned history: agents/{id}/memory/snapshot-{timestamp}
  → Used for: cold-start recovery, fine-tuning dataset prep, anti-cheat audit
```

---

## Service Inventory

### Deployed Services (Render production)

| Service | Responsibility |
|---------|----------------|
| api-gateway | JWT auth, rate limiting (500 req/min default), x402 middleware, routing |
| identity-service | Privy auth, JWT issuance, user profiles |
| agent-service | Agent CRUD, 0G avatar/metadata upload, training job management |
| financial-service | Wallets, ledger, spending policies, escrow, x402 payment processing |
| battle-service | Battle lifecycle, ELO computation, 0G result archival |
| matchmaking-service | ELO-based queue matching, autonomous battle loop, stale battle cleanup |
| token-service | $ARENA token, bridge deposits, reserve management |
| leaderboard-service | Redis sorted-set leaderboards |
| inft-service | ERC-7857 INFT — mint, evolve, anchor memory/model hashes |
| inference-service | 0G Compute Router — combat action inference, strategy planning |
| memory-service | 4-tier memory: Redis + PostgreSQL + Qdrant + 0G Storage snapshots |

### Additional Services (in monorepo, deployable independently)

| Service | Responsibility |
|---------|----------------|
| telemetry-service | Real-time event ingestion → ClickHouse |
| behaviour-service | Trait analysis, archetype classification |
| training-service | Training job queue + 0G Compute dispatch (routes proxied via agent-service) |
| embedding-service | BGE-M3 embedding generation → Qdrant |
| replay-service | Replay upload/download/verify via 0G Storage |
| tournament-service | Tournament brackets, prize distribution |
| anticheat-service | Deterministic replay verification |
| wallet-service | Solana agent wallet management |
| escrow-service | Solana battle escrow lifecycle |
| payment-service | x402 payments, cross-chain routing |
| analytics-service | ClickHouse queries, meta-game analysis |
| storage-service | 0G Storage API (path→rootHash abstraction) |
| notification-service | Push, WebSocket, email notifications |
| game-service | Game registry, intelligence layer config |

---

## Key Design Decisions

### Why content-addressed storage (0G Storage)?
Files on 0G Storage are identified by Merkle root hash — immutable and verifiable.
This means replay data, model weights, and memory snapshots can be proven on-chain.
The `storage_index` Postgres table bridges logical paths to root hashes for services.

### Why ERC-7857 (not ERC-721)?
ERC-7857 adds AI-specific extensions: oracle-managed key re-encryption on ownership transfer,
`authorizeUsage()` for granting inference rights, and `clone()` for spawning child agents.
The `sealedKey` on-chain ensures only the current owner can decrypt agent metadata.

### Why 0G Compute for Inference?
OpenAI-compatible API backed by decentralised GPU nodes. `tool_choice: required` gives
structured output for combat actions — no free-text parsing. TEE-verifiable execution
(`verify_tee: true`) provides cryptographic proof of correct AI execution for disputes.

### Why Solana for Escrow?
400ms finality + ~$0.0001/tx for high-frequency battle settlements. Anchor PDAs give
deterministic agent wallet addresses without off-chain state.

### Memory Architecture (4-tier)
Redis → Postgres/Qdrant → Qdrant → 0G Storage.
Each tier trades latency for durability. 0G Storage provides the immutable archive layer
with on-chain anchoring, making agent memory verifiable and portable across ownership transfers.

### Fine-Tuning Model Constraints
0G Compute fine-tuning only supports **Qwen2.5-0.5B-Instruct** and **Qwen3-32B**.
These are submitted via CLI (`@0gfoundation/0g-compute-ts-sdk`), not REST API.
Fine-tuned model weights are uploaded to 0G Storage and the rootHash is anchored in the INFT.

---

## Database Strategy

| Store | Role | Why |
|-------|------|-----|
| PostgreSQL 16 | Primary transactional store | ACID, Prisma ORM, relational integrity |
| ClickHouse 24 | Time-series telemetry + analytics | Column-store, 100x faster aggregations over millions of events vs Postgres |
| Redis 7 | Working memory, queues, leaderboards, distributed rate-limit store | Sub-ms access, sorted sets for ELO queues |
| Qdrant 1.8 | Vector search | ANN index for RAG memory retrieval |
| NATS JetStream | Event bus + durable messaging | At-least-once delivery, replay, fan-out |

**TimescaleDB was removed** — it duplicated ClickHouse for time-series data with no added benefit.
ClickHouse handles all time-series workloads (telemetry events, battle metrics, training runs) with
far superior query performance on large datasets.

---

## Observability Stack

```
Service → OTLP gRPC (:4317) → Jaeger (distributed traces)
Service → GET /metrics        → Prometheus (:9090) → Grafana (:3001)
Service → Sentry DSN          → Sentry (error tracking)
```

| Tool | Port | Purpose |
|------|------|---------|
| Prometheus | 9090 | Metrics scrape + storage (30-day retention) |
| Grafana | 3001 | Dashboards — latency, throughput, error rates, 0G usage |
| Jaeger | 16686 | Distributed traces — full request lifecycle across services |

Every service exports:
- **Traces**: via `@opentelemetry/auto-instrumentations-node` → Jaeger OTLP gRPC
- **Metrics**: `GET /metrics` endpoint scraped by Prometheus
- **Logs**: structured JSON (pino) → captured by docker/k8s log driver

---

## Security Architecture

### Rate Limiting (multi-layer)

```
Edge (Cloudflare / nginx)
  └─ connection-rate limit per IP
       └─ API Gateway (@fastify/rate-limit, Redis-backed)
            ├─ Global:   500 req / 60s  per wallet address or IP  (env: RATE_LIMIT_MAX)
            └─ /v1/auth: 10  req / 60s  per IP  (brute-force protection)
```

Rate limit state is stored in **Redis** — all gateway instances share the same counters,
so limits are enforced correctly in horizontally-scaled deployments.

### DDoS Protection
- **Edge**: deploy behind Cloudflare (Free tier: L3/L4 volumetric DDoS, WAF rules)
  or nginx `limit_conn` + `limit_req` modules before traffic reaches the gateway.
- **Body size cap**: `bodyLimit: 1 MB` on the API gateway — oversized requests are
  rejected before reaching service logic (memory-exhaustion protection).
- **Timeouts**: `connectionTimeout: 60s`, `requestTimeout: 60s` — drops slow-loris connections.
- **Helmet**: security headers on every response (X-Frame-Options, HSTS in production, etc.).

### Auth
- SIWE (Sign-In With Ethereum) — wallet-based, no password storage
- Short-lived JWT access tokens (15 min) + refresh tokens (7 days)
- JWT secret ≥ 32 chars, rotatable via env var
