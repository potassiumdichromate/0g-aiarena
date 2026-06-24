# Session Log — OKX Agent Marketplace Bridge (2026-06-24)

Chronological record of what was researched, decided, and built in this session, kept here so a
future session (or a future you) doesn't have to re-derive it.

## How this started

OKX, after seeing the AI Arena demo, sent: *"we are launching an AI Agent marketplace soon, and
perhaps if you have a KULT agent, e.g. that immediately creates an agent for the arena, then we
could list it on the marketplace too."* That one sentence is the entire scope of this work —
not the full "KULT Core Intelligence Layer" (which is a separate, broader effort, see
[`../architecture/KULT_CORE_INTELLIGENCE_LAYER.md`](../architecture/KULT_CORE_INTELLIGENCE_LAYER.md)).

## Research phase

1. Fetched/extracted the OKX one-pager (`okxaionepager.netlify.app`, a client-rendered SPA —
   WebFetch can't execute its JS, so it was captured via user-provided screenshots and
   transcribed manually). Covers: the three marketplace roles (User/ASP/Evaluator), A2A
   (negotiated, escrow) vs A2MCP (standard API, pay-per-call) service modes, registration flow
   (prompt-driven through an agent client running Onchain OS), whitelist beta status, and the
   full FAQ section (credit scoring, evaluator voting penalties, appeal economics).
2. Fetched the Onchain OS Payments dev-docs (20 URLs under `web3.okx.com/onchainos/dev-docs/payments/`
   — these *are* scrapeable via WebFetch, unlike the SPA one-pager). Covers: the Agent Payments
   Protocol's four intents (charge/escrow/session/upto), the three Service Seller integration
   paths (prompt-based, SDK, reverse-proxy), Agent Seller (messaging-channel) integration, the
   buyer side, and supported networks/tokens (X Layer only; USDG/USD₮0).
3. All of this is preserved verbatim-where-possible in [`okx_context.md`](okx_context.md) — treat
   it as a primary reference, not a summary.

## Key decision: A2MCP, not A2A

Creating an agent is a deterministic, fixed-shape operation (seed in → agent out) with nothing to
negotiate or arbitrate. A2A's escrow/appeal machinery (3-day auto-release, 5% appeal bounty, ≥5
Evaluator votes) exists for *disputable* outcomes — there's no dispute to have here. A2MCP's
pay-per-call, fixed-price, instant-settlement model is the right fit.

## What got built (this session, after the user confirmed a funded 0G Compute account)

- **Schema**: `OkxAgentRequest` (idempotency tracking, same unique-column pattern as
  `LeagueMoment.idempotencyKey`) and `KultExperienceLog` (for the separate, broader Personality
  Drift Engine effort — included here because it was the other item flagged as needing concrete
  schema in the same pass). Migration:
  `packages/db-client/prisma/migrations/20260624150000_okx_bridge_and_kult_experience_log/`.
  Generated via `prisma migrate diff --from-schema-datamodel <prior> --to-schema-datamodel
  <current> --script` against the schema snapshot at commit `21dfed2` (the commit that introduced
  the previous migration) — no live database/Docker needed, same approach used for the earlier
  league-economy migration.
- **`OkxBridgeService`** (`services/agent-service/src/services/okx-bridge.service.ts`): wraps
  `AgentService.createAgent()`. Owns a single system `User` account
  (`walletAddress: "okx-marketplace-system-account"`, upserted idempotently) since OKX-originated
  agents have no real AI Arena user behind them. Implements the idempotency check/upsert against
  `OkxAgentRequest` before calling `createAgent()`.
- **`okxServiceMiddleware`** (`services/agent-service/src/middleware/okx.middleware.ts`): checks
  `X-OKX-Service-Key` against `process.env.OKX_SERVICE_KEY` — deliberately a separate trust
  boundary from both the user JWT and the internal `X-Service-Key`, since OKX is an external,
  billed caller that needs independent key rotation.
