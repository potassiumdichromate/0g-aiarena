# ============================================================
#  AI Arena — One-Command Local Setup (Windows PowerShell)
# ============================================================
#  Usage:
#    1. Edit .env (copy from .env.example)
#    2. Run:  .\setup.ps1
#
#  What this does:
#    - Checks Node, pnpm, Docker versions
#    - Copies .env.example → .env if missing
#    - Installs all dependencies (pnpm install)
#    - Starts infrastructure (docker compose up -d)
#    - Waits for Postgres/Redis to be healthy
#    - Generates Prisma client + runs DB migrations
#    - Builds all shared packages
#    - Prints the "start dev" command
# ============================================================

$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = 'AI Arena Setup'

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-OK($msg)   { Write-Host "  ✓ $msg"  -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  ⚠ $msg"  -ForegroundColor Yellow }
function Write-Fail($msg) { Write-Host "  ✗ $msg"  -ForegroundColor Red; exit 1 }

Write-Host @"
╔══════════════════════════════════════════════╗
║         AI Arena — Local Setup               ║
║         Powered by 0G · Solana · Privy       ║
╚══════════════════════════════════════════════╝
"@ -ForegroundColor Cyan

# ── 0. Check prerequisites ────────────────────────────────────────────────────
Write-Step "Checking prerequisites..."

try {
    $nodeVer = node --version 2>$null
    $nodeMaj = [int]($nodeVer -replace 'v(\d+).*','$1')
    if ($nodeMaj -lt 20) { Write-Fail "Node $nodeVer found — need >= 20. Download: https://nodejs.org" }
    Write-OK "Node $nodeVer"
} catch { Write-Fail "Node.js not found. Download: https://nodejs.org/en/download (LTS)" }

try {
    $pnpmVer = pnpm --version 2>$null
    Write-OK "pnpm $pnpmVer"
} catch {
    Write-Warn "pnpm not found — installing..."
    npm install -g pnpm@latest
    Write-OK "pnpm installed"
}

try {
    docker --version | Out-Null
    Write-OK "Docker found"
} catch { Write-Fail "Docker not found. Download: https://www.docker.com/products/docker-desktop/" }

try {
    docker compose version | Out-Null
    Write-OK "Docker Compose found"
} catch { Write-Fail "Docker Compose not found. Update Docker Desktop." }

# ── 1. Environment file ───────────────────────────────────────────────────────
Write-Step "Setting up environment..."

if (-not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
    Write-OK ".env created from .env.example"
    Write-Warn "IMPORTANT: Open .env and fill in:"
    Write-Host "           PRIVY_APP_ID            → https://console.privy.io" -ForegroundColor Yellow
    Write-Host "           PRIVY_APP_SECRET         → https://console.privy.io" -ForegroundColor Yellow
    Write-Host "           ZEROG_COMPUTE_API_KEY    → https://pc.0g.ai" -ForegroundColor Yellow
    Write-Host "           ZEROG_STORAGE_PRIVATE_KEY → your throwaway EVM wallet key" -ForegroundColor Yellow
    Write-Host ""
    $continue = Read-Host "  Press Enter after editing .env (or Ctrl+C to abort)"
} else {
    Write-OK ".env already exists"
}

# Also copy frontend env
$webEnv = "apps\web\.env.local"
if (-not (Test-Path $webEnv)) {
    Copy-Item "apps\web\.env.local.example" $webEnv
    Write-Warn "Created apps/web/.env.local — add NEXT_PUBLIC_PRIVY_APP_ID there too"
} else {
    Write-OK "apps/web/.env.local already exists"
}

# ── 2. Install dependencies ───────────────────────────────────────────────────
Write-Step "Installing dependencies (pnpm install)..."
pnpm install
Write-OK "All packages installed"

# ── 3. Start infrastructure ───────────────────────────────────────────────────
Write-Step "Starting infrastructure (docker compose up -d)..."
docker compose up -d
Write-OK "Containers starting..."

# ── 4. Wait for Postgres ──────────────────────────────────────────────────────
Write-Step "Waiting for Postgres to be ready..."
$retries = 0
do {
    Start-Sleep -Seconds 3
    $retries++
    try {
        $result = docker exec ai-arena-postgres pg_isready -U ai_arena 2>$null
        if ($result -match "accepting connections") { break }
    } catch {}
    Write-Host "  Waiting... ($retries/20)" -ForegroundColor Gray
    if ($retries -ge 20) { Write-Fail "Postgres did not start in time. Run: docker compose logs postgres" }
} while ($true)
Write-OK "Postgres ready"

# ── 5. Wait for Redis ─────────────────────────────────────────────────────────
Write-Step "Waiting for Redis..."
$retries = 0
do {
    Start-Sleep -Seconds 2
    $retries++
    try {
        $pong = docker exec ai-arena-redis redis-cli ping 2>$null
        if ($pong -eq "PONG") { break }
    } catch {}
    if ($retries -ge 10) { Write-Fail "Redis did not start. Run: docker compose logs redis" }
} while ($true)
Write-OK "Redis ready"

# ── 6. Generate Prisma client ─────────────────────────────────────────────────
Write-Step "Generating Prisma client..."
pnpm --filter @ai-arena/db-client exec prisma generate
Write-OK "Prisma client generated"

# ── 7. Run DB migrations ──────────────────────────────────────────────────────
Write-Step "Running database migrations..."
pnpm --filter @ai-arena/db-client exec prisma migrate deploy 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Warn "migrate deploy failed (likely first run) — running migrate dev..."
    pnpm --filter @ai-arena/db-client exec prisma migrate dev --name init
}
Write-OK "Database migrations applied"

# ── 8. Build shared packages ──────────────────────────────────────────────────
Write-Step "Building shared packages..."
$packages = @(
    "@ai-arena/shared-types",
    "@ai-arena/shared-utils",
    "@ai-arena/db-client",
    "@ai-arena/cache",
    "@ai-arena/event-bus",
    "@ai-arena/solana-client",
    "@ai-arena/vector-db",
    "@ai-arena/zerog-client",
    "@ai-arena/telemetry-protocol"
)
foreach ($pkg in $packages) {
    Write-Host "  Building $pkg..." -ForegroundColor Gray
    pnpm --filter $pkg build 2>$null
}
Write-OK "All shared packages built"

# ── Done ──────────────────────────────────────────────────────────────────────
Write-Host @"

╔══════════════════════════════════════════════════════════════╗
║  ✅  Setup complete! Here's how to start:                    ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  Terminal 1 — All backend services + workers:                ║
║    pnpm dev                                                  ║
║                                                              ║
║  Terminal 2 — Frontend:                                      ║
║    pnpm --filter @ai-arena/web dev                           ║
║                                                              ║
║  Or run the start script:                                    ║
║    .\start-dev.ps1                                           ║
║                                                              ║
╠══════════════════════════════════════════════════════════════╣
║  URLs:                                                       ║
║    Frontend:    http://localhost:3000                        ║
║    API Gateway: http://localhost:8000                        ║
║    Grafana:     http://localhost:3001  (admin/admin123)      ║
║    Jaeger:      http://localhost:16686                       ║
╚══════════════════════════════════════════════════════════════╝
"@ -ForegroundColor Green
