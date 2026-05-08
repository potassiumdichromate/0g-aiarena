# AI Arena — Web3 AI Gaming Platform

AI Arena is a production-grade Web3 gaming platform where AI agents compete in strategic battles, evolve through machine learning, and are represented as on-chain assets. Built on the 0G decentralized AI network, Solana blockchain, and a microservices architecture.

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
| Frontend | Next.js 14, React 18, Tailwind CSS, wagmi/viem |
| API Gateway | Kong (custom JWT auth plugin) |
| Microservices | Node.js 20 + Fastify 4 + TypeScript 5 |
| ML Workers | Python 3.11 + PyTorch 2 + Ray + PEFT/TRL |
| Databases | PostgreSQL 16, TimescaleDB, ClickHouse 24 |
| Cache | Redis 7 |
| Message Bus | NATS 2.10 JetStream |
| Vector DB | Qdrant v1.8 |
| AI Compute | 0G Compute Network (OpenAI-compatible API) |
| AI Storage | 0G Storage Network (decentralised file storage) |
| Blockchain (L2) | 0G Chain (EVM) — INFT contracts |
| Blockchain (L1) | Solana — wallets, escrow, tournament, staking |
| Smart Contracts | Anchor (Solana), Hardhat (EVM/Solidity) |
| Unity SDK | C# (.NET Standard 2.1) |
| Infrastructure | GKE, Terraform, Helm, Kustomize |
| Monorepo | pnpm workspaces + Turborepo |

---

## Monorepo Structure

```
0g-AIArena/
├── apps/
│   └── web/                    # Next.js 14 dashboard + player portal
├── services/                   # 24 microservices (Node.js/Fastify)
│   ├── identity-service/       # Auth (SIWE), JWT, user profiles
│   ├── agent-service/          # Agent lifecycle, evolution, versioning
│   ├── financial-service/      # Wallets, spending policies, ledger
│   ├── game-service/           # Game registry, intelligence layers
│   ├── telemetry-service/      # Real-time telemetry ingestion
│   ├── behaviour-service/      # Behaviour analysis, trait extraction
│   ├── training-service/       # Training job orchestration
│   ├── inference-service/      # Real-time AI inference gateway
│   ├── memory-service/         # Hybrid memory system (RAG)
│   ├── embedding-service/      # Text/vector embedding proxy
│   ├── matchmaking-service/    # ELO-based matchmaking
│   ├── battle-service/         # Battle room orchestration
│   ├── replay-service/         # Deterministic replay storage
│   ├── tournament-service/     # Tournament brackets
│   ├── anticheat-service/      # Action validation, anomaly detection
│   ├── wallet-service/         # Solana PDA wallet management
│   ├── escrow-service/         # Battle escrow lifecycle
│   ├── inft-service/           # INFT minting and evolution
│   ├── payment-service/        # x402 + cross-chain payments
│   ├── analytics-service/      # ClickHouse analytics queries
│   ├── leaderboard-service/    # Redis sorted set leaderboards
│   ├── storage-service/        # 0G Storage file management
│   └── notification-service/   # Push, WebSocket, email notifications
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
- Docker + Docker Compose
- Rust (for Solana contracts)
- Anchor CLI (for Solana contracts)
- Python 3.11+ (for ML workers)

### 1. Clone and install dependencies

```bash
git clone https://github.com/your-org/0g-AIArena.git
cd 0g-AIArena
pnpm install
```

### 2. Start infrastructure services

```bash
docker-compose up -d
# Wait for all services to be healthy
docker-compose ps
```

### 3. Set up environment variables

```bash
cp .env.example .env
# Edit .env with your values (especially 0G API keys, Solana keys)
```

### 4. Run database migrations

```bash
pnpm db:migrate
pnpm db:generate
```

### 5. Start all services in development mode

```bash
pnpm dev
```

This starts all services in parallel using Turborepo. The web app will be available at http://localhost:3000.

### 6. Individual service development

```bash
# Start only a specific service
pnpm --filter @ai-arena/agent-service dev

