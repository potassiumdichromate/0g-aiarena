# AI Arena — System Architecture

## Overview

AI Arena is a decentralised Web3 AI gaming platform where players own AI agents as NFTs (INFTs),
battle them in real-time, and train them using on-chain verified ML pipelines backed by the 0G ecosystem.

## High-Level System Diagram

```
                          ┌─────────────────────────────────────────────────────┐
                          │                  CLIENT LAYER                       │
                          │   Next.js Web App    │    Unity SDK (C#)            │
                          └──────────┬───────────┴──────────────┬───────────────┘
                                     │                           │
                          ┌──────────▼──────────────────────────▼───────────────┐
                          │                  API GATEWAY (Kong)                 │
                          │          JWT Auth │ Rate Limit │ Routing             │
                          └──────────┬────────────────────────────────┬──────────┘
                                     │                                │
           ┌─────────────────────────┼────────────────────┐          │
           │                         │                    │          │
  ┌────────▼──────┐  ┌───────────────▼────┐  ┌───────────▼────┐    │
  │ identity-svc  │  │   agent-service     │  │ battle-service  │    │
  │ (SIWE / JWT)  │  │ (CRUD + evolution)  │  │ (orchestration) │    │
  └───────────────┘  └────────────────────┘  └────────────────┘    │
                                                       │             │
  ┌─────────────────────────────────────────────────────┼────────────▼───────────┐
  │                        CORE SERVICES                │                        │
  │  matchmaking-svc  memory-svc  inference-svc  leaderboard-svc  telemetry-svc  │
  └──────────────────────────────────────────────────────────────────────────────┘
           │                │              │                  │
  ┌────────▼────────────────▼──────────────▼──────────────────▼──────────────────┐
  │                          INFRASTRUCTURE LAYER                                 │
  │  PostgreSQL 16  │  TimescaleDB  │  ClickHouse  │  Redis 7  │  NATS JetStream  │
  │  (primary DB)   │  (time-series)│  (analytics) │  (cache)  │  (event bus)     │
  │                                                                                │
  │  Qdrant (vector search)  │  0G Storage (file blobs)  │  0G Compute (LLM API) │
  └────────────────────────────────────────────────────────────────────────────────┘
           │                                │
  ┌────────▼────────────────────────────────▼──────────────────────────────────────┐
  │                          BLOCKCHAIN LAYER                                       │
  │  Solana Programs (Anchor)                │  EVM Contracts (0G Chain)            │
  │  - agent-wallet (PDAs, daily spend limit)│  - AIArenaINFT.sol (ERC-721)        │
  │  - escrow-vault (battle stakes)          │  - AgentRegistry.sol (ELO registry) │
  │  - tournament (bracket management)       │  - ModuleMarketplace.sol            │
  │  - staking (ARENA token staking)         │                                      │
  └────────────────────────────────────────────────────────────────────────────────┘
```

## Service Inventory

| Service | Port | Responsibility |
|---|---|---|
| identity-service | 3001 | SIWE authentication, JWT issuance |
| agent-service | 3002 | Agent CRUD, evolution, training queueing |
| game-service | 3003 | Game definitions, intelligence layers |
| battle-service | 3004 | Battle lifecycle orchestration |
| matchmaking-service | 3005 | ELO-based queue matching |
| telemetry-service | 3006 | Telemetry ingestion + TimescaleDB |
| inference-service | 3007 | Combat action inference via 0G Compute |
| memory-service | 3008 | Agent memory CRUD + Qdrant search |
| leaderboard-service | 3009 | Redis sorted-set leaderboards |
| training-service | 3010 | Training job management |
| behaviour-service | 3011 | Trait analysis + archetype classification |
| embedding-service | 3012 | BGE-M3 embedding generation |
| replay-service | 3013 | Replay storage + verification |
| settlement-service | 3014 | On-chain settlement coordination |
| tournament-service | 3015 | Tournament brackets |
| inft-service | 3016 | NFT minting + metadata |
| payment-service | 3017 | Deposits, withdrawals, x402 protocol |
| notification-service | 3018 | Push notifications |
| analytics-service | 3019 | ClickHouse queries |
| moderation-service | 3020 | Dispute resolution |

## Data Flow: Battle Lifecycle

```
1. Player joins queue         → matchmaking-service   → Redis ZADD by ELO
2. Match found                → NATS: match.found      → battle-service
3. Battle created             → NATS: battle.created   → all subscribers
4. Unity SDK: StartBattle     → battle-service POST     → returns battleId
5. Unity SDK: TelemetryBatch  → telemetry-service POST  → TimescaleDB + NATS
6. Unity SDK: GetNextAction   → inference-service POST  → 0G Compute → action
7. Battle ends                → NATS: battle.ended     → settlement-service
8. Settlement worker          → Solana escrow settle    → on-chain transfer
9. Agent ELO update           → agent-service PATCH     → PostgreSQL + EVM
10. Memory stored             → memory-service POST     → Qdrant upsert
```

## Key Design Decisions

### Why 0G Compute for Inference?
Real-time battle inference requires sub-50ms response times. 0G Compute provides an
OpenAI-compatible API backed by decentralised GPU nodes, enabling verifiable AI inference
without centralised trust. The inference-service caches responses in Redis (1s TTL) to
handle burst loads.

### Why Solana for Escrow + Staking?
Solana's 400ms finality and ~$0.0001 transaction cost make it ideal for high-frequency
battle settlements. Anchor PDAs provide deterministic address derivation for agent wallets
without off-chain storage.

### Why 0G Chain (EVM) for NFTs?
AI Arena INFTs are ERC-721 tokens with on-chain trait registries and memory root anchoring.
The EVM compatibility of 0G Chain enables standard NFT marketplaces while keeping gas costs
low via 0G's data availability layer.

### Memory Architecture
Agent memories flow through three tiers:
1. Working memory (Redis, TTL=1h) — fast access during battles
2. Long-term memories (PostgreSQL) — persistent structured records
3. Semantic embeddings (Qdrant) — BGE-M3 1024-dim vectors for similarity search

This enables agents to "remember" past opponents and adapt strategies using semantic retrieval.
