# AI Arena — Web3 AI Gaming Platform

AI Arena is a production-grade Web3 gaming platform where AI agents compete in strategic battles, evolve through machine learning, and are represented as on-chain assets. Built on the 0G decentralised AI network, Solana blockchain, and a microservices architecture.

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Tech Stack](#tech-stack)
3. [Monorepo Structure](#monorepo-structure)
4. [Quick Start (Local Dev)](#quick-start-local-dev)
5. [Environment Setup](#environment-setup)
6. [Service Descriptions](#service-descriptions)
7. [Smart Contract Deployment](#smart-contract-deployment)
8. [Unity SDK Integration](#unity-sdk-integration)
9. [0G Ecosystem Integration](#0g-ecosystem-integration)
10. [$ARENA Token Integration](#arena-token-integration)
11. [Deployment Guide](#deployment-guide)
12. [Architecture Diagrams](#architecture-diagrams)

---

## Project Overview

AI Arena enables game developers to integrate AI-powered agents that:
- **Learn** from gameplay telemetry via behaviour cloning and reinforcement learning
- **Remember** battles using a hybrid memory system (working, episodic, semantic)
- **Evolve** through on-chain NFT trait mutation (INFT standard, ERC-7857)
- **Earn** $ARENA tokens through ranked battles and tournaments
- **Compete** in wager battles with Solana-secured escrow

The platform is designed as a B2B SDK — game developers integrate the Unity SDK and connect their game to the AI Arena backend. Players own their AI agents as NFTs.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 14, React 18, Tailwind CSS, Privy (wallet auth) |
| API Gateway | Fastify 4 + `@fastify/http-proxy` (Redis-optional rate limiting) |
| Microservices | Node.js 20 + Fastify 4 + TypeScript 5 |
| ML Workers | Python 3.11 + PyTorch 2 + Ray + PEFT/TRL |
| Databases | PostgreSQL 16, TimescaleDB, ClickHouse 24 |
| Cache | Redis 7 (optional for local dev — gateway falls back to in-memory) |
| Message Bus | NATS 2.10 JetStream |
| Vector DB | Qdrant v1.8 |
| AI Compute | 0G Compute Network (OpenAI-compatible router at `router-api.0g.ai`) |
| AI Storage | 0G Storage Network (content-addressed by Merkle root hash) |
| Blockchain (L2) | 0G Chain (EVM, Chain ID 16661) — INFT + agent registry contracts |
| Blockchain (L1) | Solana (devnet/mainnet) — wallets, escrow, tournament, staking |
| Smart Contracts | Anchor (Solana), Hardhat (EVM/Solidity) |
| Unity SDK | C# (.NET Standard 2.1) |
| Infrastructure | GKE, Terraform, Helm, Kustomize |
| Monorepo | pnpm workspaces + Turborepo |

---

## Monorepo Structure

```
0g-AIArena/
├── apps/
│   └── web/                    # Next.js 14 dashboard + player portal (port 3000)
├── services/                   # 24 microservices (Node.js/Fastify)
│   ├── api-gateway/            # Central proxy, rate limiting, CORS (port 8000)
│   ├── identity-service/       # Privy auth, JWT issuance, user profiles (port 8001)
│   ├── agent-service/          # Agent lifecycle, 0G generation, evolution (port 8002)
│   ├── financial-service/      # Wallets, spending policies, ledger (port 8003)
│   ├── game-service/           # Game registry, intelligence layers (port 8004)
│   ├── telemetry-service/      # Real-time telemetry ingestion (port 8010)
│   ├── behaviour-service/      # Behaviour analysis, trait extraction (port 8011)
│   ├── training-service/       # Training job orchestration (port 8012)
│   ├── inference-service/      # Real-time AI inference gateway (port 8013)
│   ├── memory-service/         # Hybrid memory system (RAG) (port 8014)
│   ├── embedding-service/      # Text/vector embedding proxy (port 8015)
│   ├── matchmaking-service/    # ELO-based matchmaking (port 8020)
│   ├── battle-service/         # Battle room orchestration (port 8021)
│   ├── replay-service/         # Deterministic replay storage (port 8022)
│   ├── tournament-service/     # Tournament brackets (port 8023)
│   ├── anticheat-service/      # Action validation, anomaly detection (port 8024)
│   ├── wallet-service/         # Solana PDA wallet management (port 8030)
│   ├── escrow-service/         # Battle escrow lifecycle (port 8031)
│   ├── inft-service/           # INFT minting and evolution (port 8032)
│   ├── payment-service/        # x402 + cross-chain payments (port 8033)
│   ├── analytics-service/      # ClickHouse analytics queries (port 8040)
│   ├── leaderboard-service/    # Redis sorted set leaderboards (port 8041)
│   ├── storage-service/        # 0G Storage file management (port 8042)
│   └── notification-service/   # Push, WebSocket, email notifications (port 8043)
├── workers/
│   ├── training-worker/        # Python Ray GPU training worker
│   ├── embedding-worker/       # Python BGE-M3 embedding worker
│   ├── behaviour-worker/       # Python Kafka consumer + feature extraction
│   └── settlement-worker/      # TypeScript Solana settlement executor
├── packages/
│   ├── shared-types/           # All TypeScript type definitions
│   ├── shared-utils/           # ELO, crypto, validation, retry utilities
│   ├── db-client/              # Prisma schema + repository classes
│   ├── zerog-client/           # 0G Storage + Compute SDK wrapper
│   ├── solana-client/          # Solana/Anchor client library
│   ├── event-bus/              # NATS JetStream wrapper
│   ├── cache/                  # Redis wrapper with typed keys
│   ├── vector-db/              # Qdrant client wrapper
│   └── telemetry-protocol/     # Event schemas + serializer
├── contracts/
│   ├── solana/                 # Anchor programs (Rust)
│   │   ├── agent-wallet/       # Agent wallet PDA + spending policy
│   │   ├── escrow-vault/       # Battle escrow vault
│   │   ├── tournament/         # Tournament prize distribution
│   │   └── staking/            # $ARENA staking
│   └── evm/                    # Solidity contracts (Hardhat)
│       ├── AIArenaINFT.sol     # ERC-721 + ERC-7857 INFT
│       ├── AgentRegistry.sol   # On-chain agent registry
│       └── ModuleMarketplace.sol
├── unity/
│   └── AIArenaSDK/             # Unity C# SDK package
├── ml/
│   ├── behaviour_cloning/      # BC training scripts
│   ├── reinforcement_learning/ # PPO with Ray RLlib
│   ├── feature_extraction/     # Telemetry feature pipeline
│   ├── embedding_generation/   # BGE-M3 embedding scripts
│   └── anomaly_detection/      # IsolationForest anomaly scorer
├── infra/
│   ├── k8s/                    # Kubernetes manifests (Kustomize)
│   ├── helm/                   # Helm chart for full stack
│   └── terraform/              # GCP/GKE infrastructure as code
└── docs/
    ├── architecture/           # System architecture docs + diagrams
    ├── api/                    # API reference + OpenAPI spec
    └── sdk/                    # Unity SDK integration guide
```

---

## Quick Start (Local Dev)

### Prerequisites

- Node.js >= 20.0.0
- pnpm >= 9.0.0
- Docker + Docker Compose (for PostgreSQL, Redis, NATS)
- Rust + Anchor CLI (only if working on Solana contracts)

### 1. Clone and install

```bash
git clone https://github.com/your-org/0g-AIArena.git
cd 0g-AIArena
pnpm install
```

### 2. Start infrastructure

```bash
docker-compose up -d
# Starts: PostgreSQL, Redis, NATS, Qdrant
```

### 3. Configure environment

```bash
cp .env.example .env
# Fill in at minimum: DATABASE_URL, JWT_SECRET
# See Environment Setup section below for 0G keys
```

### 4. Run database migrations

```bash
pnpm db:migrate
pnpm db:generate
```

### 5. Start all services

```bash
pnpm dev
# Starts all services via Turborepo in parallel
# Frontend: http://localhost:3000
# API Gateway: http://localhost:8000
```

### 6. Authenticate (Dev Login — no wallet needed)

The frontend includes a **⚡ Dev** button in the top-right nav bar. Click it to:
- Auto-create a dev user in the database
- Store a valid JWT in `localStorage`
- Unlock all authenticated features (agent creation, battles, etc.)

> **Note:** Dev login is only available when `NODE_ENV !== 'production'`. It calls `POST /v1/auth/dev-login` on the identity service.

### 7. Create your first agent

Navigate to `http://localhost:3000/agents` → **Create Agent** → fill in name, clan, archetype → submit.

Agent creation flow:
1. Personality traits generated via 0G Compute (10s timeout, falls back to defaults)
2. Avatar generation **skipped** by default — set `ENABLE_AVATAR_GEN=true` in `.env` to enable (requires funded 0G Compute key)
3. Agent persisted to PostgreSQL
4. `AGENT_CREATED` event published → `inft-service` mints the ERC-7857 INFT on 0G Chain

### 8. Individual service dev

```bash
pnpm --filter @ai-arena/agent-service dev
pnpm --filter @ai-arena/shared-utils test
```

---

## Environment Setup

Copy `.env.example` to `.env` and configure the following:

### Core (required for basic local dev)

```bash
DATABASE_URL=postgresql://aiarena:aiarena@localhost:5432/aiarena
REDIS_URL=redis://localhost:6379
NATS_URL=nats://localhost:4222
JWT_SECRET=<run: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
```

> **Redis is optional for the API gateway** — it falls back to in-memory rate limiting automatically if Redis is unreachable.

### 0G Compute (required for personality generation + avatar gen)

1. Go to **https://pc.0g.ai** → Dashboard → API Keys
2. Create key with **inference** permission (format: `sk-xxxxxxxx`)
3. Deposit 0G tokens for billing (neuron units: 1 0G = 1e18 neuron)

```bash
ZEROG_COMPUTE_API_KEY=sk-your-key
ZEROG_COMPUTE_BASE_URL=https://router-api.0g.ai/v1
ZEROG_MODEL_CHAT=zai-org/GLM-5.1-FP8
ZEROG_MODEL_IMAGE=z-image

# Set to true to enable avatar image generation on agent creation (slow, uses credits)
ENABLE_AVATAR_GEN=false
```

**Available inference models:**

| Model | Type | Notes |
|---|---|---|
| `zai-org/GLM-5.1-FP8` | Chat | Default — recommended |
| `deepseek/deepseek-chat-v3-0324` | Chat | Strong reasoning |
| `qwen/qwen3-vl-30b-a3b-instruct` | Chat | Multimodal |
| `z-image` | Image | Avatar generation (b64_json only) |
| `openai/whisper-large-v3` | Audio | Transcription |

### 0G Storage (required for avatar + metadata storage)

```bash
ZEROG_STORAGE_PRIVATE_KEY=0x_your_private_key
ZEROG_NETWORK=mainnet   # or testnet
```

### EVM Contracts (deployed on 0G mainnet)

```bash
ZEROG_INFT_CONTRACT_ADDRESS=0x67493Bb91e904840d39397E350f4A7865B779E10
ZEROG_INFT_ORACLE_ADDRESS=0x63F63DC442299cCFe470657a769fdC6591d65eCa
AGENT_REGISTRY_ADDRESS=0x0891Df42835c87F7A9309Ce021941D17Bf684d86
MODULE_MARKETPLACE_ADDRESS=0x69029db75c04B5322502bb82b78652f0273f8A12
```

### Solana Programs (deployed on devnet)

```bash
SOLANA_RPC_URL=https://api.devnet.solana.com
SOLANA_PRIVATE_KEY=<base58 private key>
USDC_MINT=6DnLV68ueFS1p36DW2ptcBVLMCnjPGAJrZ1RHzkgUw7J
USDT_MINT=HF2WSuyjqHMYmCHQgyXFMWra6E2VFaLcnhS645BthRr2
```

### Frontend (.env.local in apps/web/)

```bash
NEXT_PUBLIC_API_URL=http://localhost:8000
NEXT_PUBLIC_PRIVY_APP_ID=<from privy.io — optional, dev login works without it>
NEXT_PUBLIC_ZEROG_INFT_ADDRESS=0x67493Bb91e904840d39397E350f4A7865B779E10
NEXT_PUBLIC_AGENT_REGISTRY_ADDRESS=0x0891Df42835c87F7A9309Ce021941D17Bf684d86
```

---

## Service Descriptions

### Core Platform Services

| Service | Port | Responsibility |
|---|---|---|
| api-gateway | 8000 | Central proxy, rate limiting (Redis-optional), CORS |
| identity-service | 8001 | Privy auth, JWT issuance, user profiles, dev-login endpoint |
| agent-service | 8002 | Agent lifecycle, 0G generation (with timeouts), evolution |
| financial-service | 8003 | Wallets, spending policies, ledger |
| game-service | 8004 | Game registry, intelligence layer config |

### AI Pipeline Services

| Service | Port | Responsibility |
|---|---|---|
| telemetry-service | 8010 | Real-time event ingestion, WebSocket streaming |
| behaviour-service | 8011 | Feature extraction, trait classification |
| training-service | 8012 | Job queue, 0G Compute dispatch |
| inference-service | 8013 | Combat action inference, caching |
| memory-service | 8014 | Working/episodic/semantic memory + RAG |
| embedding-service | 8015 | BGE-M3 embedding proxy |

### Game Services

| Service | Port | Responsibility |
|---|---|---|
| matchmaking-service | 8020 | ELO window matching, queue management |
| battle-service | 8021 | Battle room orchestration, state broadcasting |
| replay-service | 8022 | Deterministic replay storage + verification |
| tournament-service | 8023 | Tournament brackets, prize distribution |
| anticheat-service | 8024 | Action validation, anomaly detection |

### Financial Services

| Service | Port | Responsibility |
|---|---|---|
| wallet-service | 8030 | Solana PDA wallet management |
| escrow-service | 8031 | Battle escrow lifecycle |
| inft-service | 8032 | INFT minting, metadata, evolution |
| payment-service | 8033 | x402 payments, cross-chain routing |

### Analytics & Infrastructure

| Service | Port | Responsibility |
|---|---|---|
| analytics-service | 8040 | ClickHouse queries, meta-game analysis |
| leaderboard-service | 8041 | Redis sorted set leaderboards |
| storage-service | 8042 | 0G Storage file management API |
| notification-service | 8043 | Push, WebSocket, email notifications |

---

## Smart Contract Deployment

### EVM Contracts (deployed on 0G Chain mainnet)

```
AIArenaINFT:        0x67493Bb91e904840d39397E350f4A7865B779E10
AgentRegistry:      0x0891Df42835c87F7A9309Ce021941D17Bf684d86
ModuleMarketplace:  0x69029db75c04B5322502bb82b78652f0273f8A12
Oracle (deployer):  0x63F63DC442299cCFe470657a769fdC6591d65eCa
```

To redeploy:

```bash
cd contracts/evm
pnpm install
npx hardhat compile
npx hardhat run scripts/deploy.ts --network zerog-mainnet
```

### Solana Programs (deployed on devnet)

All five programs are deployed. To initialise the token reserve (one-time setup):

```bash
cd packages/solana-client
node init-reserve.cjs
```

This runs 3 sequential steps: `initialize_reserve` → `initialize_usdc_vault` → `initialize_usdt_vault`.

To redeploy a program:

```bash
cd contracts/solana/arena-reserve  # or any other program dir
anchor build
anchor deploy --provider.cluster devnet
```

---

## Unity SDK Integration

### Installation

1. Copy `unity/AIArenaSDK/` into your Unity project's `Assets/` folder
2. Or use Unity Package Manager pointing to this repository

### Initialization

```csharp
using AIArena.SDK.Core;

public class GameManager : MonoBehaviour
{
    async void Start()
    {
        await AIArenaSDK.Instance.Initialize(new AIArenaConfig
        {
            ApiBaseUrl = "https://api.aiarena.gg",
            WebSocketUrl = "wss://api.aiarena.gg",
            GameId = "your-game-id",
            ApiKey = "your-api-key"
        });

        await SessionManager.Instance.StartSession(agentId: "agent-uuid");
    }
}
```

### Telemetry

```csharp
TelemetryCollector.Instance.RecordCombatAction(new CombatActionEvent
{
    AgentId = currentAgent.Id,
    ActionType = "ability_cast",
    Position = transform.position,
    Target = targetAgent.Id,
    Timestamp = Time.time
});

await TelemetryCollector.Instance.FlushAll();
```

---

## 0G Ecosystem Integration

AI Arena is an official 0G ecosystem partner. All AI infrastructure runs on 0G.

### 0G Compute Router
**Endpoint:** `https://router-api.0g.ai/v1` (OpenAI-compatible)
**Auth:** `sk-` API keys from pc.0g.ai → Dashboard → API Keys

Used for:
- **Personality Generation** — trait vectors at agent creation (`generatePersonality`) — 10s timeout
- **Combat Inference** — real-time action prediction (`inferCombatAction`) — TEE-verifiable with `verify_tee: true`
- **Strategy Planning** — multi-tick battle strategy at match start
- **Avatar Generation** — PNG via `z-image` model at agent creation (`ENABLE_AVATAR_GEN=true`) — 20s timeout
- **Audio Transcription** — battle commentary via Whisper

### 0G Storage
**Key fact:** Files are content-addressed by **Merkle root hash** — not path strings.

Pattern: `upload(data) → rootHash` → store `logicalPath → rootHash` in `storage_index` table → `download(rootHash)`

Used for: agent avatar PNGs, metadata blobs, LoRA weights, battle replays, training datasets.

### 0G Chain (EVM)
**Mainnet:** Chain ID `16661` | RPC `https://evmrpc.0g.ai` | Explorer `https://chainscan.0g.ai`

`AIArenaINFT.sol` implements **ERC-7857** (Living NFT):
- `transfer` — oracle TEE re-encrypts metadata for new owner
- `clone` — spawn child agent (max 3 per parent)
- `authorizeUsage` — grant inference rights to backend

---

## $ARENA Token Integration

```
Player Stakes $ARENA → Solana Staking Program
Battle Wager         → Solana Escrow Vault
Battle Win           → Escrow Settle → Winner's Wallet
Tournament Win       → Prize Pool Distribution
```

Configure `ARENA_FINANCE_API_URL` and `ARENA_FINANCE_API_KEY` to connect to the $ARENA backend.

---

## Deployment Guide

See `docs/DEPLOYMENT.md` for the full Kubernetes/Helm production deployment guide.

### Quick summary

```bash
# 1. Provision GCP infrastructure
cd infra/terraform/gcp && terraform apply

# 2. Configure kubectl
gcloud container clusters get-credentials ai-arena-cluster --region us-central1

# 3. Deploy with Helm
helm upgrade --install ai-arena infra/helm/ai-arena \
  -f infra/helm/ai-arena/values.prod.yaml \
  --namespace ai-arena --create-namespace
```

---

## Architecture Diagrams

See `docs/architecture/README.md` for full system architecture diagrams.

---

## Contributing

See `docs/CONTRIBUTING.md` for the contribution guide, code style requirements, and PR process.

## License

MIT — see LICENSE file.
