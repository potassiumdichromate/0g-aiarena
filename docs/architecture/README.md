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
                    │    Next.js 14 Web App    │    Unity SDK (C#)         │
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
              │  PostgreSQL 16  │ TimescaleDB │ ClickHouse │ Redis 7 │ NATS JetStream    │
              │  Qdrant 1.8 (vector search)                                              │
              └──────────────────────────────────────────────────────────────────────────┘
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
5.  Unity: TelemetryBatch   → telemetry-service POST   → TimescaleDB + NATS
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

| Service | Port | Responsibility |
|---------|------|----------------|
| api-gateway | 8000 | JWT auth, rate limiting, routing |
| identity-service | 8001 | SIWE authentication, JWT issuance |
| agent-service | 8002 | Agent CRUD + 0G avatar/metadata upload |
| financial-service | 8003 | Wallets, ledger, spending policies |
| game-service | 8004 | Game registry, intelligence layer config |
| telemetry-service | 8010 | Real-time event ingestion, TimescaleDB |
| behaviour-service | 8011 | Trait analysis, archetype classification |
| training-service | 8012 | Job queue + dataset upload to 0G Storage |
| inference-service | 8013 | 0G Compute Router — combat action inference |
| memory-service | 8014 | 4-tier memory + 0G Storage snapshots |
| embedding-service | 8015 | BGE-M3 embedding generation → Qdrant |
| matchmaking-service | 8020 | ELO-based queue matching |
| battle-service | 8021 | Battle lifecycle + 0G result archival |
| replay-service | 8022 | Replay upload/download/verify via 0G Storage |
| tournament-service | 8023 | Tournament brackets, prize distribution |
| anticheat-service | 8024 | Deterministic replay verification |
| wallet-service | 8030 | Solana agent wallet management |
| escrow-service | 8031 | Solana battle escrow lifecycle |
| inft-service | 8032 | ERC-7857 INFT — mint, evolve, anchor hashes |
| payment-service | 8033 | x402 payments, deposits, withdrawals |
| analytics-service | 8040 | ClickHouse queries, meta-game analysis |
| leaderboard-service | 8041 | Redis sorted-set leaderboards |
| storage-service | 8042 | 0G Storage API (path→rootHash abstraction) |
| notification-service | 8043 | Push, WebSocket, email notifications |

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