- **Route** (`services/agent-service/src/routes/okx.routes.ts`): `POST /create-agent`, mounted at
  `/okx` in `main.ts`, reachable externally via the gateway at `/v1/okx/create-agent`.
- **Gateway wiring** (`services/api-gateway/src/main.ts`): added `/v1/okx` to the `DEPLOYED`
  routing table (→ `AGENT_SERVICE_URL`, rewrite to `/okx`) and a dedicated Redis-backed rate limit
  (`OKX_RATE_LIMIT_MAX`, default 30/min) — tighter than the global 500/min default, since this is
  a billed, no-sandbox external surface.
- **`render.yaml`**: added `OKX_SERVICE_KEY` (`sync: false`) next to `INTERNAL_SERVICE_SECRET` on
  the `aiarena-agent` service block.
- **Real pricing input**: ran 3 live calls against the funded production 0G Compute account
  (`router-api.0g.ai`, model `deepseek/deepseek-chat-v3-0324`) replicating
  `generatePersonality()`'s exact prompt shape. Measured `x_0g_trace.billing.total_cost`:
  541.86T, 549.18T, 332.00T neuron → average ~474.35T neuron (~0.000474 0G token) per call. Full
  writeup and the remaining unknowns (0G Storage cost, 0G Chain gas, 0G→USD rate) in
  [`pricing.md`](pricing.md).
- **Agent Card draft** ([`agent-card.json`](agent-card.json)) — pricing field intentionally left
  as `TBD`, everything else filled in from the real endpoint contract.
- Typechecked clean: `npx tsc --noEmit` on both `services/agent-service` and `services/api-gateway`.

## Continued (same day): real gas estimate + payment proxy scaffold

After the first pass above, kept going on the parts that didn't need Render dashboard access:

- **INFT mint gas — measured, not guessed.** Ran a real, read-only
  `contract.mintAgent.estimateGas(...)` against the live `AIArenaINFT` contract on 0G Chain
  mainnet (the operator wallet derived from `ZEROG_STORAGE_PRIVATE_KEY` as `from`). This is a
  simulation — `estimateGas` never broadcasts a transaction, so it cost nothing. Result: 520,923
  gas units × ~4 gwei ≈ **0.0020837 0G token**. Combined with the personality-generation cost,
  two of three pricing components are now real numbers — see the updated
  [`pricing.md`](pricing.md).
- **Did NOT run a real 0G Storage upload** to measure that cost, even though it would have been
  technically easy — `@0gfoundation/0g-storage-ts-sdk`'s `indexer.upload()` has no dry-run/
  estimate mode like `eth_estimateGas` does; it always submits a real on-chain transaction. That's
  a real, irreversible (if small) spend, which is a different risk class from a read-only gas
  estimate or a $0.0005 compute call — flagged for explicit go-ahead rather than just done.
- **Built `services/okx-payment-proxy`** — a real, typechecked reverse-proxy scaffold that
  pay-walls `/v1/okx/create-agent` using OKX's actual `mppx` + `@okxweb3/mpp` packages. Verified
  against the real published `.d.ts` files (pulled via `npm pack` into a scratch dir, not guessed
  from the doc summaries) — caught and fixed two real mistakes in the process: `Mppx.toNodeListener`
  isn't a top-level export of `mppx/server` (it's a namespace member), and it consumes the Node
  request stream itself, which conflicts with this proxy's need to forward the original body to
  agent-service after payment — so it uses a manual Fetch `Request`/`Response` adapter instead.
  Installed for real via `pnpm install --filter @ai-arena/okx-payment-proxy` (now in the workspace
  lockfile) and typechecks clean. **It refuses to start** until six env vars (final price,
  currency, recipient, and three OKX API credentials) are set with real values — see
  `services/okx-payment-proxy/README.md`.

## Continued (same day): finalized price, fixed a real dependency bug

