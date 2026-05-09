# ============================================================
#  AI Arena — Start Dev Environment (Windows PowerShell)
# ============================================================
#  Run after setup.ps1. Opens backend + frontend in new windows.
# ============================================================

Write-Host "Starting AI Arena dev environment..." -ForegroundColor Cyan

# Make sure infra is up
Write-Host "Ensuring infrastructure is running..." -ForegroundColor Gray
docker compose up -d

# Start all backend services in a new PowerShell window
Start-Process powershell -ArgumentList @(
    "-NoExit",
    "-Command",
    "cd '$PWD'; Write-Host 'AI Arena — Backend Services' -ForegroundColor Cyan; pnpm dev"
) -WindowStyle Normal

Start-Sleep -Seconds 2

# Start frontend in another window
Start-Process powershell -ArgumentList @(
    "-NoExit",
    "-Command",
    "cd '$PWD'; Write-Host 'AI Arena — Frontend' -ForegroundColor Cyan; pnpm --filter @ai-arena/web dev"
) -WindowStyle Normal

Write-Host @"

Started! Opening in two PowerShell windows.

  Frontend:    http://localhost:3000
  API Gateway: http://localhost:8000
  Grafana:     http://localhost:3001
  Jaeger:      http://localhost:16686

Press Ctrl+C in each window to stop.
"@ -ForegroundColor Green
