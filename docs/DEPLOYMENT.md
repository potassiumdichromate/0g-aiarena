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

Copy `.env.example` to `.env` and fill in all values. Critical ones:

```bash
DATABASE_URL=postgresql://aiarena:aiarena@localhost:5432/aiarena
REDIS_URL=redis://localhost:6379
NATS_URL=nats://localhost:4222
QDRANT_URL=http://localhost:6333
ZEROG_COMPUTE_ENDPOINT=https://compute.0g.ai
ZEROG_API_KEY=your_key_here
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
  --from-literal=zerog-compute-endpoint="$ZEROG_COMPUTE_ENDPOINT" \
  --from-literal=zerog-api-key="$ZEROG_API_KEY" \
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