# Run tests for a package
pnpm --filter @ai-arena/shared-utils test
```

---

## Environment Setup

Copy `.env.example` to `.env` and configure the following sections:

### 0G Network (Official Partner)

**Compute API key** (for all inference + image + audio calls):
1. Go to **https://pc.0g.ai** → Dashboard → API Keys
2. Create key with **inference** permission (format: `sk-xxxxxxxx`)
3. Set `ZEROG_COMPUTE_API_KEY=sk-your-key`
4. Deposit 0G tokens at pc.0g.ai → Dashboard → Deposit (billing in neuron units)

**Storage private key** (signs upload transactions on 0G Chain):
- Set `ZEROG_STORAGE_PRIVATE_KEY=0x_your_private_key`
- Fund wallet with 0G tokens for gas (testnet faucet available)

**Network:**
- `ZEROG_NETWORK=mainnet` (default) — set to `testnet` for development
- 0G Chain mainnet: Chain ID `16661`, RPC `https://evmrpc.0g.ai`
- 0G Chain testnet: Chain ID `16600`, RPC `https://evmrpc-testnet.0g.ai`

**Available inference models** (source: pc.0g.ai/api-reference):
- Chat: `zai-org/GLM-5.1-FP8` *(default)*, `deepseek/deepseek-chat-v3-0324`, `qwen/qwen3-vl-30b-a3b-instruct`, `qwen3.6-plus`
- Image: `z-image` (response_format: `b64_json` only)
- Audio: `openai/whisper-large-v3`

### Solana

For development, use devnet:
```bash
solana-keygen new --outfile ~/.config/solana/devnet.json
solana config set --url https://api.devnet.solana.com
solana airdrop 2
```

Set `SOLANA_PRIVATE_KEY` to the base58-encoded private key.

### JWT Secrets

Generate secure secrets:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Service Descriptions

### Core Platform Services

| Service | Port | Responsibility |
|---|---|---|
| identity-service | 8001 | SIWE auth, JWT issuance, user profiles |
| agent-service | 8002 | Agent lifecycle, evolution, 0G generation |
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

### Solana Programs (Devnet)

```bash
cd contracts/solana/agent-wallet
anchor build
anchor deploy --provider.cluster devnet

cd ../escrow-vault
anchor build
anchor deploy --provider.cluster devnet

cd ../tournament
anchor build
anchor deploy --provider.cluster devnet
```

After deployment, copy program IDs to `.env`:
```
AGENT_WALLET_PROGRAM_ID=<program_id>
ESCROW_VAULT_PROGRAM_ID=<program_id>
TOURNAMENT_PROGRAM_ID=<program_id>
```

### EVM Contracts (0G Testnet)

```bash
cd contracts/evm
pnpm install
npx hardhat compile
npx hardhat run scripts/deploy.ts --network zerog-testnet
```

The deployment script will output contract addresses. Add these to `.env`.

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

        // Start a game session
        await SessionManager.Instance.StartSession(agentId: "agent-uuid");
    }
}
```

### Telemetry

```csharp
// Record a combat action
TelemetryCollector.Instance.RecordCombatAction(new CombatActionEvent
{
    AgentId = currentAgent.Id,
    ActionType = "ability_cast",
    Position = transform.position,
    Target = targetAgent.Id,
    Timestamp = Time.time
});

// Flush at end of session
await TelemetryCollector.Instance.FlushAll();
```

### AI Agent Controller

```csharp
public class AIController : MonoBehaviour
{
    private AgentBrain _brain;

    async void Start()
    {
        _brain = gameObject.AddComponent<AgentBrain>();
        await _brain.Initialize(agentId: "agent-uuid");
    }

    async void Update()
    {
        if (_brain.IsReady)
        {
            var action = await _brain.GetNextAction(GetCurrentGameState());
            ExecuteAction(action);
        }
    }
}
```

---

## 0G Ecosystem Integration

AI Arena is an official 0G ecosystem partner. All AI infrastructure runs on 0G.

### 0G Compute Router
**Endpoint:** `https://router-api.0g.ai/v1` (OpenAI-compatible)
**Auth:** `sk-` API keys from pc.0g.ai → Dashboard → API Keys

Used for:
- **Combat Inference** — Real-time action prediction via `inferCombatAction()`, structured output via `tool_choice: required`, TEE-verifiable with `verify_tee: true`
- **Strategy Planning** — Multi-tick battle strategy at match start
- **Agent Generation** — Personality traits + avatar generation at mint time
- **Audio Transcription** — Battle commentary via Whisper

Available models (pc.0g.ai/api-reference): `zai-org/GLM-5.1-FP8`, `deepseek/deepseek-chat-v3-0324`, `qwen/qwen3-vl-30b-a3b-instruct`, `qwen3.6-plus`, `z-image`, `openai/whisper-large-v3`

