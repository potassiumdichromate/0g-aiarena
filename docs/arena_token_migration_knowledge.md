# $ARENA → 0G Chain Migration — Knowledge Doc

> **Status as of 2026-07-07: LIVE on 0G mainnet.** The new $ARENA economy is deployed, wired end-to-end, and the old off-chain economy is no longer the settlement path for agent-mint rewards or League wagers. This doc is the running reference for what exists, where, and what's still open.

Repos:
- Backend monorepo: `C:\Users\RENTKAR\Desktop\0g-ai\0g-AIArena`
- Frontend: `C:\Users\RENTKAR\Desktop\0g-ai\kult-browser\kult-games-v3`

Admin-only pages (no nav link anywhere — direct URL only):
- Treasury dashboard: **https://app.kult.games/admin/arena-treasury**
- Explorer: **https://app.kult.games/admin/arena-explorer**

---

## 1. Why this happened

You gave a blueprint for a new $ARENA economy on 0G Chain: fixed 1,000,000 supply, Treasury-distributed (no minting), a Reward Distributor for Agent Mint/Training/Daily Login/Referral/Quest/Tournament/Seasonal rewards, an Escrow contract replacing the old wager system, backend-sponsored gas (no native 0G tokens needed from players), full event coverage for analytics, an Explorer + Treasury dashboard, and eventual chain-agnostic Solana portability.

Phase 1 analysis found the *existing* on-chain infrastructure was a completely different, mostly-dormant design: a Solana ERC-4626-style "vault-share" token (USDC/USDT-backed, appreciating backing ratio, Wormhole bridging) that was never actually load-bearing — the real production economy ran entirely off Postgres (`AgentWallet.balanceArena` / `LedgerEntry` / `EscrowRecord`). You approved retiring the Solana stack (archived, not deleted — for a future Solana migration) and building the new blueprint fresh on 0G Chain.

---

## 2. Live contract addresses (0G mainnet, chainId 16661)

Deployed 2026-07-07 via `contracts/evm/scripts/deploy-arena-economy.ts`. Independently verified on-chain (bytecode present, `totalSupply` / `balanceOf(treasury)` both read exactly 1,000,000 ARENA at deploy time).

| Contract | Address |
|---|---|
| ArenaTreasury | `0x5FFFaFE67bD7Ec11db825E26ef21ac5172CC9E23` |
| ArenaToken | `0xBD756d8Cd838cf40dAa7DC1C0F5b5B643d118C00` |
| RewardDistributor | `0x1f07FbAC4282B4F2a5E51bac16E1dA5c6a7809A3` |
| ArenaEscrow | `0xFa1C51727D0d51cCDB38BA7343948e4524937621` |
| ArenaTournament | `0xa769A29E37a8d1e2bF81159c80230D962B04d702` |

`DEFAULT_ADMIN_ROLE` and `RELAYER_ROLE` on all 5 contracts are currently held by the same deployer address (`0x043091b10bBcD3F8C5158C27AD291CC56B4F46db`). **This key has been exposed in chat during this session and was not rotated before mainnet deploy.** `RewardDistributor`'s discretionary reward functions (`grantTrainingReward`/`grantQuestReward`/`grantSeasonalReward`/etc.) have no per-call cap, so `RELAYER_ROLE` alone is sufficient to drain the full treasury. This is the single largest open risk on the whole system right now — see §5.

Deployed skipping `zerog-testnet` entirely (went straight to mainnet, against the originally suggested order) and without an external/independent audit — only the internal review pass described in §4.

---

## 3. What's live and wired end-to-end

### Archived (not deleted)
Moved via `git mv` into `archive/solana-vault-stack/` (backend repo): `token/` (old vault-share Solana design), `contracts/solana/` (4 Anchor programs), `services/token-service`, `packages/solana-client`, `services/wallet-service` + `services/escrow-service` (confirmed orphaned duplicates), `workers/settlement-worker`, `contracts/evm/contracts/ArenaDepositVault.sol` + its deploy scripts. `README.md` inside explains what's there and why. Not yet reviewed by you.

