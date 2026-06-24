# `POST /v1/okx/create-agent` — Implementation Reference

This is the live spec for the endpoint that was actually built (2026-06-24), wrapping the
existing `AgentService.createAgent()` flow for the OKX Agent Marketplace A2MCP service. See
[`okx-memory.md`](okx-memory.md) for the full session log of what was done and why.

## Code map

| Piece | File |
|---|---|
| Route | [`services/agent-service/src/routes/okx.routes.ts`](../../services/agent-service/src/routes/okx.routes.ts) |
| Service | [`services/agent-service/src/services/okx-bridge.service.ts`](../../services/agent-service/src/services/okx-bridge.service.ts) |
| Auth middleware | [`services/agent-service/src/middleware/okx.middleware.ts`](../../services/agent-service/src/middleware/okx.middleware.ts) |
| Route mount | `services/agent-service/src/main.ts` — `app.register(okxRoutes, { prefix: '/okx' })` |
| Gateway proxy | `services/api-gateway/src/main.ts` — `/v1/okx` → `AGENT_SERVICE_URL`, rewrite to `/okx` |
| Idempotency + experience schema | `packages/db-client/prisma/schema.prisma` — `OkxAgentRequest`, `KultExperienceLog` |
| Migration | `packages/db-client/prisma/migrations/20260624150000_okx_bridge_and_kult_experience_log/` |
| Env var | `OKX_SERVICE_KEY` (set in `render.yaml` under `aiarena-agent`, `sync: false`) |

## Request / response

```
POST /v1/okx/create-agent
Headers: X-OKX-Service-Key: <issued key>
Content-Type: application/json
```

```jsonc
// Request body
{
  "name": "string (required)",
  "clan": "string (required)",
  "archetype": "string (optional, default hybrid)",
  "backstory": "string (optional)",
  "idempotencyKey": "string (required)"
}
```

```jsonc
// Response — 201 first call, 200 on a replayed idempotencyKey, 409 if a request
// with the same key is still PENDING (concurrent retry), 400 on missing fields
{
  "agentId": "uuid",
  "name": "string",
  "clan": "string",
  "archetype": "string",
  "traits": { "aggression": 50, "...": "..." },
  "backstory": "string",
  "inftTokenId": "string | null",
  "avatarStatus": "pending | ready",
  "avatarRootHash": "string | null"
}
```

## How idempotency works

`OkxAgentRequest.idempotencyKey` is a unique column (same pattern as `LeagueMoment.idempotencyKey`
in the league schema). On each call:

1. Look up `idempotencyKey`.
2. If `COMPLETED` with an `agentId` → return the existing agent, don't create a new one (200).
3. If `PENDING` → another request with the same key is mid-flight → 409 (the caller should not
   retry blindly; this guards against a race during a slow create).
4. Otherwise → upsert a `PENDING` row, run `AgentService.createAgent()`, mark `COMPLETED` or
   `FAILED` with `errorDetail` on the way out.

This protects the **agent creation** side. It does **not** replace OKX's own payment-replay
protection (Vouchers/nonces in their Payment SDK, see [`okx_context.md`](okx_context.md)) — the
two are independent and both matter.

## Who owns these agents

There's no AI Arena user behind an OKX-originated agent, so `OkxBridgeService.ensureSystemUser()`
upserts a single system `User` row (`walletAddress: "okx-marketplace-system-account"`) the first
time it's needed, and every OKX-created agent is owned by that account. This is intentionally a
single shared account, not one-per-OKX-caller — there's currently no notion of distinct OKX
tenants in this design.

## What's deliberately deferred

- **Avatar generation** stays async (existing `ENABLE_AVATAR_GEN` pipeline) — the route returns
  before it completes, to keep latency low for a pay-per-call API with no sandbox. `avatarStatus`
  in the response tells the caller whether it's ready yet; there's no webhook/poll endpoint for
  the avatar specifically yet — would need one if OKX needs to know when it lands.
- **Payment integration exists as a scaffold, not deployed**: `services/okx-payment-proxy`
  implements the reverse-proxy path against the real `mppx` / `@okxweb3/mpp` packages and
  typechecks clean, but refuses to start until real pricing and OKX API credentials exist (see
  its README). Until it's actually running in front of this endpoint, `/v1/okx/create-agent`
  remains unauthenticated against OKX's billing — only gated by `OKX_SERVICE_KEY`.
- **Agent Card registration** with OKX itself — this is a business/manual step (contact the OKX
  PoC for whitelist beta access), not something to automate from this repo.