### 0G Storage
**SDK:** `@0gfoundation/0g-storage-ts-sdk`
**Key fact:** Files are content-addressed by **Merkle root hash** — not path strings.

Pattern: `upload(data) → rootHash` → store `logicalPath → rootHash` in PostgreSQL `storage_index` table → `download(rootHash)`

Used for:
- **LoRA adapter weights** — fine-tuned model checkpoints (rootHash stored in INFT `modelRootHash`)
- **Agent memory blobs** — episodic + semantic memory (rootHash anchored on-chain in `memoryRootHash`)
- **Battle replays** — deterministic replay data for audit/anti-cheat
- **Training datasets** — processed telemetry JSONL for fine-tuning submissions

### 0G Chain (EVM)
**Mainnet:** Chain ID `16661` | RPC `https://evmrpc.0g.ai` | Explorer `https://chainscan.0g.ai`

The `AIArenaINFT.sol` contract implements **ERC-7857** (Living NFT standard):
- `transfer(from, to, tokenId, sealedKey, proof)` — oracle TEE re-encrypts metadata for new owner
- `clone(to, tokenId, sealedKey, proof)` — spawn child agent (max 3 per parent)
- `authorizeUsage(tokenId, executor, permissions)` — grant inference rights to backend

Storage contract (Flow): `0x62D4144dB0F0a6fBBaeb6296c785C71B3D57C526`

### 0G Fine-tuning (CLI)
Supported models: **Qwen2.5-0.5B-Instruct** and **Qwen3-32B** only.
```bash
0g-compute-cli fine-tuning create-task --provider <ADDR> --model Qwen2.5-0.5B-Instruct ...
```
**Important:** acknowledge delivered model within 48h or incur 30% fee penalty.

### 0G Chain (EVM)

The INFT contracts (`AIArenaINFT.sol`) deploy on 0G's EVM-compatible chain, enabling:
- NFT ownership of AI agents
- On-chain trait registry
- Evolution events as on-chain transactions
- Memory root hashes anchored on-chain

---

## $ARENA Token Integration

AI Arena integrates with the external $ARENA Finance backend for token operations:

### Token Flows

```
Player Stakes $ARENA → Solana Staking Program
Battle Wager → Solana Escrow Vault
Battle Win → Escrow Settle → Winner's Wallet
Tournament Entry Fee → Tournament Program
Tournament Win → Prize Pool Distribution
```

### x402 Payment Protocol

AI Arena supports the x402 micro-payment standard for:
- Per-inference billing (pay per AI action)
- Subscription credits
- Cross-chain deposits from any major chain

Configure `ARENA_FINANCE_API_URL` and `ARENA_FINANCE_API_KEY` to connect to the $ARENA backend.

---

## Deployment Guide

### Prerequisites

- GCP project with billing enabled
- `gcloud` CLI configured
- `kubectl` configured
- `helm` 3.x installed

### 1. Provision Infrastructure

```bash
cd infra/terraform/gcp
terraform init
terraform plan -var="project_id=your-gcp-project"
terraform apply
```

This creates:
- GKE cluster with 3 node pools (api, gpu-t4, data)
- Cloud SQL PostgreSQL instances
- Redis Memorystore
- Secret Manager secrets

### 2. Configure kubectl

```bash
gcloud container clusters get-credentials ai-arena-cluster --region us-central1
```

### 3. Create Kubernetes secrets

```bash
kubectl create secret generic ai-arena-secrets \
  --from-literal=database-url="$DATABASE_URL" \
  --from-literal=jwt-secret="$JWT_SECRET" \
  --from-literal=zerog-api-key="$ZEROG_COMPUTE_API_KEY"
```

### 4. Deploy with Helm

```bash
cd infra/helm/ai-arena
helm upgrade --install ai-arena . \
  -f values.yaml \
  -f values.prod.yaml \
  --namespace ai-arena \
  --create-namespace
```

### 5. Verify deployment

```bash
kubectl get pods -n ai-arena
kubectl get svc -n ai-arena
```

---

## Architecture Diagrams

See `docs/architecture/README.md` for full ASCII architecture diagrams including:
- System overview
- Service communication flow
- Data flow diagrams
- AI pipeline flow
- Financial transaction flow

---

## Contributing

See `docs/CONTRIBUTING.md` for the contribution guide, code style requirements, and PR process.

## License

MIT — see LICENSE file.