### Smart contracts (`contracts/evm/contracts/arena/`)
- **`ArenaToken.sol`** — plain ERC20, fixed 1,000,000 supply minted once to Treasury in the constructor. No mint function exists at all.
- **`ArenaTreasury.sol`** — `AccessControl`-gated (`SPENDER_ROLE`). Exposes `balance()`, `distributed()`, `remaining()`, `totalCommissions()`, `totalRewardsPaid()`.
- **`RewardDistributor.sol`** — `RELAYER_ROLE`-gated. `grantAgentMintReward` (fixed 100 ARENA), `grantDailyLoginReward` (on-chain one-per-UTC-day), `grantReferralReward`, `grantTrainingReward`, `grantQuestReward`, `grantSeasonalReward`, `grantTournamentReward`.
- **`ArenaEscrow.sol`** — 1v1 wager staking, `createMatch → joinMatch → startMatch → settleMatch`, 90/10 split (commission rate **locked in at match-creation time**, not live-mutable mid-match — fixed during the security pass, see §4). `cancelMatch` refunds.
- **`ArenaTournament.sol`** — same pattern, N participants, placement-based prize split. `settleTournament` requires prize% + commission% to sum to **exactly** 100% (tightened from `<=` during the security pass — no token dust can be stranded) and rejects duplicate winner addresses.
- Test suite: `contracts/evm/test/ArenaEconomy.test.ts` — 11 tests, all passing (fixed-supply invariant, no-mint-function, reward grants, access control rejection, daily-login rate limit, the 5+5→9/1 wager example, cancel refunds, 3-player tournament payout, locked commission rate, exact-100% enforcement, duplicate-winner rejection).

