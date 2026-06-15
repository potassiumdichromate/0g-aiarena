# KULT Core Intelligence Layer — Proposed Architecture

> Status: **proposal / design for review** — nothing in this document has been implemented yet.

## Motivation

Today, agent decisions come from per-call inference against pre-available models on 0G Compute
(`inference-service`), and training happens through `training-service` as a manual job-broker
(JSONL dataset -> 0G Storage -> `TrainingJob` -> LoRA fine-tune -> new `AIModel`). League
settlement (`league-worker`) computes reputation, distributes `$ARENA`/KP, and emits moments —
but it is **read-only**: none of those outcomes feed back into agent traits, prompts, memory-driven
retraining, or new `TrainingJob`s.

The goal of the **KULT Core Intelligence Layer** is a centralized intelligence layer that:

1. Ingests game/match data as JSON (already flowing on the NATS event bus).
2. Refines that data into per-agent experience records.
3. Uses those records to evolve agent personality and behavior over time.
4. Becomes the place an agent's "actions and decisions" are assembled from — not just combat
   inference, but the broader agentic responsibilities of the platform.
5. Optionally bridges to the upcoming **OKX AI Agent Marketplace**.

It is designed to be built almost entirely on infrastructure that already exists — a new
orchestration layer (`kult-core-service`), not a new stack.

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
 KULT Core Intelligence Layer (new service: kult-core-service)
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
 5. OKX Marketplace Bridge (sub-module, phased last)
    Agent Card  |  A2MCP endpoint  |  OKX Payment SDK
```

## Components

### 1. Ingestion & Refinement

- Subscribes to existing NATS subjects: battle-ended, league-match-settled, predictions,
  moments, rivalry updates. **No new event producers needed.**
- Normalizes each raw event into a `KultExperienceLog` row per affected agent:
  `{ agentId, eventType, context, outcome, delta, rawPayload }`.
- This is the "send our game data as JSON, refine it" step the centralized layer is built
  around — the data is already on the bus, KULT Core just becomes a consumer of it.

### 2. Personality Drift Engine

- A periodic job (same pattern as league-worker's weekly reset) that aggregates recent
  `KultExperienceLog` rows per agent and nudges `Agent.traits` — small, bounded deltas.
  - Example: a string of high-conviction underdog wins nudges `riskTolerance`/`aggression` up.
  - Example: a losing streak driven by reckless plays nudges it back down.
- Pure data-driven trait evolution, smoothed the same way the reputation formula is
  (see [`docs/league/LEAGUE_SYSTEM_ARCHITECTURE.md`](../league/LEAGUE_SYSTEM_ARCHITECTURE.md)) —
  no model weights touched at this stage.

### 3. Training Orchestrator

- When an agent's accumulated experience crosses a threshold, KULT Core packages it as JSONL,
  uploads to 0G Storage, and creates a `TrainingJob` — **reusing the existing training-service
  pipeline** (LoRA fine-tune on Qwen2.5-0.5B-Instruct / Qwen3-32B via 0G Compute).
- Output is a new `AIModel` version with `loraAdapterPath`, exactly as today.
- KULT Core's only new responsibility is deciding *when* and *what* to train on — automating a
  step that is currently manual/non-existent.

### 4. Decision Gateway

- A thin facade in front of `inference-service`. When a battle/league call needs an agent
  decision, the gateway loads the agent's current persona — traits + active `AIModel` adapter +
  tribe system prompt (NEXUS_01 / SHADOW_9 / ATHENA / VOIDWALKER) — then makes the 0G Compute call.
- This is the "responsible for actions and many things" piece: a single place that assembles
  "who this agent currently is" before any action is taken, so personality drift and fine-tuned
  adapters actually surface in gameplay instead of remaining inert data.

### Registry: extend `IntelligenceLayer`

- The already-scaffolded `IntelligenceLayer` Prisma model (`actionSpace`, `observationSpace`,
  `rewardConfig`, `modelConfig`, scoped per `gameId`) becomes KULT Core's config/registry table —
  drift-engine thresholds, training cadence, reward weighting, per-game tuning — finally wired
  into something live instead of sitting unused.

### 5. OKX Marketplace Bridge (phased last)

Per OKX's feedback after the demo — *"if you have a KULT agent that immediately creates an agent
for the arena, then we could list it on the marketplace too"* — the cleanest fit is **A2MCP**
(pay-per-call, instant settlement, no arbitration path):

- **Agent Card**: "KULT Core — Arena Agent Creator." Service: takes a seed
  (`{ name, description, clan, hints }`), returns a fully-formed agent (personality traits,
  avatar, starting `AIModel`) via the existing agent-creation flow plus `generatePersonality()` /
  `generateAvatar()`.
- **Natural-language invocation** matches OKX's stated pattern — *"the agent would just need to
  say e.g. 'I want to use agent xxxx on the OKX agentic marketplace'"* — once KULT's Agent Card is
  registered, OKX routes the call to our A2MCP endpoint directly.
- **Payment**: OKX's Agentic Wallet / Payment SDK handles settlement for the marketplace call
  itself, kept separate from the internal `$ARENA` economy — an additional external revenue /
  distribution channel.
- A2A (negotiated, escrow-based) is a later option for richer services (e.g. "retrain my agent on
  strategy X"), but A2MCP is the low-effort, high-fit first move, and matches OKX's current
  whitelist-beta stage (launched 2026-06-12) — worth contacting the OKX PoC now to get into the
  beta.

## Suggested phasing

1. **Ingestion + `KultExperienceLog` + Personality Drift Engine** — pure data refinement, lowest
   risk, immediate value, no changes to live decision-making.
2. **Training Orchestrator automation** — reuses training-service, removes the manual trigger.
3. **Decision Gateway consolidation** — optional refactor of inference-service call sites; can be
   deferred.
4. **OKX A2MCP bridge** — "Create Arena Agent" as a marketplace service.
5. **OKX A2A** — richer negotiated services (later).

## Open questions before implementation

- Is Phase 1 (drift engine) the right starting point, or is the OKX integration more
  time-sensitive given the beta window?
- Should the drift engine write directly to `Agent.traits`, or to a staged
  `IntelligenceLayer`-tracked "proposed traits" set that is approved before being applied?
- New service (`kult-core-service`) vs. a module inside an existing service (e.g.
  `training-service` or `league-worker`)?
