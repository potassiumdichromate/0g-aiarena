# OKX Agent Marketplace — Docs Index

Everything related to listing a KULT agent on the OKX Agent Marketplace lives here. The broader
"KULT Core Intelligence Layer" architecture (of which this is one phase) is at
[`../architecture/KULT_CORE_INTELLIGENCE_LAYER.md`](../architecture/KULT_CORE_INTELLIGENCE_LAYER.md).

| File | What it is |
|---|---|
| [`okx_context.md`](okx_context.md) | Transcribed reference: the OKX one-pager (roles, A2A vs A2MCP, registration flow, FAQ) plus the Onchain OS Payments dev-docs (payment methods, SDK/proxy/agent-seller integration paths, supported networks). Pure reference, not our own design. |
| [`create-agent-endpoint.md`](create-agent-endpoint.md) | Implementation reference for the `POST /v1/okx/create-agent` endpoint actually built in this repo — request/response shape, idempotency, code map. |
| [`pricing.md`](pricing.md) | Final price (0.10 USDG/call) and the measured cost components behind it: 0G Compute (personality generation) and 0G Chain gas (INFT mint, via a read-only `estimateGas` simulation). |
| [`agent-card.json`](agent-card.json) | The Agent Card submitted to OKX — ASP `#2170`, "KULT Agent Creator", under review. |
| [`okx-memory.md`](okx-memory.md) | Session log: what was built, what was decided, what's still open. |
| [`../../services/okx-payment-proxy/`](../../services/okx-payment-proxy/README.md) | Real, runtime-verified reverse-proxy that pay-walls the endpoint — deployed as `aiarena-okx-payment-proxy` on Render. |

## Current status

- Endpoint built, typechecks clean, and verified end-to-end against the live Render deployment
  (real agent created, idempotency confirmed, `clan: OKX` confirmed).
- ASP `#2170` ("KULT Agent Creator") registered on-chain via `onchainos agent create`, avatar
  uploaded, one A2MCP service ("Arena Agent Creation", 0.10 USDT) attached, submitted for OKX
  review via `agent activate`.
- Real OKX API credentials obtained from the Developer Portal and wired into
  `aiarena-okx-payment-proxy` (a new Render service). Payment gating verified locally: an unpaid
  call to the proxy returns a correct `402 Payment Required` challenge from `mppx`.
- **Not yet done**: OKX's review of ASP `#2170` (~2 business days), confirming the deployed proxy
  actually settles a real payment end-to-end once OKX's side can call it, and rotating the OKX API
  key (it was shared in this session's chat, which OKX's own UI explicitly warns against).
