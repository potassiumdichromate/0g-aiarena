# 0G-AIArena — Backend Context

Working reference for the backend monorepo at `C:\Users\RENTKAR\Desktop\0g-ai\0g-AIArena`.
Written from a full read of every top-level doc plus direct verification of the actual
code/config (not just docs, several of which are stale). Companion doc: `Kult-Browser_Frontend_Context.md`
in the sibling `kult-browser/kult-games-v3` repo — the live consumer frontend that talks to this backend
(plus its own separate Rust backend for non-Arena content).

---

## 🔴 Open security issue — read this first

`.env.example` (tracked in git since the first commit, pushed to `github.com/potassiumdichromate/0g-aiarena`)
contains what are almost certainly **real secrets, not placeholders**:

- `EVM_DEPLOYER_PRIVATE_KEY` / `ZEROG_STORAGE_PRIVATE_KEY` = `0x309b...9150` — derived locally with
  ethers.js to address **`0x63F63DC442299cCFe470657a769fdC6591d65eCa`**, which is exactly the
  production operator wallet referenced everywhere else in the docs (`EVM_FEE_COLLECTOR`,
  `EVM_OWNER_ADDRESS`, `ZEROG_INFT_ORACLE_ADDRESS`, the OKX marketplace payment recipient).
  Balance on 0G Chain mainnet checked read-only: currently `0`, but the key still holds live
  oracle/owner authority on `AIArenaINFT` and signs 0G Storage uploads.
- Also present and real-looking: `SOLANA_PRIVATE_KEY`, `RELAYER_SOLANA_PRIVATE_KEY`, `JWT_SECRET`,
  `JWT_REFRESH_SECRET`, `CUSTODIAL_WALLET_ENCRYPTION_KEY`, a Helius RPC API key, a real `PRIVY_APP_ID`.
- Separately: the OKX API key/secret/passphrase were shared in a prior chat session per
  `docs/okx/okx-memory.md` and flagged there as needing rotation — still not done as of the last
  session log.

**Action needed (not yet taken by me):** rotate the operator key and everything downstream of
`0x63F63DC...` retaining owner/oracle rights, rotate JWT/encryption secrets, rotate the OKX API
credentials, and replace `.env.example` with real placeholders.

---

## What this platform is

AI Arena — Web3 AI gaming platform. Players own AI agents as ERC-7857 "Living NFTs" (INFTs) on
0G Chain, battle them in real time, train them via ML pipelines, and wager `$ARENA` (Solana SPL
token) on outcomes. Officially an 0G ecosystem partner — all AI compute/storage runs on 0G
infrastructure. B2B model: game studios integrate the Unity/Unreal SDK to plug their game into the
Arena backend (first game: Warzone).

## Monorepo layout

```
apps/web/        Thin internal Next.js 14 dashboard (agents/battle/leaderboard only —
                  NOT the consumer-facing site; see note below)
services/         ~30 Node.js/Fastify microservices
workers/          4 background workers (training, embedding, behaviour = Python; settlement = TS)
packages/         11 shared libraries (types, utils, db-client/Prisma, zerog-client, solana-client,
                  event-bus, cache, vector-db, telemetry-protocol, football-data-client)
contracts/solana/ 4 Anchor programs (agent-wallet, escrow-vault, tournament, staking)
contracts/evm/    3 Solidity contracts (AIArenaINFT, AgentRegistry, ModuleMarketplace)
token/            Separate Solana program: arena-reserve ($ARENA backing/redemption)
ml/               5 Python ML pipelines (behaviour cloning, RL, feature extraction,
                  embeddings, anomaly detection) — all real, not stubs
unity/, unreal/   Game engine SDKs (C# / C++) — both real, production-grade
infra/            K8s/Helm/Terraform — NOT the current deploy path (see Deployment below)
doge-escape/      Empty directory, undocumented, likely dead weight
docs/             All source docs (read in full — see file list below)
```

**Important:** `apps/web` (in this repo) is *not* the site you'll see live at
`kult-browser-rust-l2lwg.ondigitalocean.app`. That's a separate sibling repo,
`kult-browser/kult-games-v3` (see the companion doc), which is the actual consumer frontend and
which this backend's docs (`docs/league/LEAGUE_SYSTEM_ARCHITECTURE.md`) reference by relative path.
`apps/web` has no KULT branding anywhere in its source — just `/agents`, `/battle`, `/leaderboard`.