- **Decided on 0.10 USDG per call** as the fixed A2MCP price (comfortable margin over the ~0.0026
  0G token in measured costs so far) and wired it as the default in both
  [`agent-card.json`](agent-card.json) and `services/okx-payment-proxy/src/main.ts`, paid to
  `0x63F63DC442299cCFe470657a769fdC6591d65eCa` (the existing operator wallet). The 0G Storage
  cost and exact FX rate are still not separately measured, but the margin is wide enough that
  this price stands regardless.
- **Found and fixed a real runtime bug while smoke-testing the proxy** (not caught by `tsc
  --noEmit` — module resolution failures aren't type errors): depending on `mppx` directly
  (^0.7.0) alongside `@okxweb3/mpp` (which depends on `mppx@^0.3.x` internally) installed two
  incompatible copies; the hoisted 0.7.0 copy broke at runtime with
  `ERR_PACKAGE_PATH_NOT_EXPORTED` trying to resolve a `viem` subpath. Fixed by importing `Mppx`
  from `@okxweb3/mpp`'s own root export instead of a separate top-level `mppx` dependency — see
  `services/okx-payment-proxy/README.md#why-no-direct-mppx-dependency`. Re-verified with an actual
  `node --experimental-strip-types src/main.ts` run, not just a typecheck.
- Remaining blocker to actually running this proxy is now down to exactly one thing: real
  `OKX_API_KEY` / `OKX_API_SECRET_KEY` / `OKX_API_PASSPHRASE`, issued only after ASP registration.

## What's explicitly NOT done (and why)

- **Migration not applied to the live Render Postgres** — same situation as the prior
  league-economy migration: needs `npx prisma migrate deploy` run via Render Shell on
  `aiarena-agent` after the next deploy. Nothing in this session ran that.
- **`OKX_SERVICE_KEY` not set anywhere real** — it's referenced in code and declared in
  `render.yaml` as `sync: false`, meaning someone has to generate a value and paste it into the
  Render dashboard manually. Not done here (no value exists yet to set).
- **`okx-payment-proxy` is not wired into `docker-compose.yml` or `render.yaml`** — it's not
  deployable yet (no OKX credentials, no final price), so it isn't registered as a running
  service anywhere. Wiring it in before those exist would just be a 503 in production.
- **Pricing is not fully finalized** — personality-gen cost and INFT mint gas are now real
  measurements; 0G Storage upload cost and the 0G→USD/USDG FX rate are still open, see
  `pricing.md`.
- **Nothing was registered with OKX** — no outreach to an OKX PoC happened in this session; that's
  a manual/business step outside what a coding session should do unprompted.
- **No real 0G Storage upload or INFT mint transaction was broadcast** — only read-only/simulated
  checks (chat completion calls, `estimateGas`) were run. Anything that would spend real
  storage/gas fees as a *transaction* (vs. a free simulation) was deliberately left for an
  explicit go-ahead.

## If you're picking this up next

1. Generate a real `OKX_SERVICE_KEY` value and set it in Render's dashboard for `aiarena-agent`.
2. Apply the migration (`npx prisma migrate deploy` via Render Shell — and check whether
   `migrate resolve --applied` is needed first, same caveat as the prior league migration).
3. Decide whether to spend the small real cost of one 0G Storage upload to measure that cost
   directly, or find 0G's published per-byte storage rate instead — either closes the last real
   pricing gap (`pricing.md`).
4. Pick a 0G→USD/USDG FX source, finalize `OKX_CREATE_AGENT_PRICE_AMOUNT` /
   `OKX_CREATE_AGENT_PRICE_CURRENCY`, and update `agent-card.json`'s `pricing.amount`.
5. Register as an OKX ASP to get real `OKX_API_KEY` / `OKX_API_SECRET_KEY` / `OKX_API_PASSPHRASE`
   and decide `OKX_PAYMENT_RECIPIENT_ADDRESS` — `services/okx-payment-proxy` is otherwise ready to
   run once these and step 4's values exist.
6. Wire `okx-payment-proxy` into `render.yaml`/`docker-compose.yml` once it's actually meant to run.
7. Only then: contact the OKX PoC for whitelist beta access and submit the Agent Card.
