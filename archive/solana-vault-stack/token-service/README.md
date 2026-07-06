# token-service

Backend for the **$ARENA** token economy — reserve reads, bridge relaying, treasury fee routing.

## Architecture

```
EVM Chains                  token-service                  Solana
──────────                  ─────────────                  ──────
Base Vault ──DepositQueued──► bridge.service ──────────────► arena-reserve program
0G Vault ───DepositQueued───►   (relayer)     receive_bridge_deposit()

                            reserve.service ─────reads──────► ReserveState PDA
                            treasury.service ────writes─────► add_protocol_revenue()

HTTP clients                token.routes (port 8050)
────────────                ─────────────────────────
/v1/token/price              → reserve snapshot (cached 10s)
/v1/token/deposit/preview    → vault-share formula
/v1/token/redeem/preview     → redemption with fee
/v1/token/balance/:address   → ATA balance + USD value
/v1/token/bridge/deposit     → record pending deposit
/v1/token/treasury/stats     → fee routing analytics
```

## Services

| File | Purpose |
|------|---------|
| `reserve.service.ts` | Read-only: decode `ReserveState` PDA, preview mint/redeem |
| `bridge.service.ts`  | EVM event listener → Solana `receive_bridge_deposit` |
| `treasury.service.ts`| Route protocol fees 80/20, check USDC/USDT rebalance |

## Workers

| Worker | Run | Purpose |
|--------|-----|---------|
| `bridge-listener.ts` | `npm run dev:bridge` | Long-lived EVM listener, auto-restarts |
| `rebalancer.ts`      | `npm run dev:rebal`  | Periodic 60/40 drift check (default 6h) |

## Quick start

```bash
# Install
pnpm install

# Dev (all three in separate terminals)
npm run dev          # HTTP server :8050
npm run dev:bridge   # EVM listener
npm run dev:rebal    # Rebalancer

# Build + start
npm run build
npm start
```

## Required env vars

| Variable | Description |
|----------|-------------|
| `SOLANA_RPC_URL` | Helius or other Solana RPC |
| `ARENA_RESERVE_PROGRAM_ID` | Deployed arena-reserve program address |
| `ARENA_TOKEN_MINT` | $ARENA SPL mint address |
| `RELAYER_SOLANA_PRIVATE_KEY` | Base64 relayer keypair (use AWS KMS in prod) |
| `BASE_RPC_URL` | Base mainnet RPC |
| `BASE_DEPOSIT_VAULT_ADDRESS` | `ArenaDepositVault.sol` on Base |
| `ZEROG_EVM_RPC` | 0G chain EVM RPC |
| `ZEROG_DEPOSIT_VAULT_ADDRESS` | `ArenaDepositVault.sol` on 0G |
| `DATABASE_URL` | Postgres (Prisma) |
| `REDIS_URL` | Redis (snapshot cache + rate limiting) |
| `NATS_URL` | NATS (bridge events, treasury events) |

## Token economics recap

- **Backing ratio** = `total_reserve_usdc + total_reserve_usdt / total_arena_supply`
- **Deposit formula** = `arena_out = usdc_in * total_shares / total_reserve` (ERC-4626)
- **Redeem formula** = `usdc_out = arena_in * total_reserve / total_shares - fee`
- **Fee split**: 80% to reserve (lifts backing ratio), 20% to ops wallet
- **Daily redemption cap**: 20% of supply (enforced on-chain)
- **Bridge auto-approve limit**: $50,000/day (excess → manual review queue)

## Endpoints

### Public

```
GET  /v1/token/price
GET  /v1/token/reserve/snapshot
POST /v1/token/deposit/preview    { "usdcAmount": "1000000" }
POST /v1/token/redeem/preview     { "arenaAmount": "1000000" }
GET  /v1/token/balance/:solanaAddress
```

### Authenticated

```
POST /v1/token/bridge/deposit     { userId, sourceChain, sourceTxHash, solanaAddress, usdcAmount, depositId }
GET  /v1/token/bridge/deposits?solanaAddress=...
GET  /v1/token/bridge/deposit/:id
GET  /v1/token/treasury/stats
GET  /v1/token/treasury/rebalance-history
```

## Phase roadmap

| Phase | Bridge mechanism | Status |
|-------|-----------------|--------|
| 1 (current) | Centralized backend relayer | ✅ Implemented |
| 2 | Wormhole VAA trustless relay | 🔜 Pending 0G → Wormhole listing |
| 2 | Jupiter swap for USDC/USDT rebalancer | 🔜 Planned |