## Tech stack

| Layer | Tech |
|---|---|
| Microservices | Node.js 20 + Fastify 4 + TypeScript 5, strict mode, no `any` |
| API Gateway | Fastify + `@fastify/http-proxy`, Redis-optional rate limiting |
| ML Workers | Python 3.11 + PyTorch 2 + Ray + PEFT/TRL |
| DB | PostgreSQL 16 (Prisma ORM) + ClickHouse 24 (telemetry/analytics, replaced TimescaleDB) |
| Cache/Queue | Redis 7 (optional everywhere, in-memory/Postgres fallback) |
| Message bus | NATS 2.10 JetStream (self-hosted container in prod, not managed) |
| Vector DB | Qdrant 1.8 (BGE-M3 1024-dim embeddings for RAG memory) |
| AI compute | 0G Compute Router — OpenAI-compatible, `router-api.0g.ai/v1` |
| AI storage | 0G Storage — Merkle-root content-addressed, `indexer-storage-turbo.0g.ai` |
| L2 chain | 0G Chain EVM, Chain ID 16661, `evmrpc.0g.ai` |
| L1 chain | Solana (devnet in current config; mainnet migration is Phase 2 roadmap) |
| Contracts | Anchor (Solana), Hardhat (EVM) |
| Monorepo | pnpm 11 workspaces + Turborepo 2 |
| CI/CD | **None** — no `.github/` directory at all. Deploys are manual via Render dashboard/Blueprint. |

## Production deployment (Render) — ground truth from `render.yaml`, not the docs

`docs/RENDER_DEPLOY.md` and `docs/DEPLOYMENT.md` describe an **8-service** deployment. The actual
`render.yaml` at repo root has grown to **17 services** — treat the docs as historical, the yaml as
current:

```
aiarena-db (Postgres, free plan)      aiarena-nats (private docker pserv)
aiarena-redis                         aiarena-gateway        :8000
aiarena-identity     :8001            aiarena-agent          :8002
aiarena-okx-payment-proxy :8090       aiarena-battle         (internal port differs from local :8021)
aiarena-matchmaking                   aiarena-financial
aiarena-token                         aiarena-leaderboard
aiarena-inft                          aiarena-inference
aiarena-memory                        aiarena-league  (:8060 locally)
aiarena-league-worker (:8061, health-check only, no public routes)
```

