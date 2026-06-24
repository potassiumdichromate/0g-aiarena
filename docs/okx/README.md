# OKX Agent Marketplace — Docs Index

Everything related to listing a KULT agent on the OKX Agent Marketplace lives here. The broader
"KULT Core Intelligence Layer" architecture (of which this is one phase) is at
[`../architecture/KULT_CORE_INTELLIGENCE_LAYER.md`](../architecture/KULT_CORE_INTELLIGENCE_LAYER.md).

| File | What it is |
|---|---|
| [`okx_context.md`](okx_context.md) | Transcribed reference: the OKX one-pager (roles, A2A vs A2MCP, registration flow, FAQ) plus the Onchain OS Payments dev-docs (payment methods, SDK/proxy/agent-seller integration paths, supported networks). Pure reference, not our own design. |
| [`create-agent-endpoint.md`](create-agent-endpoint.md) | Implementation reference for the `POST /v1/okx/create-agent` endpoint actually built in this repo — request/response shape, idempotency, code map. |
| [`pricing.md`](pricing.md) | Real measured 0G Compute cost for the personality-generation step, plus what's still unknown (0G Storage cost, 0G Chain gas, 0G→USD rate) before a fixed A2MCP price can be declared. |
| [`agent-card.json`](agent-card.json) | The draft Agent Card to submit to OKX once whitelisted — pricing field is a placeholder pending `pricing.md`. |
| [`okx-memory.md`](okx-memory.md) | Session log: what was built, what was decided, what's still open. |

## Current status

- Endpoint is built and typechecks clean (`services/agent-service/src/routes/okx.routes.ts`).
- Migration for `OkxAgentRequest` + `KultExperienceLog` is written and Prisma client regenerated.
- **Not yet done**: applying the migration to the live Render database, setting `OKX_SERVICE_KEY`
  in Render's dashboard, integrating OKX's Payment SDK, finalizing pricing, and actually
  registering with OKX (requires contacting the OKX PoC for whitelist beta access — a manual,
  external step, not something to script from this repo).
