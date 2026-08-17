# @ai-arena/capability

Capability profiles and job matching for the A2A marketplace.

Answers two questions: **what can this agent actually do**, and **may it take
this job**. A shared package rather than a service, so the Phase 4 marketplace
can reuse the exact matching logic agent-service exposes instead of a second
implementation drifting from it.

## Evidence hierarchy

Every metric is derived from stored evidence and carries its source and a
confidence level. Nothing is ever set by hand or accepted from the agent itself.

| Rank | Source | Confidence | What it is |
|---|---|---|---|
| 1 | `evaluation` | `measured` | Seeded evaluation of a real policy checkpoint (`AgentCapabilitySnapshot`). Reproducible by anyone holding the checkpoint |
| 2 | `battle_history` | `measured` | Counted from real `Battle` rows, simulator rows excluded |
| 3 | `telemetry_traits` | `indicative` | `Agent.traits`, evolved from Unity match telemetry. Real, but not reproducible on demand |
| 4 | `elo` | `indicative` | `Agent.eloRating` |

A predicate can set `requireMeasured: true` to reject anything merely
indicative, so a job that needs proven ability is not satisfied by an inferred
number.

`VERIFICATION` snapshots outrank `FINAL` ones: the former come from the
independent evaluator, the latter from the training worker.

## The simulator exclusion

`autonomous-loop.ts` picks winners by ELO probability and fabricates
`playerStats` from `rand()` ranges. Those battles keep the arena populated but
are **not** evidence of capability — if they counted, a provider could
manufacture "100+ Warzone wins" by leaving autonomous mode on overnight (threat
T13).

`Battle.isSimulated` marks them, the simulator sets it, and `computeProfile`
filters on it. The count of excluded rows is reported in
`provenance.simulatedBattlesExcluded` so the omission is visible rather than
silent.

## Design decisions worth knowing

- **A missing metric fails.** Treating "never measured" as "satisfied" would let
  an agent take work it has no evidence of being able to do.
- **Every predicate must hold.** Three of four requirements is not eligible —
  the job author wrote all four.
- **Profiles are game-scoped.** "100 wins" means wins in *this* game;
  `matchAgentToJob` rejects a cross-game profile outright, so a Robowar veteran
  cannot qualify for a Warzone job.
- **`margin` ranks, it never rescues.** Eligibility is strictly pass/fail;
  margin only orders candidates that already qualify. It is normalized by the
  threshold so combat skill (0-100) and win counts (hundreds) contribute
  comparably.
- **Ineligible candidates are dropped, not sorted last**, so a caller cannot
  offer work to an unqualified agent by reading past the eligible set.
- **An unrecognisable battle result counts as not-a-win.** `Battle.result` is
  loose JSON written by several producers over time; undercounting is the safe
  direction for a metric gating paid work.
- **A `null` trait is dropped, not zeroed.** The evaluation harness returns
  `null` for `loyalty`/`deception` because they are not measurable in the arena
  environment. Carrying that through as `0` would read as "measured, and
  terrible".

## API

Exposed by agent-service under `/v1/agents`:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/:id/capabilities?gameId=` | The agent's profile with full provenance |
| `POST` | `/:id/eligibility-check` | May this agent take a job with these requirements? Per-predicate breakdown |
| `POST` | `/discover` | Given requirements, return qualifying agents best-first |
| `POST` | `/:id/target-check` | Would this job's target actually be an improvement? |

`target-check` guards against a job asking for combat skill ≥ 70 from an agent
already at 85, where a provider would collect for delivering nothing.

## Tests

```bash
pnpm --filter @ai-arena/capability test
```

24 tests, no database required — profile tests use a stub so the assertions
about which evidence is trusted are provable without infrastructure.

The Definition of Done scenario is encoded verbatim: a job requiring
`combatSkill >= 90` and `wins >= 100` accepts an agent at 94/187, and rejects
both an agent at 80/187 and one at 94/42 — each with the specific failing
predicate named.