### Database
`OnChainEvent` and `TreasurySnapshot` models — **migration applied to the production database** (`aiarena` on Render, run via `aiarena-agent`'s Shell: `packages/db-client/node_modules/.bin/prisma migrate deploy --schema=packages/db-client/prisma/schema.prisma`). Purely additive; old models (`AgentWallet`, `LedgerEntry`, `EscrowRecord`, `StakingRecord`, `Tournament`) untouched.

### `services/arena-chain-service` — deployed and verified live
Render service `aiarena-arena-chain`, manually created (no Render Blueprint in this account, so it wasn't a `render.yaml` sync — created directly via New Web Service using the settings already defined in `render.yaml`'s `aiarena-arena-chain` block). Holds the only relayer signer for all 5 contracts.

**Fixed during wiring**: the original auth hook required `X-Service-Key` on *every* route, including read-only ones — meaning the frontend could never have called it (browsers can't hold that secret). Now only POST (state-changing) routes require it; GETs are public, matching how the admin Explorer/Treasury pages are meant to work (URL-gated, not login-gated). Also added the `/v1/arena/config` endpoint (returns contract addresses) — needed by the frontend's staking `approve()` flow and wasn't in the original build.

Verified live (2026-07-07):
```
GET /health           → {"status":"ok","service":"arena-chain-service",...}
GET /v1/arena/config   → returns all 5 addresses above, matches deploy output
GET /v1/arena/treasury → {"balance":"1000000.0","distributed":"0.0","remaining":"1000000.0","totalCommissions":"0.0","totalRewardsPaid":"0.0"}
```

### Backend rewiring — pushed, redeployed
- **`agent-service`**: Agent Mint Flow now grants the 100 ARENA reward *after* a successful INFT mint (was previously an unconditional pre-mint off-chain grant).
- **`financial-service`**: wager/League settlement now calls `arena-chain-service`'s escrow endpoints instead of computing the split in Postgres. `EscrowRecord` kept only as a state/idempotency anchor.
- **`inft-service`**: fixed a pre-existing ABI drift bug against the real `AIArenaINFT.sol` (unrelated to this migration but a hard blocker for the mint→reward chain working at all).
- **`api-gateway`**: `/v1/arena/*` now proxies to `ARENA_CHAIN_SERVICE_URL`.

All four required a manual redeploy on Render (auto-deploy is off in this account) — triggered and confirmed deploying as of the last session.

### Frontend — pushed
- `src/api/arenaChainApi.ts` — client for all `/v1/arena/*` reads.
- `BalancePanel.tsx` / `ArenaAgentWalletManagerModal.tsx` — show the player's real on-chain wallet balance; removed the old fake self-credit "Fund wallet" flow entirely.
- **`useArenaStaking.ts`** (new) + **`LeagueFightCarousel.tsx`** rewire — the player-side `approve()` step is now wired into the actual wager UI. `ChallengeForm` approves the escrow contract before creating a challenge. **Built a previously-entirely-missing "Accept" button** — the backend's accept endpoint existed with zero frontend calling it; accepting now also approves the opponent's stake first.
- Two admin pages at the URLs listed at the top of this doc.

---

## 4. Security review (internal pass, not an external audit)

Findings and fixes made pre-deploy:
1. **Commission rate locked at creation time** — previously an admin could raise `commissionBps` mid-match/tournament after both sides had already staked under the original rate. Fixed: rate is now snapshotted into the `Match`/`TournamentInfo` struct at creation.
2. **Exact prize accounting in `ArenaTournament`** — `settleTournament` previously allowed `prizeBps + commissionBps <= 10_000`, meaning a relayer miscalculation could strand token dust in the contract permanently (no recovery function existed despite a code comment claiming one). Tightened to require exact 100%.
3. **Duplicate winner rejection** — `settleTournament` now reverts if the same address appears twice in the winners array.

**Not fixed, flagged only** (needs your decision, not something I imposed a guess at):
- `RewardDistributor`'s discretionary reward functions have no per-call or per-period cap. Combined with the exposed relayer key (§2), this is currently the top operational risk on the live system.

This was one focused internal pass, not a substitute for an external audit — the original spec's "fully audited internally before deployment" requirement should be considered only partially satisfied.

---

## 5. What's still open

1. **Rotate the admin/relayer key.** The deployer address holds both roles on all 5 live mainnet contracts and has been posted in this chat. Recommended: generate a fresh address, `grantRole` both roles to it on all 5 contracts, then `revokeRole` from the old one. Not yet done.
2. **`archive/solana-vault-stack/` still not reviewed by you.**
3. **No cap on `RewardDistributor` discretionary grants** (§4) — worth deciding on a sane per-tx or per-day limit.
4. **No live end-to-end test yet** — mint an agent and confirm the 100 ARENA reward actually lands, then run one real 1v1 wager stake→settle, on mainnet, with real wallets.
5. **Deployed straight to mainnet, skipping testnet** — the testnet path (`deploy:arena:testnet`, `zerog-testnet` chainId 16600) still exists in the scripts/config if you ever want a staging environment for future contract changes.
6. **Polymarket cross-chain bridge deposit flow** — unrelated to $ARENA, but tracked as task #42 from the same working session: letting users deposit from Ethereum/Solana/Bitcoin/other EVM chains via Polymarket's own Bridge API. Not started.
7. **Gasless staking (permit) — code done, redeploy + rollout still needed by you.** See §7.

---

## 7. Gasless staking via EIP-2612 permit (2026-07-08)

**Problem:** every wager/tournament stake still asked the player to sign an on-chain `approve()` transaction — the one step in the whole ARENA flow that wasn't relayer-sponsored, so it required the player to hold native 0G for gas. That defeats the entire point of the sponsored-gas design.

**Fix:** `ArenaToken.sol` now inherits OpenZeppelin's `ERC20Permit` (EIP-2612). Players sign a free off-chain EIP-712 `Permit` message instead of submitting a transaction; the backend relayer calls `token.permit(...)` and pays the gas, exactly like every other write in this system.

Because token contracts aren't upgradeable, this required **redeploying all 5 contracts** (Treasury/Token/RewardDistributor/Escrow/Tournament — Treasury and Escrow/Tournament all take the token address as a constructor arg, so they have to be redeployed alongside it). The old token currently holds real balances from ~40 wallets (agent-mint rewards, ~3,579 ARENA total as of this writing) — `scripts/redeploy-arena-permit.ts` snapshots every non-zero holder from the old token's `Transfer` events and airdrops them the identical balance on the new token before finishing, so nobody's existing ARENA is lost.

**What's done (code, not yet deployed):**
- `contracts/evm/contracts/arena/ArenaToken.sol` — adds `ERC20Permit`.
- `contracts/evm/scripts/redeploy-arena-permit.ts` — deploys the new economy, wires roles, snapshots + airdrops old holders. Run via `pnpm redeploy:arena:permit:mainnet` inside `contracts/evm`, with `OLD_ARENA_TOKEN_ADDRESS` and `OLD_ARENA_TREASURY_ADDRESS` set to the current live addresses (§2) plus the same env vars `deploy-arena-economy.ts` needs.
- `services/arena-chain-service`: new `GET /v1/arena/wallet/:address/nonce`, `GET /v1/arena/permit/domain`, `POST /v1/arena/permit` (relayer-only, X-Service-Key). `arenaTokenWrite()` added to `contracts.ts`. ABI regenerated (`permit`/`nonces`/`DOMAIN_SEPARATOR` now present).
- `services/financial-service`: new public `POST /wallets/permit` — the browser can't hold arena-chain-service's service key, so it posts the signed permit here and this service relays it. Not gated by extra auth beyond what already exists on this route, because the permit signature itself is what proves fund authorization (`ArenaToken.permit()` reverts unless `v/r/s` recovers to `owner`) — no one can authorize spending on someone else's behalf regardless of what they post here.
- Frontend `useArenaStaking.ts` — `ensureStakeApproved()` now signs an EIP-712 `Permit` via `viem`'s `signTypedData` (through the same Privy provider used everywhere else) instead of calling `sendPrivyTransaction` with an `approve()` call. Zero gas prompts, zero 0G balance required.
- All 11 contract tests still pass; `tsc --noEmit` clean on arena-chain-service, financial-service, and the frontend.

**Still needed before this is live:**
1. You run `redeploy-arena-permit.ts` on mainnet (own key, same as every prior deploy) — this is a real mainnet deploy + fund migration, so it wasn't run automatically.
2. Update `ARENA_TOKEN_ADDRESS` / `ARENA_TREASURY_ADDRESS` / `ARENA_REWARD_DISTRIBUTOR_ADDRESS` / `ARENA_ESCROW_ADDRESS` / `ARENA_TOURNAMENT_ADDRESS` env vars on `aiarena-arena-chain` (and anywhere else they're referenced) to the new addresses the script prints, then redeploy that service.
3. Redeploy the frontend (`kult-games-v3`) with the updated `useArenaStaking.ts`/`arenaChainApi.ts`.
4. Do one real end-to-end test: stake into a 1v1 wager with a wallet holding zero native 0G, confirm no wallet gas prompt appears and the match still creates/settles correctly.

---

## 6. Reference — where things live

**Backend repo**: `contracts/evm/contracts/arena/*.sol`, `contracts/evm/test/ArenaEconomy.test.ts`, `contracts/evm/scripts/deploy-arena-economy.ts`, `services/arena-chain-service/`, `services/financial-service/src/services/arena-chain.client.ts`, `packages/db-client/prisma/schema.prisma` (`OnChainEvent`, `TreasurySnapshot`), `archive/solana-vault-stack/`.

**Frontend repo**: `src/api/arenaChainApi.ts`, `src/hooks/useArenaStaking.ts`, `src/lib/zerogClient.ts`, `src/components/dashboard/BalancePanel.tsx`, `src/components/arena/ArenaAgentWalletManagerModal.tsx`, `src/components/league/LeagueFightCarousel.tsx`, `src/pages/admin/ArenaTreasuryPage.tsx`, `src/pages/admin/ArenaExplorerPage.tsx`.
