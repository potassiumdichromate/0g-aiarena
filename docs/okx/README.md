# OKX Agent Marketplace — Docs Index

Everything related to listing a KULT agent on the OKX Agent Marketplace lives here. The broader
"KULT Core Intelligence Layer" architecture (of which this is one phase) is at
[`../architecture/KULT_CORE_INTELLIGENCE_LAYER.md`](../architecture/KULT_CORE_INTELLIGENCE_LAYER.md).

| File | What it is |
|---|---|
| [`okx_context.md`](okx_context.md) | Transcribed reference: the OKX one-pager (roles, A2A vs A2MCP, registration flow, FAQ) plus the Onchain OS Payments dev-docs (payment methods, SDK/proxy/agent-seller integration paths, supported networks). Pure reference, not our own design. |
| [`create-agent-endpoint.md`](create-agent-endpoint.md) | Implementation reference for the `POST /v1/okx/create-agent` endpoint actually built in this repo — request/response shape, idempotency, code map. |
| [`pricing.md`](pricing.md) | Final price (0.10 USDG/call) and the measured cost components behind it: 0G Compute (personality generation) and 0G Chain gas (INFT mint, via a read-only `estimateGas` simulation). |
| [`agent-card.json`](agent-card.json) | The draft Agent Card to submit to OKX once whitelisted. |
| [`okx-memory.md`](okx-memory.md) | Session log: what was built, what was decided, what's still open. |
| [`../../services/okx-payment-proxy/`](../../services/okx-payment-proxy/README.md) | Real, typechecked, runtime-verified reverse-proxy that will pay-wall the endpoint. Not deployed — refuses to start until real OKX API credentials exist. |

## Current status

- Endpoint is built and typechecks clean (`services/agent-service/src/routes/okx.routes.ts`).
- Migration for `OkxAgentRequest` + `KultExperienceLog` is written and Prisma client regenerated.
- Pricing finalized: **0.10 USDG per call**.
- Payment proxy (`services/okx-payment-proxy`) is built, typechecks, runs cleanly (verified via a
  real smoke test, which caught and fixed a `mppx` dependency conflict) — but isn't deployed
  anywhere, and won't start without real OKX API credentials.
- **Not yet done**: applying the migration to the live Render database, setting `OKX_SERVICE_KEY`
  in Render's dashboard, registering as an OKX ASP to get real payment credentials, wiring
  `okx-payment-proxy` into deployment configs, and actually registering with OKX (requires
  contacting the OKX PoC for whitelist beta access — a manual, external step, not something to
  script from this repo).
