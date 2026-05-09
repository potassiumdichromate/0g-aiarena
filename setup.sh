#!/usr/bin/env bash
# ============================================================
#  AI Arena — One-Command Local Setup (Linux / macOS)
# ============================================================
#  Usage:
#    1. Edit .env (copied from .env.example automatically)
#    2. chmod +x setup.sh && ./setup.sh
# ============================================================

set -euo pipefail
GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'

step() { echo -e "\n${CYAN}==> $1${NC}"; }
ok()   { echo -e "${GREEN}  ✓ $1${NC}"; }
warn() { echo -e "${YELLOW}  ⚠ $1${NC}"; }
fail() { echo -e "${RED}  ✗ $1${NC}"; exit 1; }

echo -e "${CYAN}"
cat << 'EOF'
╔══════════════════════════════════════════════╗
║         AI Arena — Local Setup               ║
║         Powered by 0G · Solana · Privy       ║
╚══════════════════════════════════════════════╝
EOF
echo -e "${NC}"

# ── 0. Prerequisites ──────────────────────────────────────────────────────────
step "Checking prerequisites..."

NODE_VER=$(node --version 2>/dev/null || fail "Node.js not found. Install from https://nodejs.org (LTS)")
NODE_MAJ=$(echo "$NODE_VER" | sed 's/v\([0-9]*\).*/\1/')
[ "$NODE_MAJ" -ge 20 ] || fail "Node $NODE_VER found — need >= 20"
ok "Node $NODE_VER"

if ! command -v pnpm &>/dev/null; then
  warn "pnpm not found — installing..."
  npm install -g pnpm@latest
fi
ok "pnpm $(pnpm --version)"

command -v docker &>/dev/null || fail "Docker not found. Install Docker Desktop."
docker compose version &>/dev/null || fail "Docker Compose not found. Update Docker Desktop."
ok "Docker $(docker --version | cut -d' ' -f3 | tr -d ',')"

# ── 1. Environment file ───────────────────────────────────────────────────────
step "Setting up environment..."

if [ ! -f ".env" ]; then
  cp .env.example .env
  ok ".env created from .env.example"
  warn "IMPORTANT: Fill in these values in .env before continuing:"
  echo -e "  ${YELLOW}PRIVY_APP_ID / PRIVY_APP_SECRET   → https://console.privy.io${NC}"
  echo -e "  ${YELLOW}ZEROG_COMPUTE_API_KEY              → https://pc.0g.ai${NC}"
  echo -e "  ${YELLOW}ZEROG_STORAGE_PRIVATE_KEY          → your EVM wallet private key${NC}"
  echo ""
  read -rp "  Press Enter after editing .env..."
else
  ok ".env already exists"
fi

if [ ! -f "apps/web/.env.local" ]; then
  cp apps/web/.env.local.example apps/web/.env.local
  warn "Created apps/web/.env.local — add NEXT_PUBLIC_PRIVY_APP_ID there too"
else
  ok "apps/web/.env.local already exists"
fi

# ── 2. Install dependencies ───────────────────────────────────────────────────
step "Installing dependencies..."
pnpm install
ok "All packages installed"

# ── 3. Start infrastructure ───────────────────────────────────────────────────
step "Starting infrastructure (docker compose up -d)..."
docker compose up -d
ok "Containers starting..."

# ── 4. Wait for Postgres ──────────────────────────────────────────────────────
step "Waiting for Postgres..."
for i in $(seq 1 20); do
  if docker exec ai-arena-postgres pg_isready -U ai_arena &>/dev/null; then break; fi
  echo "  Waiting... ($i/20)"
  sleep 3
  [ "$i" -eq 20 ] && fail "Postgres did not start. Run: docker compose logs postgres"
done
ok "Postgres ready"

# ── 5. Wait for Redis ─────────────────────────────────────────────────────────
step "Waiting for Redis..."
for i in $(seq 1 10); do
  if [ "$(docker exec ai-arena-redis redis-cli ping 2>/dev/null)" = "PONG" ]; then break; fi
  sleep 2
  [ "$i" -eq 10 ] && fail "Redis did not start. Run: docker compose logs redis"
done
ok "Redis ready"

# ── 6. Generate Prisma client ─────────────────────────────────────────────────
step "Generating Prisma client..."
pnpm --filter @ai-arena/db-client exec prisma generate
ok "Prisma client generated"

# ── 7. Run migrations ─────────────────────────────────────────────────────────
step "Running database migrations..."
pnpm --filter @ai-arena/db-client exec prisma migrate deploy 2>/dev/null || \
  pnpm --filter @ai-arena/db-client exec prisma migrate dev --name init
ok "Database migrations applied"

# ── 8. Build shared packages ──────────────────────────────────────────────────
step "Building shared packages..."
for pkg in shared-types shared-utils db-client cache event-bus solana-client vector-db zerog-client telemetry-protocol; do
  echo "  Building @ai-arena/$pkg..."
  pnpm --filter "@ai-arena/$pkg" build 2>/dev/null || true
done
ok "Shared packages built"

# ── Done ──────────────────────────────────────────────────────────────────────
echo -e "${GREEN}"
cat << 'EOF'
╔══════════════════════════════════════════════════════════════╗
║  ✅  Setup complete! Here's how to start:                    ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  Terminal 1 — All backend services:                          ║
║    pnpm dev                                                  ║
║                                                              ║
║  Terminal 2 — Frontend:                                      ║
║    pnpm --filter @ai-arena/web dev                           ║
║                                                              ║
╠══════════════════════════════════════════════════════════════╣
║  URLs:                                                       ║
║    Frontend:    http://localhost:3000                        ║
║    API Gateway: http://localhost:8000                        ║
║    Grafana:     http://localhost:3001  (admin/admin123)      ║
║    Jaeger:      http://localhost:16686                       ║
╚══════════════════════════════════════════════════════════════╝
EOF
echo -e "${NC}"
