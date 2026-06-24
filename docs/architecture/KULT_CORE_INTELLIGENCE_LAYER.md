# KULT Core Intelligence Layer — Architecture

> **Status:** Phase 4 (OKX Agent Marketplace bridge) is implemented and typechecked. Phases 1–3
> and 5 remain proposed design, pending a build decision. See [Implementation status](#implementation-status)
> for what exists in code today versus what is still architecture.

## Motivation

Today, agent decisions come from per-call inference against pre-available models on 0G Compute
(`inference-service`), and training happens through `training-service` as a manual job-broker
(JSONL dataset → 0G Storage → `TrainingJob` → LoRA fine-tune → new `AIModel`). League settlement
(`league-worker`) computes reputation, distributes `$ARENA`/KP, and emits moments — but it is
**read-only**: none of those outcomes feed back into agent traits, prompts, memory-driven
retraining, or new `TrainingJob`s.

The KULT Core Intelligence Layer is a centralized intelligence layer that:

1. Ingests game/match data as JSON (already flowing on the NATS event bus).
2. Refines that data into per-agent experience records.
3. Uses those records to evolve agent personality and behavior over time.
4. Becomes the place an agent's actions and decisions are assembled from — not just combat
   inference, but the broader agentic responsibilities of the platform.
5. Bridges to the OKX Agent Marketplace, turning agent creation into an externally monetizable,
   pay-per-call service.

It is built almost entirely on infrastructure that already exists — a new orchestration layer,
not a new stack.

## Architecture overview

```
Existing services (event sources)
  league-worker      -> settlement, rivalry, moments
  battle-service      -> arena combat results
  memory-service      -> episodic / semantic snapshots
  inference-service   -> per-call 0G Compute decisions
        |
        v   NATS event bus (existing)
        |
=====================================================================
 KULT Core Intelligence Layer
---------------------------------------------------------------------
 1. Ingestion & Refinement
    -> normalizes JSON events into KultExperienceLog per agent
        |
        v
 2. Personality Drift Engine
    -> periodic recompute of Agent.traits, archetype bias
        |
        v
 3. Training Orchestrator
    -> builds JSONL dataset, queues TrainingJob (existing pipeline)
        |
        v
 IntelligenceLayer (extended Prisma model)
    -> central config / registry for the above

 0G Storage   <- refined datasets + procedural memory snapshots
 0G Compute   <- LoRA fine-tune -> AIModel.loraAdapterPath
 4. Decision Gateway
    -> persona = traits + active adapter, calls 0G Compute
    -> serves decisions back to inference-service / battle-service / league-worker
=====================================================================
 5. OKX Marketplace Bridge — IMPLEMENTED
    Agent Card  |  A2MCP endpoint  |  OKX Payment SDK reverse proxy
```

## Implementation status

| Phase | Component | Status |
|---|---|---|
| 1 | Ingestion & Refinement (`KultExperienceLog`) | Schema implemented; consumer not yet built |
| 1 | Personality Drift Engine | Design only |
| 2 | Training Orchestrator | Design only |
| 3 | Decision Gateway | Design only |
| 4 | OKX Marketplace Bridge | **Implemented** — endpoint, idempotency, pricing, payment proxy |
| 5 | OKX A2A (negotiated services) | Design only |

Phase 4 is covered in full in [Phase 4: OKX Marketplace Bridge](#phase-4-okx-marketplace-bridge-implemented)
below and in [`../okx/`](../okx/README.md). The schema for Phase 1's `KultExperienceLog` already
exists (added alongside Phase 4's migration, since both were specified in the same pass), but
nothing yet writes to it — see [Phase 1–3: proposed](#phase-13-ingestion-drift-engine-training-orchestrator-proposed).

## Phase 4: OKX Marketplace Bridge (implemented)

Per OKX's feedback after the AI Arena demo — *"if you have a KULT agent that immediately creates
an agent for the arena, then we could list it on the marketplace too"* — KULT Core exposes agent
creation as an **A2MCP** service (pay-per-call, instant settlement, no arbitration path), the
correct fit since creating an agent is a deterministic, fixed-shape operation with nothing to
negotiate or dispute.

### Endpoint

`POST /v1/okx/create-agent`, implemented in `services/agent-service`, proxied through the API
gateway. Wraps the existing agent-creation pipeline (`AgentService.createAgent()`) — personality
generation via 0G Compute, async avatar generation, 0G Storage metadata upload, and 0G Chain INFT
minting — behind an external-caller-safe contract:

```typescript
// Request — Auth: X-OKX-Service-Key header (issued at ASP registration, not the user JWT)
{
  name: string;
  clan: string;
  archetype?: string;
  backstory?: string;
  idempotencyKey: string;
}

// Response — 201 on first call, 200 on a replayed idempotencyKey
{
  agentId: string;
  name: string;
  clan: string;
  archetype: string;
  traits: Record<string, number>;
  backstory: string;
  inftTokenId: string | null;       // null if mint is still pending/non-fatally failed
  avatarStatus: "pending" | "ready";
  avatarRootHash: string | null;    // present once async avatar generation completes
}
```

Avatar generation stays asynchronous, keeping the endpoint's response time to roughly 15 seconds
instead of the ~30–50 seconds a full synchronous creation would take — the route returns as soon
as traits, backstory, and the database row exist, and `avatarRootHash` is patched in once the
existing avatar pipeline finishes.

### Idempotency

`OkxAgentRequest` tracks every call by a caller-supplied `idempotencyKey` (unique column,
following the same pattern already used by `LeagueMoment.idempotencyKey`):

```prisma
model OkxAgentRequest {
  id             String    @id @default(uuid())
  idempotencyKey String    @unique
  agentId        String?
  status         String    @default("PENDING") // PENDING | COMPLETED | FAILED
  requestPayload Json
  errorDetail    String?
  createdAt      DateTime  @default(now())
  completedAt    DateTime?

  agent          Agent?    @relation(fields: [agentId], references: [id])
}
```

A retried call with the same key returns the cached agent instead of creating a second one — load-bearing given A2MCP's no-sandbox, no-arbitration model, where a duplicate creation can't be
walked back after the fact.

### Ownership model

OKX-originated agents have no AI Arena user behind them. `OkxBridgeService` owns a single,
idempotently-provisioned system account (`walletAddress: "okx-marketplace-system-account"`), and
every agent created through this endpoint belongs to it.

### Pricing

**0.10 USDG per call**, paid on X Layer (`eip155:196`) to the platform's operator wallet
(`0x63F63DC442299cCFe470657a769fdC6591d65eCa`). This sits with comfortable margin over the
measured cost floor:

| Cost component | Measured value |
|---|---|
| Personality generation (0G Compute) | ~0.000474 0G token per call |
| INFT mint (0G Chain gas) | ~0.0020837 0G token per call |

Both figures come from real measurements against this platform's production accounts — three
live `chat/completions` calls for the personality-generation cost, and a real `eth_estimateGas`
simulation against the live `AIArenaINFT` contract for the mint cost. Full methodology in
[`../okx/pricing.md`](../okx/pricing.md).

### Payment settlement

`services/okx-payment-proxy` is a standalone reverse proxy that pay-walls the endpoint using
OKX's Onchain OS Payments protocol (`@okxweb3/mpp`, the EVM `charge` one-time-payment method). It
typechecks and runs cleanly against the real published SDK — verified with a live runtime smoke
test, not just a type check — and forwards verified-payment requests to `/v1/okx/create-agent`
with the internal service-key header. It is not yet deployed: it requires `OKX_API_KEY` /
`OKX_API_SECRET_KEY` / `OKX_API_PASSPHRASE`, issued only once registered as an OKX ASP.

### Agent Card

The marketplace listing ([`../okx/agent-card.json`](../okx/agent-card.json)) declares the service
name, input/output schema, fixed pricing, and expected latency — ready to submit once whitelist
beta access is granted.

### Reference documentation

[`../okx/`](../okx/README.md) holds the full implementation reference: the transcribed OKX
one-pager and Onchain OS Payments dev-docs, the endpoint specification, the pricing methodology,
the Agent Card, and a complete session log of what was built and decided.

## Phase 1–3: Ingestion, Drift Engine, Training Orchestrator (proposed)

### 1. Ingestion & Refinement

- Subscribes to existing NATS subjects: battle-ended, league-match-settled, predictions,
  moments, rivalry updates — no new event producers needed.
- Normalizes each raw event into a `KultExperienceLog` row per affected agent. The schema already
  exists:

```prisma
model KultExperienceLog {
  id          String    @id @default(uuid())
  agentId     String
  eventType   String    // BATTLE_RESULT | LEAGUE_PREDICTION_SETTLED | RIVALRY_UPDATED | ...
  outcome     String?   // WIN | LOSS | DRAW | CORRECT | INCORRECT
  delta       Json      @default("{}") // suggested trait deltas, consumed by the drift engine
  rawPayload  Json
  processedAt DateTime?
  createdAt   DateTime  @default(now())

  agent       Agent     @relation(fields: [agentId], references: [id])

  @@index([agentId, createdAt])
  @@index([processedAt])
}
```

`processedAt` lets the drift-engine job claim a batch of unprocessed rows without a separate
queue. This is the "send game data as JSON, refine it" step the centralized layer is built
around — the data is already on the bus; KULT Core's ingestion path becomes a consumer of it.

### 2. Personality Drift Engine

- A periodic job (the same pattern as league-worker's weekly reset) that aggregates recent
  `KultExperienceLog` rows per agent and nudges `Agent.traits` in small, bounded deltas.
  - A string of high-conviction underdog wins nudges `riskTolerance`/`aggression` up.
  - A losing streak driven by reckless plays nudges it back down.
- Pure data-driven trait evolution, smoothed the same way the reputation formula is in
  [`../league/LEAGUE_SYSTEM_ARCHITECTURE.md`](../league/LEAGUE_SYSTEM_ARCHITECTURE.md) — no model
  weights touched at this stage.

### 3. Training Orchestrator

- When an agent's accumulated experience crosses a threshold, KULT Core packages it as JSONL,
  uploads to 0G Storage, and creates a `TrainingJob` — reusing the existing training-service
  pipeline (LoRA fine-tune on Qwen2.5-0.5B-Instruct / Qwen3-32B via 0G Compute).
- Output is a new `AIModel` version with `loraAdapterPath`, exactly as today.
- KULT Core's responsibility is deciding *when* and *what* to train on, automating a step that is
  currently manual.

### 4. Decision Gateway

- A thin facade in front of `inference-service`. When a battle/league call needs an agent
  decision, the gateway loads the agent's current persona — traits, active `AIModel` adapter, and
  tribe system prompt (NEXUS_01 / SHADOW_9 / ATHENA / VOIDWALKER) — then makes the 0G Compute call.
- This is the single place that assembles "who this agent currently is" before any action is
  taken, so personality drift and fine-tuned adapters actually surface in gameplay instead of
  remaining inert data.

### Registry: extend `IntelligenceLayer`

The already-scaffolded `IntelligenceLayer` Prisma model (`actionSpace`, `observationSpace`,
`rewardConfig`, `modelConfig`, scoped per `gameId`) becomes KULT Core's config/registry table —
drift-engine thresholds, training cadence, and reward weighting, finally wired into something
live.

### Distilled KULT Core base model (future capstone)

Once enough teacher-labeled data accumulates in `KultExperienceLog`, the Training Orchestrator's
natural endpoint is a distilled, KULT-trained base model: rented 0G Compute models label combat
decisions and outcomes, and that dataset distills/fine-tunes a small shared base (Qwen2.5-0.5B is
already the platform default) that the Decision Gateway calls on the hot path, with rented models
kept only as a fallback for new agents before sufficient data exists. This is the point at which
"we own our core intelligence" becomes literally true, rather than an orchestration claim over
rented inference.

## Phase 5: OKX A2A — negotiated services (future)

A2A (escrow-based, negotiated, with arbitration via OKX Evaluators) fits richer services that
need back-and-forth — for example, "retrain my agent on strategy X" — where there is a real
deliverable to evaluate and potentially dispute. This is a natural extension once Phases 1–3 are
live and there is a meaningful training/retraining product to sell, not before.

## Engineering notes

- The INFT mint triggered by agent creation (`POST /inft/agent-mint`) is an **0G Chain EVM
  transaction** (Chain ID 16661, contract `AIArenaINFT.sol`). Solana is used elsewhere in the
  platform (agent-wallet, escrow-vault, tournament, staking Anchor programs) but not in this flow.
- `services/okx-payment-proxy` is intentionally its own package: its dependencies (`@okxweb3/mpp`)
  are pure ESM, while the rest of `services/` is CommonJS. Keeping it isolated avoided changing
  the monorepo's module strategy for the rest of the codebase.

## Open items

- **Decision pending:** whether Phases 1–3 (drift engine, training orchestrator, decision
  gateway) should ship as a new dedicated service or as a module inside an existing one (e.g.
  `training-service` or `league-worker`).
- **Decision pending:** whether the drift engine should write directly to `Agent.traits`, or to a
  staged, `IntelligenceLayer`-tracked "proposed traits" set that is approved before being applied.
- **Operational, not architectural:** applying the `OkxAgentRequest` / `KultExperienceLog`
  migration to the live Render database, setting `OKX_SERVICE_KEY` in Render's dashboard,
  registering as an OKX ASP for real payment credentials, and submitting the Agent Card once
  whitelist beta access is granted. Tracked in [`../okx/okx-memory.md`](../okx/okx-memory.md).