⚠️ **Local dev ports ≠ Render internal ports** for some services (e.g. battle-service is `:8021`
locally per README but `:8003` in the Render blueprint's env block) — check `render.yaml` directly
before assuming a port from the README.

Health check: every service exposes `GET /health`. Dev login (`POST /v1/auth/dev-login`) is
disabled whenever `NODE_ENV=production`.

## API Gateway routing (`services/api-gateway/src/main.ts`, read directly)

Single entry point, `:8000` locally / `aiarena-gateway.onrender.com` in prod. Two routing tables:

- **`DEPLOYED`** (always proxied, no fallback): `/v1/auth`, `/v1/users` → identity;
  `/v1/agents`, `/v1/training` → agent; `/v1/financial`, `/v1/wallets`, `/v1/escrow` → financial;
  `/v1/battles` → battle; `/v1/matchmaking` → matchmaking (rewrite to `/queue`);
  `/v1/token` → token; `/v1/leaderboards` → leaderboard; `/v1/league` → league-service;
  `/v1/okx` → agent-service (OKX A2MCP bridge, rewrite to `/okx`).
- **`OPTIONAL`** (proxied if env URL set, else clean `503` instead of `ECONNREFUSED`):
  `/v1/games`, `/v1/telemetry`, `/v1/behaviour`, `/v1/inference`, `/v1/memory`, `/v1/replays`,
  `/v1/tournaments`, `/v1/inft`, `/v1/payments`, `/v1/analytics`, `/v1/storage`, `/v1/notifications`.

Rate limits: global 500 req/min per wallet-address-header-or-IP (Redis-backed, falls back to
in-memory), `/v1/auth` 10 req/min, `/v1/okx` 30 req/min (env `OKX_RATE_LIMIT_MAX`) — all separate
Redis-backed `onRequest` hooks, gated behind `if (rateLimitRedis)`.

## Core data flow

**Agent creation** (`POST /v1/agents`): 0G Compute `generatePersonality()` (10s timeout, model
`zai-org/GLM-5.1-FP8`) → optional avatar via `z-image` (**disabled by default**,
`ENABLE_AVATAR_GEN=false`) → 0G Storage upload of avatar + metadata → Postgres `Agent` row
(always created even if 0G steps fail) → `AGENT_CREATED` NATS event → `inft-service` mints
ERC-7857 INFT async (usually <30s, `inftTokenId` starts `null`).

**Battle lifecycle**: queue (matchmaking-service, Redis ZADD by ELO) → match found (NATS) → battle
created → per-tick `inference-service` call to 0G Compute (`tool_choice: required`, 5s timeout,
falls back to defensive action) → battle ends → 0G Storage archive of result → replay-service
verifies `SHA256(seed+actionLog) === finalStateHash` → memory-service compacts episodic memory to
0G Storage, anchors `memoryRootHash` on-chain → inft-service records win/loss + ELO on-chain →
financial-service settles Solana escrow (winner 90%, platform 10%).

**Training**: `POST /agents/:id/train` → JSONL upload to 0G Storage → `TrainingJob` row →
`training-worker` (Python) submits via `0g-compute-cli fine-tuning create-task` (CLI only, not
REST) → polls until `Delivered` → **must acknowledge within 48h or pay a 30% fee penalty** →
downloads fine-tuned model → uploads to 0G Storage → new `AIModel` row, `modelRootHash` anchored
on-chain. **Only two base models supported for 0G fine-tuning: `Qwen2.5-0.5B-Instruct`,
`Qwen3-32B`.**

**4-tier memory**: Working (Redis, 1h TTL) → Episodic (Postgres + Qdrant, BGE-M3 vectors) →
Semantic (Qdrant, cross-battle patterns) → Procedural (0G Storage, full snapshot after every
battle via `compactMemory()`, up to 500 records, versioned `agents/{id}/memory/snapshot-{ts}`,
root hash anchored via `INFT.updateMemoryRoot()`).

**0G Storage pattern** (critical to remember): files are addressed by **Merkle root hash only** —
no path strings on-chain. A Postgres `StorageIndex` table (`logicalPath → rootHash`) bridges the
two, e.g. `agents/{id}/avatar/v1 → 0xabc...`.

## x402 payment standard (wager battles, training, cloning)

Server returns HTTP `402` with a `payment` object when a paid action is attempted without proof.
Client pays via Solana transfer from the agent's custodial wallet, then retries with
`X-Payment-Tx-Hash` + `X-Payment-Agent-Id` headers. Fee schedule:

| Action | Cost | Trigger |
|---|---|---|
| Join WAGER queue | 5 $ARENA | `mode: "WAGER"` on `POST /v1/matchmaking` |
| Train agent | 2 $ARENA | always (bypass: `X-Training-Source: arena-battle` header for internal post-battle training) |
| Clone agent | 10 $ARENA | always |

Wager settlement: winner gets 90% of pool, platform keeps 10%, automatic on battle end — no
frontend action needed. Full internal machinery: `POST /escrow/lock` → `POST /escrow/settle`
(both internal, battle-service → financial-service).

**Not yet live** (blocked on Solana escrow → mainnet, per `todo-tasks.md`/`ROADMAP.md` Phase 2):
fully autonomous wager battles where an agent auto-detects a 402 and self-pays from its own PDA
wallet without human involvement. Files already identified for when this unblocks:
`matchmaking-service/src/services/matchmaker.ts`, `autonomous-loop.ts`,
`wallet-service/src/services/wallet.service.ts` (needs `autoPayWager`).

## Database — Prisma schema (`packages/db-client/prisma/schema.prisma`)

5 migrations, chronological: `init` (2026-05-10) → `fix_clan_type_enum` → `kult_v1_league_economy`
(2026-06-15) → `okx_bridge_and_kult_experience_log` (2026-06-24) → `add_okx_clan` (2026-06-28).

**Core enums**: `ClanType` (ZEROG|BASE|SOLANA|**OKX**), `CombatArchetype`
(BERSERKER|TACTICIAN|SUPPORT|ASSASSIN|DEFENDER|HYBRID), `EvolutionStage`
(GENESIS|AWAKENED|ASCENDED|LEGENDARY|MYTHIC), `BattleMode`
(RANKED|CASUAL|WAGER|TOURNAMENT|EXHIBITION), `EscrowState`
(OPEN→FUNDED→LOCKED→SETTLED|CANCELLED|DISPUTED).

**Model groups**:
- *Users/Auth*: `User` (walletAddress, privyUserId, custodialSolanaAddress + AES-256-encrypted key)
- *Agent core*: `Agent` (eloRating default 1000, traits JSON, archetype, evolutionStage),
  `AIModel`, `TrainingJob`, `AgentMemory` (with `embedding Float[]`)
- *Battle*: `Battle`, `Tournament`
- *Financial*: `AgentWallet` (balanceArena/balanceSol, isFrozen), `EscrowRecord` (state machine +
  nullable unique `leagueBattleId`), `LedgerEntry` (typed `TransactionType`), `StakingRecord`
- *League system* (KULTAI Agent World Cup 2026 — see below): `LeagueSeason`, `LeagueMatch`,
  `LeaguePrediction`, `LeagueBattle`, `LeagueRivalry`, `LeagueAgentSeasonStats`,
  `LeagueUserProfile`, `LeagueKpLedger`, `LeagueMoment`, `LeagueWeeklySnapshot`,
  `LeagueSettlementLog`
- *OKX bridge*: `OkxAgentRequest` (idempotency), `KultExperienceLog` (schema exists, nothing
  writes to it yet — see Phase 1 below)
- *Storage/AI infra*: `StorageIndex` (logicalPath↔rootHash), `IntelligenceLayer`,
  `ZeroGFineTuneJob`
- *Cross-chain bridge*: `BridgeDeposit`, `TreasuryAllocation` (80% reserve / 20% ops split),
  `ReserveRebalance`
- *Leaderboard*: `LeaderboardEntry` (legacy, sorts by `eloRating`, separate from League's
  `reputation`-based leaderboard — see "Two leaderboard systems" below)

**Design pattern**: League tables reference `agentId`/`userId` as loose strings validated at the
app layer, *not* Prisma foreign keys to `Agent`/`User` — keeps the core schema diff at zero and
leaves room to split League into its own DB later.

## Two separate leaderboard systems (by design — important for debugging)

- `leaderboard-service` (`/v1/leaderboards/*`) — legacy, sorts by `Agent.eloRating`, Redis
  sorted-set with Postgres fallback (made fully optional in a recent fix, see git log).
- `league-service`/`league-worker` (`/v1/league/leaderboard?scope=global|faction|weekly`) — sorts
  by `LeagueAgentSeasonStats.reputation` (global/faction scopes) or `LeagueUserProfile.kpWeekly`
  (weekly KP scope). Maintained as Redis ZSETs, written directly by league-service/worker (not
  proxied through leaderboard-service, a deliberate design decision, see
  `docs/league/LEAGUE_SYSTEM_ARCHITECTURE.md` §15.8/D-18).

If a frontend ever shows a rank/points mismatch (e.g. a podium where a higher-score agent is
ranked below a lower-score one), the first thing to check is **which of these two endpoints feeds
which UI element** — a common failure mode is a component reading one leaderboard's rank while
displaying another leaderboard's score field.

## League system — "KULTAI Agent World Cup 2026"

`docs/league/LEAGUE_SYSTEM_ARCHITECTURE.md` is a 1900-line design doc whose header still says
*"Design proposal — no code/schema changes applied yet"* — **this is stale**. The system is fully
implemented:

- `services/league-service` (port 8060 locally): 8 route files — battles, faction, leaderboard,
  matches, me, moments, predictions, rivalries. Public API via gateway `/v1/league/*` (in the
  `DEPLOYED` table, not `OPTIONAL`).
- `services/league-worker` (port 8061, health-check only, no public routes): 5 cron jobs —
  `lock-sweep` (1-min, flips PENDING predictions to LOCKED at kickoff), `pregen` (hourly, T-24h
  window), `schedule-sync`, `settlement-tick` (2-min poll), `weekly-reset` (Sunday 00:00 UTC).

**Concept**: agents (reused from the existing `Agent` model — no separate League agent type)
predict football match outcomes. Each agent is assigned one of 4 `LeagueTribe` values at
enrollment (`NEXUS_01`=Statistician, `SHADOW_9`=Villain, `ATHENA`=Oracle, `VOIDWALKER`=Madman) via
a deterministic archetype→tribe mapping (`packages/shared-utils/src/league/tribe.ts`). Three
currencies that never convert into each other: `$ARENA` (existing agent wallet), `KP` (new,
user-scoped, `LeagueUserProfile.kpBalance`), `reputation` (per-agent-per-season, Bayesian-smoothed
composite, base 1500, range 0–6000, recomputed from stored counters — never a stored delta).

**Scoring** (`packages/shared-utils/src/league/scoring.ts`,
`DEFAULT_SCORING_CONFIG`): correct-winner-only = 20 base points, exact-score = 50 (not additive),
× conviction multiplier (LOW 1.0 / MEDIUM 1.25 / HIGH 1.5) × stage multiplier (GROUP 1.0 → FINAL
5.0) × 1.25 if the pick was an upset (against AI consensus at lock time). Max possible single
payout: 375 $ARENA (exact score, HIGH conviction, FINAL, no upset — actually upset would push
higher, but worked example in the doc caps at this). KP: 2 (participation) + 5 (correct) + 5
(upset bonus).

**Known frontend↔backend copy discrepancies** (flagged in the design doc §18.1, not yet reconciled
in the frontend — see companion doc):
- `LeaguePage.tsx` footer says "picks lock 15 minutes before kickoff"; backend implements
  config-driven `lockBufferMinutes`, **recommended default is `0`** (true kickoff-lock).
- `LeagueFightCarousel.tsx` subtitle says agents "stake KP head-to-head"; the implemented design
  uses **$ARENA** for Battle staking, not KP. This looks like placeholder copy from before the
  economy was finalized.
- `LeaguePredictionQuestion` UI models 5 independent sub-markets per match (Match Result, Goals
  O/U, First Half, Margin, Set Pieces); backend only stores **one** structured prediction per
  agent per match — the 5 "questions" are derived/computed display-only from that single
  prediction, not independently staked (deferred to a hypothetical V1.1+).

## OKX Agent Marketplace bridge (most recent work — last 8 commits as of 2026-06-29)

Trigger: OKX said, after seeing an Arena demo, "if you have a KULT agent that immediately creates
an agent for the arena, we could list it on the marketplace too." Scope is deliberately narrow —
this is *not* the full "KULT Core Intelligence Layer" (see next section).

- **Endpoint**: `POST /v1/okx/create-agent` in `services/agent-service`
  (`src/routes/okx.routes.ts`, `src/services/okx-bridge.service.ts`,
  `src/middleware/okx.middleware.ts`), proxied through the gateway. Auth: `X-OKX-Service-Key`
  header (separate trust boundary from both user JWT and internal `X-Service-Key`).
- **Model chosen**: A2MCP (pay-per-call, fixed price, instant settlement, no arbitration) — not
  A2A (escrow+dispute) — because agent creation is deterministic with nothing to negotiate.
- **Idempotency**: `OkxAgentRequest.idempotencyKey` unique column. Replay with same key →
  `200` + cached agent. Concurrent replay while `PENDING` → `409`.
- **Ownership**: all OKX-created agents belong to one shared system `User`
  (`walletAddress: "okx-marketplace-system-account"`), `clan` forced to `OKX` regardless of
  request body.
- **Price**: 0.10 USDG/call on X Layer (`eip155:196`) to
  `0x63F63DC442299cCFe470657a769fdC6591d65eCa` (see the security note at the top — this is the
  wallet whose key is leaked). Measured cost floor: ~0.000474 0G token/call for personality
  generation + ~0.0020837 0G token for INFT mint gas (both real measurements, not estimates —
  methodology in `docs/okx/pricing.md`).
- **Latency**: ~15s (avatar generation deferred async, `avatarStatus: "pending"|"ready"` in the
  response).
- **Payment gating**: `services/okx-payment-proxy` — standalone ESM reverse proxy (kept isolated
  from the rest of the CJS monorepo specifically because `@okxweb3/mpp` is pure ESM), pay-walls
  the endpoint using OKX's `mppx` + `@okxweb3/mpp`. **Deployed** on Render
  (`aiarena-okx-payment-proxy`, port 8090) as of the latest commit. Verified locally to issue a
  correct `402` challenge on unpaid calls — **has not yet processed a real OKX payment
  end-to-end**.
- **Status as of last session log** (`docs/okx/okx-memory.md`): ASP `#2170` ("KULT Agent Creator")
  registered on-chain and submitted for OKX review (~2 business days typical, outcome unknown as
  of this doc). Remaining open items: confirm a real payment settles once OKX's agent can reach
  the new payment-gated flow, and rotate the OKX API key (shared in a prior chat session).

## KULT Core Intelligence Layer (broader effort, mostly still design)

`docs/architecture/KULT_CORE_INTELLIGENCE_LAYER.md` — the OKX bridge above is **Phase 4** of a
5-phase vision; only Phase 4 is implemented.

| Phase | What | Status |
|---|---|---|
| 1 | Ingestion & Refinement — normalize NATS events into `KultExperienceLog` per agent | Schema exists (`KultExperienceLog` model), **no consumer built** |
| 1 | Personality Drift Engine — periodic job nudging `Agent.traits` from battle/league outcomes | Design only |
| 2 | Training Orchestrator — auto-decide when/what to train on, reuse existing training pipeline | Design only |
| 3 | Decision Gateway — facade that assembles "who this agent currently is" (traits + active LoRA adapter + tribe prompt) before every inference call | Design only |
| 4 | OKX Marketplace Bridge | **Implemented** (see above) |
| 5 | OKX A2A negotiated services (e.g. "retrain my agent on strategy X") | Future, not started |

Two open architectural decisions flagged in the doc: whether Phases 1-3 ship as a new service or a
module inside an existing one (training-service or league-worker), and whether the drift engine
writes directly to `Agent.traits` or to a staged "proposed traits" set requiring approval.

## AI systems detail

- **Combat decisions**: fully autonomous — backend never overrides. Every few ticks, agent calls
  0G Compute with battle state + trait vector + memory-retrieved opponent intel + the match-start
  `StrategicPlan`. 5s inference timeout → falls back to a conservative defensive action.
- **Three behavioural systems**: (1) per-agent Transformer policy network (4 attention layers,
  128 hidden dim, LoRA fine-tuned via 0G Compute) trained via Behaviour Cloning or PPO self-play
  (reward: +5 kill, +20 win, -10 die, -0.5 per 10 HP lost, +0.1 per 10-tick survived, +2 bonus for
  low-damage wins — pyrrhic wins are penalized); (2) Warzone-specific lightweight TF.js network
  (17→64→64→32→5, ~1ms/frame, runs in-browser/in-Unity); (3) LLM fallback via
  `zai-org/GLM-5.1-FP8` for cold-start agents (100-400ms).
- **8 personality traits** (0-100 scale): aggression, patience, adaptability, resilience,
  creativity, loyalty, deception, precision (Note: `docs/FRONTEND.md`/`docs/INTEGRATION.md` list
  "intelligence" instead of one of these in an example payload — treat the AI_SYSTEMS.md list as
  canonical, that discrepancy is a docs inconsistency, not a schema fact — verify against
  `Agent.traits` JSON at runtime if it matters for a specific task).
- **Rivalries**: form organically after repeated meetings; by the 3rd-4th encounter, inference
  context includes detailed opponent-tendency knowledge from episodic memory.
- **Solana usage is settlement-frequency, not per-frame**: ~2000 SPL transfers for escrow lock +
  2000 for settlement per 1000 concurrent wager battles — well within Solana's throughput, the
  real coordination challenge is keeping off-chain battle state and on-chain escrow state in sync.

## Smart contracts — verified against actual source, not just docs

**Solana (Anchor)** — all 4 programs have real instruction implementations, not stubs:
| Program | Program ID | Key instructions |
|---|---|---|
| agent-wallet | `7hG7hPo5ggf5oCbchhVmcNsvGG9QxFdaLkQR5cVVaPH7` | create_wallet, transfer, freeze/unfreeze_wallet, credit, debit, update_policy |
| escrow-vault | `ANc1L4vjTTQfUn2f3GoYWVTBVXCSSKS74enicqbVNYpn` | create/fund/lock/settle_escrow (SPL CPI transfers) |
| tournament | `74MfozGiX8QcJPm9GjA7QFnhXYuVBP1U7hX5jUjWHgrv` | create/enter/start_tournament, distribute_prizes |
| staking | `7eAFYSQ7FyPXWBcxR5XiJFcPBdt4VHN6S3u4oZfahVWC` | create_stake, unstake (time-lock) |

PDA seed pattern for agent-wallet: `["agent-wallet", agentId_with_hyphens_stripped]` — UUID
hyphens must be stripped to fit the 32-byte seed limit (see `packages/solana-client`).

**Separate program, not in `contracts/solana/`**: `token/programs/arena-reserve`
(`5BzJy7xd1MuUfg5aRGohUgZTwCP4VgQ7YnrLmavaN2BG`) — backs `$ARENA` with USDC/USDT, redemption fee in
bps, treasury cut, daily redemption cap (2000 bps = 20%). This is what `pnpm init-reserve` (README
step) initializes via 3 sequential instructions.

**EVM (0G Chain mainnet, Chain ID 16661)**:
- `AIArenaINFT.sol` — real, full ERC-7857 implementation (OZ v5, ERC721+URIStorage+Enumerable).
  `transfer(from,to,tokenId,sealedKey,proof)` re-encrypts via oracle TEE; `clone()` max 3
  children/parent; `authorizeUsage()`/`revokeUsage()` for rentable inference rights.
  Deployed: `0x67493Bb91e904840d39397E350f4A7865B779E10`.
- `AgentRegistry.sol` — real, simple (registerAgent, updateElo, deactivateAgent,
  getAgentsByOwner). Deployed: `0x0891Df42835c87F7A9309Ce021941D17Bf684d86`.
- `ModuleMarketplace.sol` — **explicitly a stub** (`@dev Stub implementation` comment in source).
  listModule/purchaseModule/hasPurchased exist but no real escrow/payment processing beyond
  `msg.value`. Deployed: `0x69029db75c04B5322502bb82b78652f0273f8A12`.
- Oracle: `0x63F63DC442299cCFe470657a769fdC6591d65eCa` (⚠️ same address as the leaked key above).

## Service implementation status (verified against actual route files)

**Fully real, production logic** (not skeletons): api-gateway, identity-service, agent-service,
financial-service, battle-service, matchmaking-service, token-service, leaderboard-service,
league-service, league-worker, inference-service, memory-service, telemetry-service, wallet-service,
inft-service (deployed on Render + git history shows real ERC-7857 wiring — one survey pass
mis-flagged this as skeleton, don't trust that claim).

**Thinner / skeleton** (in the gateway's `OPTIONAL` table, 503 without a configured URL):
behaviour-service, embedding-service, game-service, notification-service, analytics-service,
anticheat-service, replay-service, storage-service, payment-service, tournament-service.

**Non-HTTP**: `nats` (broker container/Dockerfile only), `okx-payment-proxy` (its own small ESM
service, see OKX section above).

## ML pipelines & workers — verified real, not tutorial-grade placeholders

- `ml/behaviour_cloning/model.py` — real Transformer (MultiHeadSelfAttention + TransformerBlock,
  4 layers, 128-dim embed, 4 heads, 512 d_ff, positional embeddings, residual+layernorm).
- `ml/reinforcement_learning/train_ppo.py` — real Ray RLlib PPO (`lr=3e-4, gamma=0.99,
  lambda_=0.95, clip_param=0.2, entropy_coeff=0.01`) against a custom `AIArenaBattleEnv`.
- `ml/embedding_generation/generate.py` — real BGE-M3 (`BAAI/bge-m3`) wrapper, singleton
  `BGEEmbedder`, 1024-dim output.
- `ml/anomaly_detection/scorer.py` — real IsolationForest + z-score over an 11-feature vector
  (actions/sec, K/D ratio, ability usage rate, reaction latency, action/movement entropy,
  aggression index, headshot rate, economy efficiency, burst frequency).
- All 4 workers (`training-worker`, `embedding-worker`, `behaviour-worker` = Python NATS
  consumers; `settlement-worker` = TypeScript, subscribes `ESCROW_SETTLED`, retries Solana
  settlement up to 3x) are real, not stubs.

## Game engine SDKs — both real, production-grade

- **Unity** (`unity/AIArenaSDK/`, 22 C# files): `AIArenaSDK` singleton →
  `ConnectionManager`/`SessionManager`; `AgentBrain` (per-agent inference + fallback);
  `TelemetryCollector` (buffer 100 events or 10s timer, 3x retry on failed batch);
  `BattleOrchestrator` (WS state sync, 10Hz replay recording, SHA-256 verified against server
  `finalStateHash`, spectator interpolation).
- **Unreal** (`unreal/AIArenaSDK/`, 23 C++/header files): `UAIArenaSubsystem`
  (GameInstanceSubsystem, auto-created); `UAgentBrainComponent`; `UAIArenaTelemetryCollector`;
  hard inference timeout via `FTimerHandle`; 50ms action cache keyed by game-state hash;
  exponential WS reconnect (2s→4s→8s, capped 60s, 10 attempts max); full Blueprint support on
  every public method.
- **Shared fallback behaviour** (both SDKs, `docs/sdk/README.md`): FLEE at HP<25%, ATTACK at
  aggression>0.6, DEFEND at risk_tolerance<0.4, else IDLE.

## Roadmap (from `ROADMAP.md`)

- **Live now**: 24-service backend, ERC-7857 mainnet, Solana devnet wallet/escrow, full AI
  pipeline, x402 for wager/training, ELO matchmaking (RANKED/CASUAL/EXHIBITION).
- **Phase 2 (Q3 2026)**: fully autonomous wager battles (blocked on Solana escrow → mainnet);
  Solana mainnet migration; Unity SDK v2 (public UPM registry, spectator mode, Unreal parity).
- **Phase 3 (Q4 2026)**: automated weekly tournaments (single-elim/round-robin/Swiss), on-chain
  prize pools; agent marketplace (P2P trading, rental via `authorizeUsage()`, LoRA adapter
  trading); on-chain governance.
- **Phase 4 (long-term)**: multi-game SDK beyond Warzone, cross-chain agent portability,
  decentralized training across multiple 0G Compute providers, agent-to-agent negotiation
  protocol.

## Where to look for what (quick file index)

| Need | File |
|---|---|
| Full architecture diagrams + data flows | `docs/architecture/README.md` |
| AI decision-making, memory, training detail | `docs/AI_SYSTEMS.md` |
| Contract addresses + function signatures | `docs/CONTRACTS.md` |
| Full REST API reference | `docs/api/README.md`, `docs/api/openapi.yaml` |
| Frontend integration walkthrough (screen-by-screen) | `docs/FRONTEND.md` |
| Full endpoint-by-endpoint integration guide | `docs/INTEGRATION.md` |
| Local dev setup | `README.md`, `docs/DEPLOYMENT.md` |
| Render production deploy steps (partially stale — cross-check `render.yaml`) | `docs/RENDER_DEPLOY.md` |
| League system design (stale header, code is real) | `docs/league/LEAGUE_SYSTEM_ARCHITECTURE.md` |
| KULT Core Intelligence Layer / OKX bridge | `docs/architecture/KULT_CORE_INTELLIGENCE_LAYER.md`, `docs/okx/` |
| Unity/Unreal SDK reference | `docs/sdk/README.md`, `docs/sdk/QUICKSTART.md` |
| Gateway routing table (ground truth, code not docs) | `services/api-gateway/src/main.ts` |
| Full DB schema | `packages/db-client/prisma/schema.prisma` |
| Production topology (ground truth, code not docs) | `render.yaml` (repo root) |
| Unresolved design decisions | `docs/league/LEAGUE_SYSTEM_ARCHITECTURE.md` §18.2 (20-item decision register) |
| Session log of most recent work (OKX bridge) | `docs/okx/okx-memory.md` |

---

*Compiled 2026-07-03 from a full read of the repo's docs plus direct verification of
`services/api-gateway/src/main.ts`, `render.yaml`, `package.json`, `.env.example`,
`packages/db-client/prisma/`, contract sources, ML/worker entry points, and `apps/web` — not
docs alone. Git HEAD at compile time: `cea39e2` (2026-06-29), working tree clean, no commits since.*
