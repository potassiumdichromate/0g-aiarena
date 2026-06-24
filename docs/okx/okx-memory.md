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

## What's explicitly NOT done (and why)

- **Migration not applied to the live Render Postgres** — same situation as the prior
  league-economy migration: needs `npx prisma migrate deploy` run via Render Shell on
  `aiarena-agent` after the next deploy. Nothing in this session ran that.
- **`OKX_SERVICE_KEY` not set anywhere real** — it's referenced in code and declared in
  `render.yaml` as `sync: false`, meaning someone has to generate a value and paste it into the
  Render dashboard manually. Not done here (no value exists yet to set).
- **No payment integration** — the endpoint has no OKX Payment SDK / `mppx` reverse-proxy in
  front of it yet. It's only gated by `OKX_SERVICE_KEY`, not by any payment verification. This
  was flagged as a separate, later step in `create-agent-endpoint.md`.
- **Pricing is not finalized** — three of four cost components are real measurements; the other
  three (storage, gas, FX rate) are explicitly flagged as unknowns rather than guessed.
- **Nothing was registered with OKX** — no outreach to an OKX PoC happened in this session; that's
  a manual/business step outside what a coding session should do unprompted.
- **No real INFT mint or 0G Storage upload was triggered as part of this session's testing** — only
  the personality-generation chat call was sampled live (small, low-stakes real cost). Minting or
  uploading for pricing purposes would spend real gas/storage fees and wasn't done without an
  explicit ask.

## If you're picking this up next

1. Generate a real `OKX_SERVICE_KEY` value and set it in Render's dashboard for `aiarena-agent`.
2. Apply the migration (`npx prisma migrate deploy` via Render Shell — and check whether
   `migrate resolve --applied` is needed first, same caveat as the prior league migration).
3. Fill in the three missing pricing inputs in `pricing.md`, then update `agent-card.json`'s
   `pricing.amount`.
4. Decide SDK vs. reverse-proxy for the OKX Payment SDK integration (see `okx_context.md`'s
   "Implications for KULT Core's A2MCP service" section) and build it.
5. Only then: contact the OKX PoC for whitelist beta access and submit the Agent Card.
