# AI Arena Deployment Guide

## Prerequisites

- Docker + Docker Compose (local)
- kubectl + Helm 3.x (Kubernetes)
- Terraform >= 1.7 (GCP infrastructure)
- pnpm >= 9.0
- Node.js >= 20.0

## Local Development

Start all infrastructure services:

```bash
docker-compose up -d
```

This starts: PostgreSQL 16, TimescaleDB, ClickHouse, Redis 7, NATS 2.10, Qdrant 1.8.

Run database migrations:

```bash
cd packages/db-client
pnpm prisma migrate dev
pnpm prisma generate
```

Start all services in dev mode:

```bash
pnpm dev  # runs turbo dev across all services
```

Services will start on ports 3001–3020. The API gateway proxies port 8080.

## Environment Variables

Copy `.env.example` to `.env` and fill in all values.

### 0G Ecosystem Setup (required — AI Arena is a 0G partner)

#### Step 1 — Create a 0G Compute API key
1. Go to **https://pc.0g.ai** → Dashboard → API Keys
2. Click **Create Key** → select **inference** permission
3. Copy the key (format: `sk-xxxxxxxxxxxxxxxxxxxxxxxx`)
4. Set `ZEROG_COMPUTE_API_KEY=sk-your-key`

#### Step 2 — Deposit 0G tokens for inference billing
1. Go to **pc.0g.ai** → Dashboard → Deposit
2. Deposit enough 0G tokens (billing is in **neuron** units: 1 0G = 1e18 neuron)
3. Payment contract mainnet: `0xA3b15Bd2aD18BFB6b5f92D8AA9F444Dd59d1cE32`
4. Check balance: `GET https://router-api.0g.ai/v1/account/balance`

#### Step 3 — Configure 0G Storage private key
This wallet signs storage upload transactions on 0G Chain.
```bash
ZEROG_STORAGE_PRIVATE_KEY=0x_your_private_key
# Fund wallet with 0G tokens for gas (mainnet) or use faucet (testnet)
```
Store in HashiCorp Vault in production — never commit the real value.

#### Step 4 — (Optional) Configure fine-tuning provider
```bash
# List providers
0g-compute-cli fine-tuning list-providers

ZEROG_FINETUNE_PROVIDER=0x...your_provider_address
# Supported models for 0G fine-tuning ONLY:
ZEROG_FINETUNE_DEFAULT_MODEL=Qwen2.5-0.5B-Instruct   # or Qwen3-32B
```

#### Available inference models (source: pc.0g.ai/api-reference)
| Model | Type | Notes |
|-------|------|-------|
| `zai-org/GLM-5.1-FP8` | Chat | Default — recommended |
| `deepseek/deepseek-chat-v3-0324` | Chat | Strong multi-step reasoning |
| `qwen/qwen3-vl-30b-a3b-instruct` | Chat | Multimodal (vision + text) |
| `qwen3.6-plus` | Chat | Qwen3.6 Plus |
| `zai-org/GLM-5-FP8` | Chat | Older GLM-5 |
| `z-image` | Image | Avatar generation (`b64_json` only) |
| `openai/whisper-large-v3` | Audio | Transcription |

### Infrastructure env vars
```bash
DATABASE_URL=postgresql://aiarena:aiarena@localhost:5432/aiarena
REDIS_URL=redis://localhost:6379
NATS_URL=nats://localhost:4222
QDRANT_URL=http://localhost:6333
# 0G Compute Router (OpenAI-compatible, same URL for mainnet + testnet)
ZEROG_COMPUTE_BASE_URL=https://router-api.0g.ai/v1
ZEROG_COMPUTE_API_KEY=sk-your-key-here
ZEROG_NETWORK=mainnet        # mainnet | testnet
JWT_SECRET=generate_with_openssl_rand_hex_64
```

## Building Docker Images

Build all service images:

```bash
pnpm build  # compiles TypeScript first
docker build -f services/identity-service/Dockerfile -t ai-arena/identity-service:latest services/identity-service
# Repeat for each service, or use a build script
```

Or use the CI pipeline which builds all images and pushes to GCR.

## Kubernetes Deployment

### Provision GCP Infrastructure

```bash
cd infra/terraform/gcp
terraform init
terraform plan -var="project_id=your-gcp-project"
terraform apply -var="project_id=your-gcp-project"
```

### Configure kubectl

```bash
gcloud container clusters get-credentials ai-arena-prod --region us-central1 --project your-project
```

### Create Kubernetes Secrets

```bash
kubectl create namespace ai-arena
kubectl create secret generic ai-arena-secrets \
  --from-literal=database-url="$DATABASE_URL" \
  --from-literal=redis-url="$REDIS_URL" \
  --from-literal=nats-url="$NATS_URL" \
  --from-literal=jwt-secret="$JWT_SECRET" \
  --from-literal=zerog-compute-api-key="$ZEROG_COMPUTE_API_KEY" \
  --from-literal=zerog-storage-private-key="$ZEROG_STORAGE_PRIVATE_KEY" \
  --from-literal=zerog-inft-contract-address="$ZEROG_INFT_CONTRACT_ADDRESS" \
  -n ai-arena
```

### Deploy with Helm

Staging:
```bash
helm upgrade --install ai-arena infra/helm/ai-arena \
  -f infra/helm/ai-arena/values.staging.yaml \
  --namespace ai-arena \
  --create-namespace
```

Production:
```bash
helm upgrade --install ai-arena infra/helm/ai-arena \
  -f infra/helm/ai-arena/values.prod.yaml \
  --namespace ai-arena \
  --atomic \
  --timeout 10m
```

### Deploy with Kustomize (base)

```bash
kubectl apply -k infra/k8s/base/
```

## Database Migrations in Production

```bash
# Run as a Kubernetes Job before deploying new service versions
kubectl run --rm -it db-migrate \
  --image=ai-arena/db-client:latest \
  --env="DATABASE_URL=$DATABASE_URL" \
  --command -- pnpm prisma migrate deploy
```

## Health Checks

All services expose `GET /health` returning `{ status: "ok", uptime: <seconds> }`.

Check service health:
```bash
kubectl get pods -n ai-arena
kubectl logs deployment/identity-service -n ai-arena --tail=50
```

## Monitoring

Services expose Prometheus metrics at `/metrics` (via `@opentelemetry/auto-instrumentations-node`).
A Grafana dashboard is provisioned by Helm. Access via:

```bash
kubectl port-forward svc/grafana 3000:3000 -n monitoring
```

## Rollback

```bash
helm rollback ai-arena <revision> -n ai-arena
```

## Solana Programs

```bash
cd contracts/solana/agent-wallet
anchor build
anchor deploy --provider.cluster devnet

# Verify
anchor test
```

## EVM Contracts

```bash
cd contracts/evm
pnpm install
npx hardhat compile
npx hardhat run scripts/deploy.ts --network zerog-testnet

# Verify on explorer
npx hardhat verify --network zerog-testnet <contract-address>
```
