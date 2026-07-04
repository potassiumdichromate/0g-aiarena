# Polymarket Integration — Knowledge Base & Plan

**Status:** Planning complete, compatibility verified, implementation not yet started
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

### Phase 3 — Wallet: add Polygon
- Add `polygon` to Privy's `supportedChains` in `privyConfig.ts`.
- Surface a USDC balance readout for that chain in the existing wallet UI.
- Still no trading — just proves the chain/balance plumbing works for real funded wallets.

### Phase 4 — Trade execution: wire `@polymarket/clob-client`
- One-time "enable trading" flow (2 on-chain approvals + derive-API-key signature, cached client-side per wallet).
- Wire the real YES/NO buttons: build → sign → submit order via `clob-client`, using the Privy viem `WalletClient` as signer.
- **Test live with a small real bet on a funded test wallet before calling this phase done** — this is the one part of the whole feature that moves real user funds, and the geoblocking/ToS unknowns from Section 4 can only be resolved by actually trying it.

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
| 1 | Signal generation service (0G Compute + League reputation reuse) | ⬜ Not started |
| 1 | `POST /v1/polymarket/signals/:marketId/:agentId/generate` | ⬜ Not started |
| 1 | `GET /v1/polymarket/signals/:marketId` | ⬜ Not started |
| 2 | Signal badge UI in `LeaguePolymarketBoard.tsx` | ⬜ Not started |
| 3 | Polygon added to Privy `supportedChains` | ⬜ Not started |
| 3 | USDC balance readout (Polygon) | ⬜ Not started |
| 4 | One-time enable-trading flow (approvals + API key derivation) | ⬜ Not started |
| 4 | Real order signing + submission wired to YES/NO buttons | ⬜ Not started |
| 4 | Live test with a real funded wallet | ⬜ Not started |

**Update this table every time a checkbox changes state. Do not let it go stale.**

No pending manual steps. All four League-inference bugs are fixed and confirmed live. Phase 1 signal-generation service work starts now.

---

## 7. Open Decisions & Risks

- **Geoblocking on order placement** — unresolved until Phase 4's live test (Section 4). If it turns out to block a meaningful user segment, the fallback is the deep-link-to-polymarket.com option discussed and set aside earlier, not a code workaround.
- **Compliance** — Polymarket ToS restricts US persons. Not a Kult Games engineering decision; flagging so it doesn't get silently missed.
- **One-time enable-trading UX** — 2 on-chain approval transactions + 1 signature before a user's first-ever bet is real friction. Worth a dedicated, clearly-explained UI moment (Phase 4) rather than surprising the user with wallet popups.
- **`polymarket-service` naming** — currently planned as routes/services inside `league-service` rather than a new deployable (Section 3 rationale). Revisit if it grows large enough to warrant its own service + Render deploy.

---

## 8. Changelog

- **2026-07-05** — Doc created. Product intent, architecture, compatibility verification, and phased plan captured following user discussion. No implementation started yet.
- **2026-07-05** — Started Phase 1. Added `PolymarketSignal` model + hand-authored migration (`packages/db-client`, commit `1bd0989`). While wiring the signal-generation service to reuse League's 0G Compute pipeline, discovered `/league-prediction` was never registered as an HTTP route in `inference-service` despite `decideLeaguePrediction` being fully implemented — every League prediction has silently been falling back to the deterministic generator instead of real AI. Fixed by registering the route (commit `8469d3b`), per user's explicit choice to fix it now rather than defer it.
- **2026-07-05** — User applied the `PolymarketSignal` migration to production via Render shell (confirmed applied). Live-tested the route fix with a fresh League pick — still fell back. Render logs showed a second, independent bug: `aiarena-inference` has never had `DATABASE_URL` configured, so `decideLeaguePrediction`'s own `prisma.agent.findUnique()` call throws before its internal 0G Compute try/catch is even reached, 500ing the request, which `league-service`'s outer catch silently swallows into its own fallback. Added `DATABASE_URL` to `aiarena-inference` in `render.yaml` (commit `7c4f727`); user set it manually in Render's Environment tab and redeployed.
- **2026-07-05** — User re-tested with a fresh pick after the `DATABASE_URL` fix — the Prisma crash is gone, but logs showed a *third* independent bug in the same chain: `Error: Timeout: inferLeaguePrediction took longer than 12000ms`. The configured chat model (`zai-org/GLM-5.1-FP8`) is reasoning-capable and consistently exceeds the original 12s budget on this call's structured tool-call response. Raised `LEAGUE_PREDICTION_TIMEOUT_MS` to 25s, matching/slightly exceeding `strategy-plan`'s 20s budget for a similarly-shaped response (`e6faf98`).
- **2026-07-05** — User re-tested again — timeout error gone, but a *fourth* bug surfaced: `Error: No parseable league prediction in 0G Compute response`, thrown from `ZeroGComputeClient.inferLeaguePrediction`. `compute.client.ts` already documents this exact model as a "thinking" model that prepends chain-of-thought before its tool call — the call's `max_tokens: 300` was very likely too tight to fit both the reasoning and the final structured JSON, truncating the response before anything parseable was emitted. Raised to 1200 (`17c7ce6`, `packages/zerog-client`).
- **2026-07-05** — User re-tested once more after the max_tokens fix redeployed: **confirmed working**. Network response showed real, specific AI reasoning ("France's squad depth, tournament pedigree, and attacking output metrics significantly outpace Paraguay's...") and `"source": "AI"`. All four League-inference bugs are now fixed end-to-end. Moving on to build the Polymarket signal generation service and its two endpoints (Phase 1 tasks #15/#16).
