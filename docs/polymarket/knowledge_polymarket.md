# Polymarket Integration — Knowledge Base & Plan

**Status:** All four phases (signal generation, signal UI, Polygon wallet, real trade execution) built and pushed. Last remaining step: a live end-to-end trade test with a real funded wallet (no such wallet exists in this dev environment).
**Scope:** Additive feature on the existing Kult Games platform (0G-AIArena backend + kult-games-v3 frontend), separate from and independent of the League feature (`docs/league/LEAGUE_SYSTEM_ARCHITECTURE.md`)
**This file is a living doc.** Update it every time scope, decisions, or progress change — do not let it drift from the actual code.

---

## Table of Contents

1. [Product Intent](#1-product-intent)
2. [What Already Exists](#2-what-already-exists)
3. [Architecture](#3-architecture)
4. [Compatibility Verification](#4-compatibility-verification)
5. [Phased Plan](#5-phased-plan)
6. [Progress Tracker](#6-progress-tracker)
7. [Open Decisions & Risks](#7-open-decisions--risks)
8. [Changelog](#8-changelog)

---

## 1. Product Intent

The Polymarket page is a **separate game mode** from League (toggled via `LeagueModeTabs` in `LeaguePage.tsx`), not a replacement or extension of it.

**What the user asked for, verbatim intent:**
- Users bet on real Polymarket markets **with their own funds** (USDC/USDT, already deposited by the user themselves into their own wallet — on Polygon or wherever Polymarket requires). Kult Games never custodies funds, never funds a wallet, never bridges anything for the user.
- The user's AI agent — the same agent that plays League and has a tribe/reputation/track record from doing so — gives a **signal**: YES or NO on a given market, with a confidence and reasoning, the same way it gives predictions in League.
- The user reads the signal and **manually decides** whether to place the bet. The agent does not auto-trade. This is signal-then-human-click, not autonomous trading.

**Two independent halves fall out of this:**
1. **Signal generation** (read-only, backend, zero financial risk) — "what does my agent think about this market."
2. **Trade execution** (real money, client-side wallet signing) — "let me actually place that bet using my own funds."

These ship independently. Signal generation has no dependency on trade execution and should be built and shipped first.

---

## 2. What Already Exists

Confirmed by reading the actual code, not assumed:

- **`src/api/polymarketApi.ts`** (kult-games-v3) — a direct, key-less, client-side integration with Polymarket's public REST APIs:
  - `GAMMA_BASE = "https://gamma-api.polymarket.com"` — market metadata, current prices, events, comments.
  - `CLOB_BASE = "https://clob.polymarket.com"` — price history for charts (`fetchPriceHistory`).
  - Everything here is **read-only** and football-filtered client-side (`FOOTBALL_TERMS` allowlist). Degrades to `[]` on any failure — no crash path.
  - This already works in production; the Polymarket board shows real live market data today.
- **`src/components/league/LeaguePolymarketBoard.tsx`** (~2000 lines) — the full UI: market list, featured event carousel, price charts, live comment feed, category filters. Real data throughout.
  - The **"YES signal" / "NO signal" buttons exist in the UI but have no `onClick` handler** — purely decorative today. This is the same "inert button" pattern League's "Make Pick" button had before it was wired up.
  - No agent signal is displayed anywhere yet — no call to any backend for an AI read on a market.
- **No trading capability anywhere.** No wallet connect scoped to Polymarket, no order signing, no CLOB write calls.
- **Wallet/chain reality check:** `src/lib/privyConfig.ts` configures Privy with `supportedChains: [mainnet, zeroGChain]` (0G Mainnet, chain `16661`) only. **No Polygon support exists in this app today.** Polymarket settles on Polygon and requires USDC held there. `AuthContext.tsx:305-306` already calls `wallet.switchChain(...)` post-login to point the wallet at 0G — this is the precedent pattern to reuse for adding Polygon (same wallet address, different active chain per-action, not a new identity).
- **League's backend patterns to reuse, not reinvent:**
  - `LeaguePrediction` model + `generatePrediction`/`ensurePrediction` idempotent-generate pattern (`services/league-service/src/services/league-prediction.service.ts`).
  - Tribe system prompts + 0G Compute inference pipeline (`decideLeaguePrediction`), with a deterministic `FALLBACK` path if 0G Compute is degraded — inference never blocks generation.
  - Agent reputation / accuracy record (`LeagueAgentSeasonStats`) — already computed, already exposed via `GET /v1/league/me/agents`.
  - The exact bug just fixed in League — predictions/results not surviving page refresh because there was no GET path for "does this already exist" — is the #1 mistake **not** to repeat here. Any signal read path must exist from day one, not be bolted on after a user complains.

---

## 3. Architecture

Two independent layers. The backend is never in the money path — no custody, no server-side signing, ever.

```
┌─────────────────────────────── BROWSER / FRONTEND ───────────────────────────────┐
│                                                                                     │
│  LeaguePolymarketBoard      Signal badge (NEW)         Order signer (NEW)          │
│  (existing, real data)      "YES 72% — Nexus-07"       builds + signs EIP-712      │
│  market list/prices/chart   reads polymarket-service    order via Polygon wallet    │
│                                    │                          │                     │
└────────────────────────────────────┼──────────────────────────┼─────────────────────┘
                                     │                          │
                    POST /v1/polymarket/signals/                │ signed order
                    :marketId/:agentId/generate                 │ POSTed straight
                                     │                          │ to Polymarket —
                                     ▼                          │ backend never sees it
┌──────────────────── KULT GAMES BACKEND — polymarket-service (NEW) ─────────────────┐
│  extends league-service, does not stand up a new deployable                         │
│  1. fetch market by id (Gamma API, server-side)                                      │
│  2. pull agent's League tribe + reputation + accuracy record                          │
│  3. call 0G Compute → { signal: YES|NO, confidence, reasoning }                       │
│  4. persist PolymarketSignal row (idempotent generate-or-return, same as League)      │
│  5. GET /v1/polymarket/signals/:marketId — read path, exists from day one             │
└──────────────────────────────────┬──────────────────────────────────────────────────┘
                                     │
                                     ▼
                     ┌───────────────────────────────┐
                     │           0G Compute             │
                     │  same inference pipeline as       │
                     │  League — reused, not duplicated  │
                     └───────────────────────────────┘

┌──────────────────────── TRADE EXECUTION (client-side only) ────────────────────────┐
│  One-time per wallet ("enable trading", first bet attempt):                          │
│    1. approve USDC + CTF tokens to Polymarket's Exchange contract (2 on-chain txs)    │
│    2. sign one message → derive CLOB API key (no gas), cache client-side              │
│                                                                                        │
│  Every bet:                                                                           │
│    3. read current best price (Gamma/CLOB, already wired)                             │
│    4. build order (tokenId, side, price, size)                                        │
│    5. sign via wallet (EIP-712, no gas) — viem WalletClient from Privy                 │
│    6. POST signed order + API key to Polymarket CLOB /order                           │
│    7. matched off-chain → settled on-chain via CTF Exchange (Polygon)                 │
│                                                                                        │
│  Backend touches NONE of this. No custody, no server-side signing, no funds ever      │
│  pass through Kult Games infrastructure.                                              │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

**Key design decisions locked in:**
- `polymarket-service` is a new set of routes/services **inside `league-service`**, not a new Render deployable — it needs the same agent/reputation/0G Compute access League already has, and stands up faster by extending rather than duplicating that plumbing.
- Signal persistence exists via a **read GET endpoint from day one** (`GET /v1/polymarket/signals/:marketId`), not just a POST-generate-and-hold-in-React-state pattern. This directly avoids the refresh-persistence bug already hit and fixed once in League.
- Trading requires adding `polygon` to Privy's `supportedChains`. This does **not** change how login/SIWE/0G Mainnet works elsewhere in the app — same wallet address, `switchChain()` scoped to the moment of signing/checking a Polygon balance, exactly like the existing 0G-login pattern.
- No funding/bridging flow is being built. The user deposits their own USDC/USDT into their own wallet on Polygon themselves, entirely outside this app's scope.

---

## 4. Compatibility Verification

Done empirically (installed the real package, ran a real build), not from documentation alone.

| Check | Result |
|---|---|
| `@polymarket/clob-client@5.8.1` dependency tree | `axios`, `viem@^2.46.3`, `browser-or-node`, `@polymarket/builder-signing-sdk` (itself just `axios`). No Node-only packages anywhere in the tree. |
| Node-only APIs (`fs`, `crypto` module, `Buffer`, `child_process`) | **None found** anywhere in `dist/`. Uses `globalThis.crypto.subtle`, `atob`/`btoa` — browser-native. |
| `browser-or-node` usage | Used once, in `http-helpers/index.js`, to skip setting a few HTTP headers browsers block anyway (`User-Agent`, etc.) — a deliberate, narrow browser-support shim, not a red flag. |
| Signer interface (`signer.js`) | Explicitly supports **either** an ethers `_signTypedData` signer **or** a **viem `WalletClient`** (checks for `.signTypedData` + `.account`). Privy's embedded wallet produces exactly a viem `WalletClient` — no raw private key ever needs to touch our code. |
| Module format | Pure ESM (`"type": "module"`), Vite-native, no CJS interop needed. |
| Real isolated Vite production build | **Built clean** importing `ClobClient` + a viem `WalletClient` targeting Polygon — 391ms, no errors. One harmless externalize warning for `node:worker_threads` deep inside an unrelated viem helper (`ox`), not on our code path. |
| `viem` version collision check | Real project (`kult-games-v3`) already resolves a single deduped `viem@2.47.4` across Privy's entire dependency tree. Satisfies clob-client's `^2.46.3` — **no duplicate/conflicting viem in the bundle.** |
| TypeScript types | Resolve cleanly against the viem-`WalletClient`-as-signer usage. |
| Geoblocking | **Inconclusive from the sandbox used to check this** — outbound TCP to `gamma-api.polymarket.com` / `clob.polymarket.com` timed out (no HTTP response at all) while `google.com` succeeded from the same environment, which points at that sandbox's own network allowlist rather than proof of Polymarket blocking. The app's actual deployed frontend already successfully pulls live Gamma data in real users' browsers today, so read access is clearly not blocked in production. The **order-signing/derive-API-key endpoints specifically**, from a real funded wallet in a real browser, have not been tested — that's a live-testing step during Phase 4, not something resolvable by static/sandbox checks. |
| Compliance note (not a technical finding) | Polymarket's Terms of Service restrict US persons from trading regardless of any technical/IP block. This is a product/legal decision for the user to be aware of, not something to route around in code. |
| **Collateral token — corrected during Phase 4** | Originally assumed Polymarket had migrated to native (Circle) USDC. Verified directly against Polymarket's own published `@polymarket/clob-client` package (`dist/config.js`, `MATIC_CONTRACTS.collateral`): it's actually bridged **USDC.e** (`0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174`), not native USDC (`0x3c499c...`). Phase 3's balance readout was showing the wrong token's balance until this was caught and fixed (`b84cd4c`) — a real, user-facing correctness bug that would have shown $0 for a properly-funded wallet. |
| Contract addresses (Exchange, Neg-Risk Exchange/Adapter, Conditional Tokens) | Same source as above (Polymarket's own client package), not memory or a scraped webpage — `docs.polymarket.com` hit the same network restriction as the Gamma/CLOB APIs from this sandbox, so the npm package's bundled config was used as the authoritative source instead. See `polygonUsdc.ts`'s `POLYMARKET_CONTRACTS`. |
| Builder code (Polymarket's affiliate/revenue-share program) | **Not required** for orders to work at all — a user's own wallet signature + a per-wallet derived API key is sufficient. Registering as a "builder" is a separate, optional business decision (revenue share on routed volume + official attribution), requiring outreach to Polymarket's partnerships team directly — not something achievable through code, and not something done here. |

**Conclusion: nothing blocks the "extend Privy to Polygon + `@polymarket/clob-client`" path.**

---

## 5. Phased Plan

Ordered so the safest, most-independently-valuable part ships first, and the money-handling part comes last, after the signal half has had time to prove out with real users.

### Phase 1 — Backend signal service (no wallet, no money, fully decoupled)
- New `PolymarketSignal` Prisma model.
- New service inside `league-service`, mirroring `league-prediction.service.ts`'s idempotent generate-or-return pattern.
- `POST /v1/polymarket/signals/:marketId/:agentId/generate` (auth required, rate-limited like League's `generatePrediction`).
- `GET /v1/polymarket/signals/:marketId` (public read path — exists from day one, no refresh-persistence bug possible).

### Phase 2 — Frontend: show the signal
- Wire a "get my agent's read" trigger + signal badge into `LeaguePolymarketBoard.tsx`, next to the existing (still-inert) YES/NO buttons.
- This is the literal core ask — "show them signals from their agent" — and ships with **zero financial/custody risk**. Good checkpoint to get real user feedback before touching money at all.
- **Scope correction found mid-build**: the specific "YES signal"/"NO signal" buttons originally identified for this wiring turned out to render from a fully fabricated `MATCHES` mock array (fake teams, fake prices, no real Polymarket id) — not the real Gamma/CLOB-backed data the rest of the page uses (`TrendingMovers`, `AnalysisView`, `FeaturedEventCard`). Per user decision, replaced that mock grid with a new `RealMarketCard` driven by real market data instead of skipping it — the signal only means something next to a real market question.

### Phase 3 — Wallet: add Polygon
- Add `polygon` to Privy's `supportedChains` in `privyConfig.ts`.
- Surface a USDC balance readout for that chain in the existing wallet UI.
- Still no trading — just proves the chain/balance plumbing works for real funded wallets.
- **Implementation note**: a balance read doesn't need a wallet chain-switch at all — a plain public-RPC `viem` client can read Polygon state regardless of what chain the wallet is currently "active" on. `wallet.switchChain()` is only needed in Phase 4, at the moment of actually signing a Polygon-domain order.

### Phase 4 — Trade execution: wire `@polymarket/clob-client`
- One-time "enable trading" flow, run idempotently before every order rather than as a separate step: USDC approve + Conditional Tokens `setApprovalForAll`, to **both** the standard Exchange (`0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E`) and the Neg-Risk Exchange (`0xC5d563A36AE78145C45a50134d48A1215220f80a`) — 4 approval transactions total the first time, not 2 as originally estimated, since covering multi-outcome (neg-risk) markets alongside ordinary binary ones needs both pairs. Then derive/cache the wallet's own CLOB API key (1 signature, no gas).
- Wire the real YES/NO buttons: build → sign → submit a market order via `clob-client`'s `createAndPostMarketOrder`, using the Privy viem `WalletClient` as signer.
- **Test live with a small real bet on a funded test wallet before calling this phase done** — this is the one part of the whole feature that moves real user funds, and the geoblocking/ToS unknowns from Section 4 can only be resolved by actually trying it. **Still outstanding** — no funded wallet exists in this dev environment.

---

## 6. Progress Tracker

| Phase | Item | Status |
|---|---|---|
| 0 | Product intent clarified with user (own funds, agent gives signal only, user clicks) | ✅ Done |
| 0 | Existing frontend/backend audited (Section 2) | ✅ Done |
| 0 | Architecture drafted and confirmed with user (Section 3) | ✅ Done |
| 0 | `@polymarket/clob-client` browser-compatibility verified (Section 4) | ✅ Done |
| 0 | This doc created | ✅ Done |
| 0 | **Found + fixed four stacked League bugs while wiring this**, each independently causing the same symptom (silent fallback to `"Agent is thinking..."`): (1) `/league-prediction` route never registered in `inference-service` (`8469d3b`); (2) `aiarena-inference` missing `DATABASE_URL` (user fixed via Render's Environment tab); (3) 0G Compute call timing out at the original 12s budget — raised to 25s (`e6faf98`); (4) 300-token budget too tight for the reasoning-model's chain-of-thought + structured answer — raised to 1200 (`17c7ce6`). **Confirmed live** — fresh pick returned real AI reasoning and `"source": "AI"`. League's AI prediction pipeline is now genuinely working end-to-end for the first time. | ✅ Done, confirmed live |
| 1 | `PolymarketSignal` Prisma model + migration | ✅ Done — migration applied to production DB, confirmed via Render shell ("All migrations have been successfully applied") |
| 1 | Signal generation service (0G Compute + tribe persona reuse) | ✅ Done — commit `19e7dac`. `decidePolymarketSignal` in inference-service, `polymarket-signal.service.ts` in league-service (idempotent generate-or-return, same shape as League). Not yet live-tested with a real request (no frontend caller yet) — code paths mirror League's now-verified-working pattern exactly (route registered, DATABASE_URL already present on aiarena-inference, same 25s timeout / 1200 max_tokens). |
| 1 | `POST /v1/polymarket/signals/:marketId/:agentId/generate` | ✅ Done — commit `19e7dac`, proxied through api-gateway `/v1/polymarket` -> league-service |
| 1 | `GET /v1/polymarket/signals/:marketId` | ✅ Done — commit `19e7dac`, public, exists from day one |
| 2 | Signal badge UI in `LeaguePolymarketBoard.tsx` | ✅ Done — commit `3a8e59a` (kult-games-v3). Also replaced the fully-fabricated `MatchCard`/`MATCHES` grid with real Gamma/CLOB-backed `RealMarketCard`s in the process (see §5 scope note below) — that mock data had no real Polymarket id, so wiring a real signal onto it wasn't possible without this. Verified live: all 10 `GET /v1/polymarket/signals/:marketId` calls return 200, signal button correctly opens the real login modal when unauthenticated. |
| 3 | Polygon added to Privy `supportedChains` | ✅ Done — commit `45187f3` (kult-games-v3) |
| 3 | USDC balance readout (Polygon) | ✅ Done — `usePolygonUsdcBalance` (plain viem `publicClient` read, no wallet chain-switch/signature needed) + `PolygonWalletBalance` UI on the Polymarket board. Verified live: correct logged-out state, no console errors. |
| 4 | One-time enable-trading flow (approvals + API key derivation) | ✅ Done — commit `6fc1928` (kult-games-v3). Runs idempotently before every order (each check skipped if already satisfied), not a separate step the user has to find. |
| 4 | Real order signing + submission wired to YES/NO buttons | ✅ Done — `usePolymarketTrading.placeMarketBuy` + `@polymarket/clob-client`'s `createAndPostMarketOrder`. Verified live: buttons render, stake input works, unauthenticated click opens the real login modal, zero console errors. |
| 4 | Live test with a real funded wallet | ⬜ **Not done — this is the one thing left before Phase 4 is truly finished, not just built.** No funded wallet exists in this environment. Needs a human to: fund a Polygon wallet with USDC.e (correct token, see §4 correction below), connect it, click Buy Yes/No, and confirm the whole approvals → order → fill flow actually completes on real Polymarket. |

**Update this table every time a checkbox changes state. Do not let it go stale.**

**Phase 1 backend is code-complete and pushed** (`19e7dac`). Not yet live-tested end-to-end since there's no frontend caller yet — that's Phase 2. When Phase 2 wires the first real call, watch for the same class of issue already found and fixed in League (missing route registration, env vars, timeout, token budget) even though this code was written to already account for all four; the honest thing to do is verify live rather than assume "it mirrors working code so it must work."

---

## 7. Open Decisions & Risks

- **Live end-to-end trade test is still outstanding.** Everything up to the point of an actual funded wallet signing has been verified (UI renders, auth-gating works, no console errors) — but no real order has ever actually been placed and confirmed against Polymarket, because no funded wallet exists in this dev environment. This is the single biggest remaining unknown and should happen before telling users trading is "done."
- **Geoblocking on order placement** — unresolved until the live test above happens. If it turns out to block a meaningful user segment, the fallback is the deep-link-to-polymarket.com option discussed and set aside earlier, not a code workaround.
- **Compliance** — Polymarket ToS restricts US persons. Not a Kult Games engineering decision; flagging so it doesn't get silently missed.
- **One-time enable-trading UX** — turned out to be **4** on-chain approval transactions (not 2 as originally scoped — see §5 Phase 4) plus 1 signature before a user's first-ever bet. That's real friction; worth a dedicated, clearly-explained UI moment rather than four unexplained wallet popups in a row. Not yet built — right now it's silent, sequential prompts.
- **Neg-risk market coverage** — approvals cover both the standard and neg-risk Exchange contracts, so multi-outcome markets should work, but this hasn't been tested against an actual neg-risk market (our football questions are simple binary YES/NO).
- **Builder code** — optional, not built. A business decision (see §4) to register with Polymarket's affiliate program for revenue share, not a technical gap.
- **`polymarket-service` naming** — currently planned as routes/services inside `league-service` rather than a new deployable (Section 3 rationale). Revisit if it grows large enough to warrant its own service + Render deploy.

---

## 8. Changelog

- **2026-07-05** — Doc created. Product intent, architecture, compatibility verification, and phased plan captured following user discussion. No implementation started yet.
- **2026-07-05** — Started Phase 1. Added `PolymarketSignal` model + hand-authored migration (`packages/db-client`, commit `1bd0989`). While wiring the signal-generation service to reuse League's 0G Compute pipeline, discovered `/league-prediction` was never registered as an HTTP route in `inference-service` despite `decideLeaguePrediction` being fully implemented — every League prediction has silently been falling back to the deterministic generator instead of real AI. Fixed by registering the route (commit `8469d3b`), per user's explicit choice to fix it now rather than defer it.
- **2026-07-05** — User applied the `PolymarketSignal` migration to production via Render shell (confirmed applied). Live-tested the route fix with a fresh League pick — still fell back. Render logs showed a second, independent bug: `aiarena-inference` has never had `DATABASE_URL` configured, so `decideLeaguePrediction`'s own `prisma.agent.findUnique()` call throws before its internal 0G Compute try/catch is even reached, 500ing the request, which `league-service`'s outer catch silently swallows into its own fallback. Added `DATABASE_URL` to `aiarena-inference` in `render.yaml` (commit `7c4f727`); user set it manually in Render's Environment tab and redeployed.
- **2026-07-05** — User re-tested with a fresh pick after the `DATABASE_URL` fix — the Prisma crash is gone, but logs showed a *third* independent bug in the same chain: `Error: Timeout: inferLeaguePrediction took longer than 12000ms`. The configured chat model (`zai-org/GLM-5.1-FP8`) is reasoning-capable and consistently exceeds the original 12s budget on this call's structured tool-call response. Raised `LEAGUE_PREDICTION_TIMEOUT_MS` to 25s, matching/slightly exceeding `strategy-plan`'s 20s budget for a similarly-shaped response (`e6faf98`).
- **2026-07-05** — User re-tested again — timeout error gone, but a *fourth* bug surfaced: `Error: No parseable league prediction in 0G Compute response`, thrown from `ZeroGComputeClient.inferLeaguePrediction`. `compute.client.ts` already documents this exact model as a "thinking" model that prepends chain-of-thought before its tool call — the call's `max_tokens: 300` was very likely too tight to fit both the reasoning and the final structured JSON, truncating the response before anything parseable was emitted. Raised to 1200 (`17c7ce6`, `packages/zerog-client`).
- **2026-07-05** — User re-tested once more after the max_tokens fix redeployed: **confirmed working**. Network response showed real, specific AI reasoning ("France's squad depth, tournament pedigree, and attacking output metrics significantly outpace Paraguay's...") and `"source": "AI"`. All four League-inference bugs are now fixed end-to-end.
- **2026-07-05** — Built Phase 1's signal generation service, end to end (commit `19e7dac`): `submit_polymarket_signal` tool schema + `inferPolymarketSignal` in `zerog-client` (mirrors `inferLeaguePrediction`'s exact shape, same model, same generous token/timeout budgets learned from the League fixes above); `generateFallbackSignal` in `shared-utils`; `decidePolymarketSignal` + a parallel `POLYMARKET_TRIBE_SYSTEM_PROMPTS` (rephrased for generic YES/NO questions, not match scores) in `inference-service`; `polymarket-signal.service.ts` + `/v1/polymarket` routes (`POST .../generate`, `GET /signals/:marketId`) in `league-service`; proxy entry in `api-gateway`. All packages typecheck clean. Not yet live-tested — no frontend caller exists yet (Phase 2).
- **2026-07-05** — Built Phase 2 (kult-games-v3 commit `3a8e59a`). Found the intended integration point (the "YES/NO signal" buttons) rendered from a fully mock `MATCHES` array with no real Polymarket id — flagged to user, who chose to replace that mock grid with real Gamma/CLOB data (`RealMarketCard`) rather than skip it. Added `polymarketSignalApi.ts` + `usePolymarketSignal.ts` (mirroring `useMakeLeaguePick.ts` exactly). Verified live end-to-end via a local preview: found and fixed an unrelated pre-existing local-dev bug along the way (`.env` had `PRIVY_APP_ID` without the required `VITE_` prefix, so `PrivyProvider` never got a real app id and crashed the whole app at root with no error boundary — confirmed pre-existing by reproducing it on a clean stash before touching any Polymarket code; fixed by adding the correctly-prefixed var alongside the existing one, `.env` is gitignored so this is local-only). With that fixed, confirmed: real markets render (or gracefully fall back to preview data when Polymarket's own API is unreachable from this network), all 10 `GET /v1/polymarket/signals/:marketId` calls return 200, and the signal button correctly opens the real login modal when unauthenticated.
- **2026-07-05** — Built Phase 3 (kult-games-v3 commit `45187f3`). Added `polygon` to Privy's `supportedChains`; built `usePolygonUsdcBalance` (plain viem `publicClient` read against Polygon's public RPC — no wallet chain-switch or signature needed for a balance check) and a `PolygonWalletBalance` UI row on the Polymarket board. Verified live: correct logged-out ("connect wallet") state renders with no console errors; the balance query correctly stays disabled until a real wallet address exists. Signal generation (Phases 1–2) and wallet balance (Phase 3) are both done — only real trade execution (Phase 4) remains.
- **2026-07-05** — User asked how Polymarket data is fetched and whether a "builder code"/API key is needed before starting Phase 4. Answered: market reads are already key-less public APIs; order placement needs a per-wallet L2 API key (derived automatically, not registered with Polymarket); builder code is a separate, optional revenue-share program requiring direct outreach to Polymarket, not a technical requirement. While researching real contract addresses for Phase 4 (`docs.polymarket.com` hit the same network restriction as the Gamma/CLOB APIs), pulled them from Polymarket's own `@polymarket/clob-client` npm package instead and discovered a real bug: Phase 3's collateral address assumed native USDC, but Polymarket's actual collateral is bridged USDC.e (`0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174`). Fixed immediately (`b84cd4c`) before it could ship a wrong balance to any real user.
- **2026-07-05** — Built Phase 4 (kult-games-v3 commit `6fc1928`): `@polymarket/clob-client` added as a dependency; `polymarketClob.ts` builds a `ClobClient` against the user's own wallet as signer and derives/caches a per-wallet CLOB API key; `usePolymarketTrading.ts` runs an idempotent "enable trading" flow (USDC approve + Conditional Tokens `setApprovalForAll`, to both the standard and neg-risk Exchange contracts — 4 approvals total, not 2 as originally scoped) automatically before every order, then places a real market order via `createAndPostMarketOrder`; `polymarketApi.ts` extended to also capture the NO outcome's own CLOB token id (previously only YES was stored); `RealMarketCard`'s Buy Yes/No are now real buttons with a stake input and live status. Verified live: renders correctly, unauthenticated click opens the real login modal, zero console errors. **Not verified**: an actual signed order completing end-to-end against real Polymarket, since no funded wallet exists in this environment — flagged clearly as the one remaining step, not silently claimed as done.
