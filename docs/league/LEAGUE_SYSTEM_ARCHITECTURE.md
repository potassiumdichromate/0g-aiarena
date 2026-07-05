# KULTAI Agent World Cup 2026 — League System Architecture

**Status:** Design proposal (no code/schema changes applied yet)
**Scope:** Additive feature layered on the existing AI Arena platform (0G-AIArena backend + kult-games-v3 frontend)
**Source spec:** `kult-ai-world-cup-v1-product-spec-final version.pdf`
**Companion specs referenced by the product PDF** (`kult-league-prediction-engine-spec.md`, `kult-v1-economy-final-spec.md`, `kult-league-fullstack-sportmonks-spec.md`, `kult-ai-world-cup-v1-dev-doc.md`) **do not exist on disk**. Where this document needs to fill that gap, it is marked **[DECISION]** — a concrete default this design adopts, flagged for product sign-off rather than left ambiguous.

---

## Table of Contents

1. [Design Principles](#1-design-principles)
2. [System Context](#2-system-context)
3. [Agent Reuse & Tribe Mapping](#3-agent-reuse--tribe-mapping)
4. [Data Model](#4-data-model)
5. [Currency, Scoring & Reputation Engine](#5-currency-scoring--reputation-engine)
6. [Prediction Lifecycle](#6-prediction-lifecycle)
7. [0G Compute Strategic Planner](#7-0g-compute-strategic-planner)
8. [Football Data Provider Layer](#8-football-data-provider-layer)
9. [Agent Battles & Escrow](#9-agent-battles--escrow)
10. [Settlement Engine](#10-settlement-engine)
11. [Rivalry System](#11-rivalry-system)
12. [Factions](#12-factions)
13. [KULT Moments](#13-kult-moments)
14. [Leaderboards](#14-leaderboards)
15. [Service Topology & API Surface](#15-service-topology--api-surface)
16. [Event Bus, Cache Keys & Gateway Routing](#16-event-bus-cache-keys--gateway-routing)
17. [Security & Anti-Abuse](#17-security--anti-abuse)
18. [Open Decisions & Frontend Reconciliation](#18-open-decisions--frontend-reconciliation)
19. [Rollout Plan](#19-rollout-plan)
20. [Appendix: Worked Examples & Config Defaults](#20-appendix-worked-examples--config-defaults)

---

## 1. Design Principles

1. **Additive only.** No existing Prisma model is removed or has a field repurposed. The only change to an existing model is one nullable, unique foreign key on `EscrowRecord` (`leagueBattleId`) and new enum members on `TransactionType`. Everything else is new tables.
2. **No new agents.** League participation reuses `Agent` records exactly as they are (identity, traits, archetype, evolution stage, `AgentWallet`, memory, battle history). A user with zero agents gets a GENESIS agent auto-minted through the *existing* agent-creation path — League does not introduce a second agent-creation flow.
3. **Two currencies, two ledgers, never mixed.**
   - **$ARENA** stays exactly where it already lives: `AgentWallet.balanceArena` + `LedgerEntry`. League just adds new `TransactionType` values and a new crediting path.
   - **KP** is a brand-new, user-scoped ledger (`LeagueKpLedger` / `LeagueUserProfile.kpBalance`). It has no relation to `AgentWallet` and no conversion path to $ARENA.
4. **Inference enhances, never gates.** Every AI-driven prediction has a deterministic fallback. A 0G Compute outage delays nothing — predictions still get generated, scored, and settled on schedule, just tagged `source: 'FALLBACK'`.
5. **Idempotent settlement.** Every money-moving or reputation-moving operation is written so that re-running it after a crash, retry, or duplicate cron tick produces the same end state — via conditional `UPDATE ... WHERE status = X` claims, not via "check then act" races.
6. **Fail closed on internal auth.** The platform audit (`AI_Arena_Audit_Report.pdf`, finding H-03) flagged that `INTERNAL_SERVICE_SECRET` being unset silently disables the `X-Service-Key` check on existing internal routes. Every new League internal/settlement endpoint must explicitly **fail closed** (503) if that secret is unset — this design does not repeat that gap.
7. **Loose coupling to `Agent`/`User`.** New League tables reference `agentId` / `userId` as plain strings, validated at the application layer (the same way `financial-orchestrator.ensureWallet` validates `agentId` via `prisma.agent.findUnique` before acting). No new Prisma relations are added to the `Agent` or `User` models. This keeps the diff to the core schema at zero, and keeps the door open to splitting League into its own database later without an `Agent`/`User` migration.

---

## 2. System Context

League is delivered by **two new services** plus additive changes to existing ones:

```
                                   ┌──────────────────────────┐
                                   │       api-gateway          │
                                   │  /v1/league/*  ───────────┼──┐
                                   └──────────────────────────┘  │
                                                                   ▼
┌───────────────────────────┐   internal HTTP   ┌─────────────────────────────┐
│      league-service         │◄──────────────────│        league-worker          │
│  (public + internal API)    │  (X-Service-Key)   │  (cron-driven, no public API) │
│                              │                    │                               │
│ - predictions CRUD/read      │                    │ - provider sync (schedule)    │
│ - battles CRUD                │                    │ - lock-at-kickoff sweep        │
│ - factions, rivalries         │                    │ - AI prediction pre-gen (T-24h)│
│ - leaderboards (read)         │                    │ - settlement engine            │
│ - moments feed                │                    │ - weekly snapshot/reset         │
└─────────────┬───────────────┘                    └───────────────┬────────────────┘
              │                                                       │
              │  HTTP (X-Service-Key)                                 │  HTTP (X-Service-Key)
              ▼                                                       ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                                  existing services                                     │
│  agent-service        financial-service        inference-service                      │
│  (GENESIS mint,        (AgentWallet,             (decideLeaguePrediction via            │
│   traits, archetype,    LedgerEntry, Escrow)      0G Compute + fallback)               │
│   evolution)                                                                           │
│                                                                                          │
│  leaderboard-service   memory-service            notification-service                  │
│  (Redis ZSET pattern)   (episodic writes,         (KP/$ARENA reward pushes)            │
│                          rivalry importance)                                            │
└─────────────────────────────────────────────────────────────────────────────────────┘
                          ▲
                          │  football-data-client (new package)
                          │
              ┌───────────┴────────────┐
              │  IFootballDataProvider   │
              │  (Sportmonks adapter,    │
              │   internal-admin adapter)│
              └─────────────────────────┘
```

**New package:** `packages/football-data-client` — the `IFootballDataProvider` interface + adapters (§8).

**New service ports** [DECISION]: `league-service` → `8060` (REST, public via gateway + internal); `league-worker` → `8061` (health check only, no public routes — runs cron jobs in-process). These follow the existing port-allocation convention in `docker-compose.yml`/`render.yaml` (services occupy `80xx`, next free block after `token-service` at `8050`).

---

## 3. Agent Reuse & Tribe Mapping

### 3.1 GENESIS auto-mint

When a user opens the League page and `GET /v1/league/me/agents` finds zero agents owned by that user:

1. `league-service` calls the **existing** `agent-service` agent-creation endpoint (the same one the main Arena onboarding flow uses) with a default archetype/clan — no new creation path.
2. `agent-service`'s existing post-creation hooks already call `financial-service` to `ensureWallet` — League does not duplicate this.
3. `league-service` then creates a `LeagueAgentSeasonStats` row for the new agent against the active `LeagueSeason` (enrollment), computing its tribe per §3.2.

This is a thin orchestration call, not a new creation pathway — if `agent-service`'s default creation flow changes, League automatically inherits it.

### 3.2 CombatArchetype → LeagueTribe mapping

The Prisma schema's `CombatArchetype` enum has 6 values (`BERSERKER`, `TACTICIAN`, `SUPPORT`, `ASSASSIN`, `DEFENDER`, `HYBRID`); the product spec's tribe-lens system has 4 (`NEXUS_01` Statistician, `SHADOW_9` Villain, `ATHENA` Oracle, `VOIDWALKER` Madman). The mapping must be deterministic, computed **once at enrollment**, and persisted on `LeagueAgentSeasonStats.tribe` — it is **not** recomputed as traits evolve mid-season (that would shift an agent's faction allegiance mid-competition, which breaks faction continuity and leaderboard weighting in §12).

**[DECISION] Two-step mapping:**

**Step 1 — archetype default** (covers the common case, zero ambiguity):

| CombatArchetype | LeagueTribe | Rationale |
|---|---|---|
| `TACTICIAN` | `NEXUS_01` (Statistician) | High patience/precision → data-driven framing |
| `DEFENDER` | `NEXUS_01` (Statistician) | Conservative, calculated picks |
| `BERSERKER` | `SHADOW_9` (Villain) | High aggression/deception → antagonistic commentary |
| `ASSASSIN` | `SHADOW_9` (Villain) | High deception/precision → cynical, surgical takes |
| `SUPPORT` | `ATHENA` (Oracle) | High loyalty/resilience → composed, principled tone |
| `HYBRID` | computed via Step 2 | Ambiguous by definition |

**Step 2 — trait-centroid affinity** (used for `HYBRID`, and as the tie-break documented for completeness):

For the agent's 8-trait vector `traits = {aggression, patience, adaptability, resilience, creativity, loyalty, deception, precision}`, compute a dot product against four fixed centroid weight vectors and pick the `argmax`:

```ts
const TRIBE_CENTROIDS: Record<LeagueTribe, Partial<Record<TraitKey, number>>> = {
  NEXUS_01:   { precision: 1.0, patience: 1.0 },
  SHADOW_9:   { aggression: 1.0, deception: 1.0 },
  ATHENA:     { loyalty: 1.0, resilience: 1.0 },
  VOIDWALKER: { creativity: 1.0, adaptability: 1.0 },
};

function tribeAffinity(traits: TraitVector, tribe: LeagueTribe): number {
  const weights = TRIBE_CENTROIDS[tribe];
  return Object.entries(weights).reduce((sum, [trait, w]) => sum + traits[trait] * w, 0);
}

// Tie-break order on equal scores: archetype default (Step 1) for non-HYBRID,
// then lexicographic agentId comparison — guarantees a single deterministic answer.
```

This mapping function lives in `packages/shared-utils/src/league/tribe.ts` so both `league-service` (enrollment) and `league-worker` (system-prompt selection, §7) import the same logic.

---

## 4. Data Model

All new models live in the existing `packages/db-client/prisma/schema.prisma`, appended as a new `// ===== LEAGUE SYSTEM =====` block. Two changes touch existing declarations — both purely additive.

### 4.1 Changes to existing declarations

```prisma
enum TransactionType {
  // ...existing values unchanged...
  LEAGUE_PREDICTION_REWARD   // $ARENA credited to agent for a settled prediction
  LEAGUE_BATTLE_WAGER        // $ARENA debited into escrow for a League Battle
  LEAGUE_BATTLE_REWARD       // $ARENA credited to the League Battle winner
  LEAGUE_BATTLE_REFUND       // $ARENA returned to both agents on VOID battle
}

model EscrowRecord {
  // ...existing fields unchanged...

  /// Additive, nullable, unique — set only for League Battle escrows.
  /// Existing battleId/tournamentId fields are untouched; League uses its
  /// own FK so existing battle/tournament escrow code paths cannot collide
  /// with League settlement logic.
  leagueBattleId String? @unique
}
```

No other existing model, field, enum value, or relation changes.

### 4.2 New enums

```prisma
enum LeagueTribe {
  NEXUS_01    // Statistician
  SHADOW_9    // Villain
  ATHENA      // Oracle
  VOIDWALKER  // Madman
}

enum LeagueStage {
  GROUP
  ROUND_OF_32
  ROUND_OF_16
  QUARTER_FINAL
  SEMI_FINAL
  THIRD_PLACE
  FINAL
}

enum LeagueMatchStatus {
  SCHEDULED
  LIVE
  FINISHED
  POSTPONED
  CANCELLED
}

enum PredictionOutcome {
  HOME
  DRAW
  AWAY
}

/// 🔥 / 🔥🔥 / 🔥🔥🔥 conviction levels — multipliers defined in §5.2
enum ConvictionLevel {
  LOW
  MEDIUM
  HIGH
}

enum PredictionStatus {
  PENDING
  LOCKED
  SETTLED
  VOID
}

enum PredictionSource {
  AI              // 0G Compute structured output
  FALLBACK        // deterministic fallback (0G degraded/timeout)
  USER_OVERRIDE   // user edited the prediction before lock
}

enum LeagueBattleStatus {
  PENDING     // challenger created, awaiting opponent response
  ACCEPTED    // opponent accepted, escrow lock in progress
  LOCKED      // escrow funded, awaiting match settlement
  SETTLED     // winner paid out
  VOID        // match cancelled — stakes refunded
  DECLINED    // opponent declined / expired
}

enum LeagueMomentType {
  VINDICATION  // correct pick against consensus
  ROAST        // agent trash-talks a rival post-result
  UPSET        // correct underdog pick
  RIVALRY      // rivalry narrative milestone (5+ matchups)
  STREAK       // N-correct streak milestone
  ASCENSION    // evolution stage change driven by League performance
  EVOLUTION    // trait-vector shift driven by League performance
  FACTION      // faction milestone (leaderboard lead change, etc.)
}
```

### 4.3 New models

```prisma
/// One row per competition (e.g. "KULTAI World Cup 2026"). All tunable
/// constants (scoring weights, lock buffer, reputation priors) live in
/// `config` so they can be versioned/adjusted without a migration —
/// see §20.2 for the default shape.
model LeagueSeason {
  id              String   @id @default(uuid())
  slug            String   @unique
  name            String
  providerId      String?            // provider-side season/league id
  startsAt        DateTime
  endsAt          DateTime
  isActive        Boolean  @default(true)
  config          Json     @default("{}")
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  matches         LeagueMatch[]
  agentStats      LeagueAgentSeasonStats[]
  weeklySnapshots LeagueWeeklySnapshot[]

  @@index([isActive])
}

model LeagueMatch {
  id            String            @id @default(uuid())
  seasonId      String
  providerId    String            // provider fixture id (e.g. Sportmonks fixture id)
  stage         LeagueStage
  matchday      Int?
  homeTeam      String            // FIFA 3-letter code, e.g. "BRA"
  awayTeam      String
  venue         String?
  kickoffAt     DateTime
  status        LeagueMatchStatus @default(SCHEDULED)
  result        Json?             // NormalizedMatchResult once known (§8.1)
  resultVersion Int               @default(0)  // bumped on provider-correction re-scoring
  settledAt     DateTime?
  createdAt     DateTime          @default(now())
  updatedAt     DateTime          @updatedAt

  season        LeagueSeason       @relation(fields: [seasonId], references: [id])
  predictions   LeaguePrediction[]
  battles       LeagueBattle[]
  moments       LeagueMoment[]

  @@unique([seasonId, providerId])
  @@index([status, kickoffAt])
  @@index([seasonId, stage])
}

/// One row per (match, agent). agentId is a loose reference — validated
/// against Agent at write time, not enforced via Prisma relation (§1.7).
model LeaguePrediction {
  id                String            @id @default(uuid())
  matchId           String
  agentId           String
  winner            PredictionOutcome
  scoreHome         Int
  scoreAway         Int
  conviction        ConvictionLevel   @default(LOW)
  reasoning         String?
  source            PredictionSource  @default(AI)
  status            PredictionStatus  @default(PENDING)

  // Populated only once status = SETTLED (or VOID, all null)
  isCorrectWinner   Boolean?
  isExactScore      Boolean?
  isUpset           Boolean?
  basePoints        Int?
  arenaAwarded      Float?
  kpAwarded         Int?

  lockedAt          DateTime?
  settledAt         DateTime?
  settlementVersion Int               @default(0)  // mirrors LeagueMatch.resultVersion at settlement time
  createdAt         DateTime          @default(now())
  updatedAt         DateTime          @updatedAt

  match             LeagueMatch       @relation(fields: [matchId], references: [id])

  @@unique([matchId, agentId])
  @@index([agentId, status])
  @@index([matchId, status])
}

/// Two agents wager $ARENA on who scores higher on the same match (§9).
/// challengerId/opponentId are agentIds (loose reference, §1.7).
model LeagueBattle {
  id           String             @id @default(uuid())
  seasonId     String
  matchId      String
  challengerId String
  opponentId   String
  stakeArena   Float
  status       LeagueBattleStatus @default(PENDING)
  escrowId     String?            @unique
  winnerId     String?
  createdAt    DateTime           @default(now())
  acceptedAt   DateTime?
  settledAt    DateTime?

  match        LeagueMatch        @relation(fields: [matchId], references: [id])
  escrow       EscrowRecord?      @relation(fields: [escrowId], references: [id])

  @@index([matchId, status])
  @@index([challengerId])
  @@index([opponentId])
}

/// Canonical pairwise record between two agents. agentLowId/agentHighId
/// are agentIds ordered lexicographically so (A,B) and (B,A) always
/// resolve to the same row.
model LeagueRivalry {
  id             String    @id @default(uuid())
  seasonId       String
  agentLowId     String
  agentHighId    String
  agentLowWins   Int       @default(0)
  agentHighWins  Int       @default(0)
  disagreements  Int       @default(0)  // predictions on the same match w/ different winners
  totalMatchups  Int       @default(0)  // battles + disagreements combined
  lastMatchupAt  DateTime?
  narrative      String?
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt

  @@unique([seasonId, agentLowId, agentHighId])
}

/// Per-agent, per-season League standing. tribe is fixed at enrollment (§3.2).
model LeagueAgentSeasonStats {
  id                    String      @id @default(uuid())
  seasonId              String
  agentId               String
  tribe                 LeagueTribe
  reputation            Float       @default(1500)
  reputationProvisional Boolean     @default(true)  // true until predictionsTotal >= 20
  predictionsTotal      Int         @default(0)
  correctWinnerCount    Int         @default(0)
  exactScoreCount       Int         @default(0)
  currentStreak         Int         @default(0)
  bestStreak            Int         @default(0)
  battleWins            Int         @default(0)
  battleLosses          Int         @default(0)
  arenaEarnedSeason     Float       @default(0)
  avgConvictionCorrect  Float       @default(0)
  avgConvictionWrong    Float       @default(0)
  enrolledAt            DateTime    @default(now())
  updatedAt             DateTime    @updatedAt

  season                LeagueSeason @relation(fields: [seasonId], references: [id])

  @@unique([seasonId, agentId])
  @@index([seasonId, reputation])
  @@index([seasonId, tribe, reputation])
}

/// One row per user, platform-wide (not season-scoped — KP and faction
/// membership persist across seasons; weekly fields reset per §14.3).
model LeagueUserProfile {
  id                  String       @id @default(uuid())
  userId              String       @unique
  factionId           LeagueTribe?
  factionJoinedAt     DateTime?
  lastFactionSwitchAt DateTime?
  kpBalance           Int          @default(0)
  kpWeekly            Int          @default(0)
  weekStartAt         DateTime     @default(now())
  dayStreak           Int          @default(0)
  lastActiveDate      DateTime?
  updatedAt           DateTime     @updatedAt
  createdAt           DateTime     @default(now())
}

/// Append-only KP ledger — the KP analog of LedgerEntry. The unique
/// constraint on (refType, refId, reason) is the idempotency guard:
/// settlement re-runs that try to award KP again for the same
/// prediction/reason are rejected at the DB level.
model LeagueKpLedger {
  id           String   @id @default(uuid())
  userId       String
  amount       Int          // negative for admin corrections
  reason       String       // "predict" | "correct" | "upset" | "rivalry" | "correction"
  refType      String       // "prediction" | "battle" | "rivalry"
  refId        String
  balanceAfter Int
  createdAt    DateTime @default(now())

  @@unique([refType, refId, reason])
  @@index([userId, createdAt])
}

/// Auto-generated shareable content (§13). idempotencyKey guarantees
/// one Moment per (type, subject, agent) even across settlement retries.
model LeagueMoment {
  id             String           @id @default(uuid())
  seasonId       String
  type           LeagueMomentType
  agentId        String?
  matchId        String?
  text           String
  payload        Json             @default("{}")
  idempotencyKey String           @unique
  createdAt      DateTime         @default(now())

  match          LeagueMatch?     @relation(fields: [matchId], references: [id])

  @@index([seasonId, createdAt])
  @@index([agentId])
}

/// Frozen weekly leaderboard snapshots, written at the Sunday 00:00 UTC
/// reset (§14.3) before the live Redis ZSETs are cleared.
model LeagueWeeklySnapshot {
  id          String   @id @default(uuid())
  seasonId    String
  weekStartAt DateTime
  scope       String   // "global" | "faction:NEXUS_01" | ...
  rankings    Json     // [{ subjectId, rank, score }]
  createdAt   DateTime @default(now())

  season      LeagueSeason @relation(fields: [seasonId], references: [id])

  @@unique([seasonId, weekStartAt, scope])
}

/// One row per match settlement attempt — the audit trail for §10's
/// idempotency + correction-window logic.
model LeagueSettlementLog {
  id          String   @id @default(uuid())
  matchId     String   @unique
  resultHash  String   // hash of the normalized result used for this run
  version     Int      @default(1)  // mirrors LeagueMatch.resultVersion
  status      String   @default("COMPLETED")  // COMPLETED | FAILED | PARTIAL
  errorDetail String?
  processedAt DateTime @default(now())
}
```

### 4.4 Migration sequencing note

The `EscrowRecord.leagueBattleId` addition and `TransactionType` enum extension can ship in the **same migration** as the new tables — both are additive (`ALTER TABLE ... ADD COLUMN ... NULL`, `ALTER TYPE ... ADD VALUE`) and require no backfill, no lock-heavy rewrite, and no application downtime on Postgres ≥ 12.

---

## 5. Currency, Scoring & Reputation Engine

### 5.1 Three currencies, recap

| Currency | Scope | Storage | Mutates via |
|---|---|---|---|
| **$ARENA** | Per-agent | `AgentWallet.balanceArena` + `LedgerEntry` | New `TransactionType` values (§4.1), same crediting path as Battle rewards |
| **KP** | Per-user (owner), platform-wide | `LeagueUserProfile.kpBalance` + `LeagueKpLedger` | New ledger, §4.3 |
| **Reputation** | Per-agent, per-season | `LeagueAgentSeasonStats.reputation` | Recomputed at settlement, never directly spent/credited |

KP and $ARENA never convert into each other — there is no code path that reads one ledger to write the other. Reputation is derived (recomputed from counters), never stored as a delta-applied balance, which avoids drift from missed/duplicated updates.

### 5.2 Scoring constants [DECISION — all values live in `LeagueSeason.config.scoring`, defaults below]

```ts
// packages/shared-utils/src/league/scoring.ts

export const DEFAULT_SCORING_CONFIG = {
  basePoints: {
    correctWinnerOnly: 20,
    correctExactScore: 50,   // implies correct winner; NOT additive with the 20
    incorrect: 0,
  },
  convictionMultiplier: {
    LOW: 1.0,     // 🔥
    MEDIUM: 1.25, // 🔥🔥
    HIGH: 1.5,    // 🔥🔥🔥
  },
  stageMultiplier: {
    GROUP: 1.0,
    ROUND_OF_32: 1.25,
    ROUND_OF_16: 1.5,
    QUARTER_FINAL: 2.0,
    SEMI_FINAL: 3.0,
    THIRD_PLACE: 3.0,   // [DECISION] not specified in source PDF; treated as SF-equivalent
    FINAL: 5.0,
  },
  upsetBonus: 0.25,       // +25% if backing the underdog and correct
  kp: {
    perPrediction: 2,     // awarded for any settled, non-void prediction
    perCorrectWinner: 5,
    perUpsetBonus: 5,     // additive on top of perCorrectWinner if isUpset
  },
} as const;
```

### 5.3 `scoreLeaguePrediction` — the core function

Pure function, called once per `LOCKED` prediction during settlement (§10.2). Inputs are the prediction row and the normalized match result (§8.1) plus an `isUnderdog(agentId)` flag (§5.4).

```ts
interface ScoreResult {
  isCorrectWinner: boolean;
  isExactScore: boolean;
  isUpset: boolean;
  basePoints: number;
  arenaAwarded: number;   // rounded, credited to AgentWallet.balanceArena
  kpAwarded: number;      // credited to LeagueUserProfile.kpBalance
}

function scoreLeaguePrediction(
  prediction: LeaguePrediction,
  result: NormalizedMatchResult,
  match: LeagueMatch,
  wasUnderdog: boolean,
  config = DEFAULT_SCORING_CONFIG,
): ScoreResult {
  const isCorrectWinner = prediction.winner === result.winner;
  const isExactScore =
    isCorrectWinner &&
    prediction.scoreHome === result.scoreHome &&
    prediction.scoreAway === result.scoreAway;

  if (!isCorrectWinner) {
    return {
      isCorrectWinner: false,
      isExactScore: false,
      isUpset: false,
      basePoints: config.basePoints.incorrect,
      arenaAwarded: 0,
      kpAwarded: config.kp.perPrediction, // KP rewards participation, not correctness
    };
  }

  const isUpset = wasUnderdog; // correct AND backed the underdog
  const basePoints = isExactScore
    ? config.basePoints.correctExactScore
    : config.basePoints.correctWinnerOnly;

  const convictionMult = config.convictionMultiplier[prediction.conviction];
  const stageMult = config.stageMultiplier[match.stage];
  const upsetMult = isUpset ? 1 + config.upsetBonus : 1;

  const arenaAwarded = Math.round(basePoints * convictionMult * stageMult * upsetMult);

  let kpAwarded = config.kp.perPrediction + config.kp.perCorrectWinner;
  if (isUpset) kpAwarded += config.kp.perUpsetBonus;

  return { isCorrectWinner, isExactScore, isUpset, basePoints, arenaAwarded, kpAwarded };
}
```

**Worked check (matches §20.1 max-payout):** Final, exact score, 🔥🔥🔥 conviction, no upset → `50 × 1.5 × 5.0 × 1 = 375` $ARENA. ✅ matches the product spec's stated ceiling.

### 5.4 Defining "underdog" — `wasUnderdog(agentId, match)`

The spec requires an upset bonus for "backing the underdog" but does not define how favorite/underdog is determined (no betting-odds provider is in scope per §8). **[DECISION]** Favorite/underdog is derived purely from data already in the platform — the **AI consensus** computed for that match:

```
consensusWinner(match) = mode(prediction.winner) across all LOCKED predictions for that match
                          at lock time, computed once and cached on LeagueMatch.result.consensus

wasUnderdog(prediction) = prediction.winner !== consensusWinner(match)
                          AND prediction.winner !== 'DRAW'
                          (a draw pick is never scored as an "upset" — too common to be meaningful)
```

This is computed once at lock time (§6.3) and stored in `LeagueMatch.result.consensus` (a field on the `Json` column, populated before `result` itself is known) so settlement reads a frozen value rather than recomputing against post-hoc data.

### 5.5 Reputation — Bayesian-smoothed composite

**[DECISION — formula + constants live in `LeagueSeason.config.reputation`]**. Recomputed for a single agent immediately after its prediction (and any battle) for a match settles — O(1) per affected agent, never a global recompute.

```ts
export const DEFAULT_REPUTATION_CONFIG = {
  base: 1500,
  priorAccuracy: 0.45,    // slightly below 50% — three-way outcome is harder than a coin flip
  priorWeight: 10,        // first 10 predictions are heavily smoothed toward priorAccuracy
  accuracyWeight: 2000,   // smoothedAccuracy contributes 0..2000
  exactRateWeight: 1000,  // smoothedExactRate contributes 0..1000
  battleWinWeight: 500,   // battle win-rate contributes 0..500
  streakBonusPerWin: 20,  // currentStreak * 20, capped at streakBonusCap
  streakBonusCap: 300,
  calibrationRange: 200,  // conviction-calibration contributes -200..+200
  rivalryBonusWeight: 300, // rivalryRate (win-rate across "serious" rivalries, totalMatchups>=3) contributes 0..300
  evolutionStageBonus: {  // flat bonus per current evolution stage
    GENESIS: 0,
    AWAKENED: 100,
    ASCENDED: 250,
    LEGENDARY: 400,
    MYTHIC: 500,
  },
  min: 0,
  max: 6000,
} as const;

function smoothedRate(hits: number, total: number, prior: number, priorWeight: number): number {
  return (hits + prior * priorWeight) / (total + priorWeight);
}

function computeReputation(stats: LeagueAgentSeasonStats, evolutionStage: EvolutionStage, cfg = DEFAULT_REPUTATION_CONFIG): number {
  const accuracy = smoothedRate(stats.correctWinnerCount, stats.predictionsTotal, cfg.priorAccuracy, cfg.priorWeight);
  const exactRate = smoothedRate(stats.exactScoreCount, stats.predictionsTotal, cfg.priorAccuracy * 0.3, cfg.priorWeight);

  const battleTotal = stats.battleWins + stats.battleLosses;
  const battleWinRate = battleTotal > 0 ? smoothedRate(stats.battleWins, battleTotal, 0.5, 4) : 0.5;

  const streakBonus = Math.min(stats.currentStreak * cfg.streakBonusPerWin, cfg.streakBonusCap);

  // Conviction calibration: reward agents whose conviction tracks their actual hit rate
  // (high conviction more often correct than wrong = positive; inverted = negative).
  const calibration = clamp(
    (stats.avgConvictionCorrect - stats.avgConvictionWrong) * cfg.calibrationRange,
    -cfg.calibrationRange,
    cfg.calibrationRange,
  );

  // Win-rate across this agent's "serious" rivalries (totalMatchups >= 3),
  // 0 if it has none yet — read fresh from LeagueRivalry on every recompute.
  const rivalryBonus = clamp(stats.rivalryRate, 0, 1) * cfg.rivalryBonusWeight;

  const raw =
    cfg.base +
    cfg.accuracyWeight * (accuracy - 0.5) * 2 +      // map 0..1 -> -1..1 -> scaled
    cfg.exactRateWeight * exactRate +
    cfg.battleWinWeight * (battleWinRate - 0.5) * 2 +
    streakBonus +
    calibration +
    rivalryBonus +
    cfg.evolutionStageBonus[evolutionStage];

  return clamp(raw, cfg.min, cfg.max);
}
```

`reputationProvisional` (on `LeagueAgentSeasonStats`) is simply `predictionsTotal < 20` — recomputed alongside reputation, surfaced to the frontend as a "provisional" badge so early-season swings don't look like real leaderboard volatility.

**Reconciliation with the KULT V1 Economy Spec's `calculateReputation` (§13 of that doc, a 0-100ish scale):** the spec's formula is a strict subset of signals already present here — `adjustedWinRate`/`leagueAccuracy` ≈ the existing accuracy/battle-win-rate terms, `currentStreak` and `evolutionBonus` already have dedicated terms. The one genuinely new signal is **rivalry performance** (`rivalryRate` over "serious" rivalries, `totalMatchups >= 3`), added above as `rivalryBonus` (0..300 on this 0-6000 scale, fetched via `LeagueRepository.getSeriousRivalryRate`). The spec's 0-100 scale itself was not adopted — rebasing `LeagueAgentSeasonStats.reputation` would ripple into every leaderboard/snapshot/default without changing relative ordering, so the existing Bayesian-smoothed 0-6000 scale (base 1500) remains canonical.

### 5.6 $ARENA crediting path (reuses existing infrastructure)

`league-worker`'s settlement step calls the **existing** `financial-orchestrator` crediting primitive (the same one Battle rewards use) with `transactionType: 'LEAGUE_PREDICTION_REWARD'` and `metadata: { refType: 'league_prediction', refId: prediction.id, matchId, seasonId }`. No new wallet-mutation code path — League settlement is a new *caller* of an existing, audited primitive.

### 5.7 KP crediting path (new, narrow)

```ts
// packages/db-client repository — LeagueRepository.creditKp
async creditKp(userId: string, amount: number, reason: string, refType: string, refId: string) {
  return this.db.$transaction(async (tx) => {
    const profile = await tx.leagueUserProfile.upsert({
      where: { userId },
      create: { userId, kpBalance: amount, kpWeekly: amount },
      update: { kpBalance: { increment: amount }, kpWeekly: { increment: amount } },
    });
    // Unique constraint on (refType, refId, reason) makes this insert
    // the idempotency boundary — a duplicate call throws P2002 and the
    // caller treats it as "already credited", not an error.
    await tx.leagueKpLedger.create({
      data: { userId, amount, reason, refType, refId, balanceAfter: profile.kpBalance },
    });
    return profile;
  });
}
```

---

## 6. Prediction Lifecycle

### 6.1 State machine

```
            generate (T-24h cron, or lazy on first view)
                          │
                          ▼
                     ┌─────────┐   user edits before lock   ┌─────────┐
                     │ PENDING │ ◄──────────────────────────┤ PENDING │ (USER_OVERRIDE)
                     └────┬────┘                             └─────────┘
                          │
              lock-at-kickoff sweep (§6.3)
                          │
                          ▼
                     ┌─────────┐
                     │ LOCKED  │
                     └────┬────┘
                          │
            match finishes → settlement engine (§10)
                          │
              ┌───────────┴────────────┐
              ▼                         ▼
        ┌──────────┐              ┌─────────┐
        │ SETTLED  │              │  VOID   │  (match cancelled/postponed indefinitely)
        └──────────┘              └─────────┘
```

`VOID` is reachable from `PENDING` or `LOCKED` (a match can be cancelled before or after lock). `SETTLED` and `VOID` are terminal — no transitions out.

### 6.2 Generation: hybrid policy (pre-gen + lazy)

**[DECISION]** Two triggers populate `LeaguePrediction` rows, both calling the same `decideLeaguePrediction` gateway method (§7):

1. **Pre-generation (primary)** — `league-worker` runs an hourly cron that finds `LeagueMatch` rows with `kickoffAt` between `now + 23h` and `now + 25h` (i.e., crosses the T-24h mark) and, for every agent enrolled in the active season, generates a `PENDING` prediction if one doesn't already exist (`@@unique([matchId, agentId])` makes the "doesn't already exist" check a plain insert-or-skip).
2. **Lazy generation (fallback)** — if `league-service` receives a read request (`GET /v1/league/matches/:id`) for a match within the T-24h window and a given agent has no prediction yet (e.g., the agent was created *after* the pre-gen cron ran), it synchronously calls `decideLeaguePrediction` for that one agent before responding. This keeps the "agent is thinking..." UI state rare and bounded to genuinely new agents.

Either path can return `source: 'FALLBACK'` if 0G Compute is degraded — the row is still created as `PENDING`, just tagged accordingly. **Inference never blocks prediction creation** (§1.4).

### 6.3 Validation rules — `validatePrediction`

**[DECISION]** Applied identically whether the source is `AI`, `FALLBACK`, or `USER_OVERRIDE` — a bad AI response is rejected and falls back exactly like a bad user submission would be rejected with a 400.

```ts
function validatePrediction(input: PredictionInput, match: LeagueMatch): void {
  // 1. Integer scores in range
  if (!Number.isInteger(input.scoreHome) || !Number.isInteger(input.scoreAway)) {
    throw new ValidationError('scores must be integers');
  }
  if (input.scoreHome < 0 || input.scoreHome > 20 || input.scoreAway < 0 || input.scoreAway > 20) {
    throw new ValidationError('scores must be within 0-20');
  }

  // 2. Winner must agree with the score (reject incoherent combos)
  const impliedWinner =
    input.scoreHome > input.scoreAway ? 'HOME' :
    input.scoreHome < input.scoreAway ? 'AWAY' : 'DRAW';
  if (impliedWinner !== input.winner) {
    throw new ValidationError(`winner '${input.winner}' is inconsistent with score ${input.scoreHome}-${input.scoreAway}`);
  }

  // 3. Knockout matches cannot predict a draw (regulation must produce a winner)
  if (match.stage !== 'GROUP' && input.winner === 'DRAW') {
    throw new ValidationError('knockout-stage predictions cannot be a draw');
  }

  // 4. Conviction must be a valid enum value (schema-level, but re-checked for AI output)
  if (!['LOW', 'MEDIUM', 'HIGH'].includes(input.conviction)) {
    throw new ValidationError('invalid conviction level');
  }
}
```

If an `AI`-sourced response fails `validatePrediction`, `decideLeaguePrediction` does **one** retry with a corrective system message appended ("your previous response was invalid: <reason>; respond again with a coherent winner/score pair"); a second failure falls through to the deterministic `FALLBACK` generator (§7.3), which is constructed to always pass validation by definition.

### 6.4 Lock-at-kickoff sweep

`league-worker` runs a 1-minute cron:

```sql
-- conditional UPDATE = the lock operation itself; no separate "find then update" race
UPDATE "LeaguePrediction"
SET status = 'LOCKED', "lockedAt" = now()
WHERE status = 'PENDING'
  AND "matchId" IN (
    SELECT id FROM "LeagueMatch"
    WHERE status IN ('SCHEDULED', 'LIVE') AND "kickoffAt" <= now()
  );
```

In the same transaction, for every `LeagueMatch` that just had predictions locked for the first time, compute and persist `consensusWinner` (§5.4) into `LeagueMatch.result.consensus`, and flip `LeagueMatch.status` to `LIVE` if it was `SCHEDULED`.

**One prediction per agent per match** is enforced by the `@@unique([matchId, agentId])` constraint — `USER_OVERRIDE` writes are `UPDATE`s of the existing `PENDING` row, never inserts.

### 6.5 User overrides

`PUT /v1/league/predictions/:matchId/:agentId` (auth: must own `agentId`) — accepted only while the prediction is `PENDING` (i.e., before the lock sweep reaches that match's `kickoffAt`). Runs through the same `validatePrediction`, sets `source: 'USER_OVERRIDE'`, and updates `reasoning` to a user-supplied string (or clears the AI reasoning — frontend decision, not a backend concern).

---

## 7. 0G Compute Strategic Planner

### 7.1 New tool schema — `LEAGUE_PREDICTION_TOOL`

Added to `packages/zerog-client/src/compute.client.ts` alongside the existing `COMBAT_ACTION_TOOL` / `STRATEGY_PLAN_TOOL`, following the same `tool_choice: 'required'` + JSON-schema pattern:

```ts
export const LEAGUE_PREDICTION_TOOL = {
  type: 'function',
  function: {
    name: 'submit_league_prediction',
    description: 'Submit a structured prediction for an upcoming football match.',
    parameters: {
      type: 'object',
      properties: {
        winner: { type: 'string', enum: ['HOME', 'AWAY', 'DRAW'] },
        scoreHome: { type: 'integer', minimum: 0, maximum: 20 },
        scoreAway: { type: 'integer', minimum: 0, maximum: 20 },
        conviction: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
        reasoning: { type: 'string', description: 'One or two sentences, in your archetype voice.' },
      },
      required: ['winner', 'scoreHome', 'scoreAway', 'conviction', 'reasoning'],
      additionalProperties: false,
    },
  },
} as const;
```

A new client method `inferLeaguePrediction(systemPrompt: string, userPrompt: string, opts)` mirrors `inferCombatAction` / `inferStrategyPlan`: builds the chat completion request with `tools: [LEAGUE_PREDICTION_TOOL]`, `tool_choice: 'required'`, sends it through `ZeroGComputeClient`, and runs the result through the existing `parseToolArguments<LeaguePredictionToolArgs>` multi-fallback parser (handles `<think>` blocks, raw/embedded JSON, XML `tool_call` format — unchanged, reused as-is).

### 7.2 `InferenceGateway.decideLeaguePrediction`

New method on `InferenceGateway` (`services/inference-service/src/services/inference-gateway.ts`), same shape as `inferCombatAction`: timeout-guarded, tagged `source`, never throws.

```ts
interface MatchContext {
  matchId: string;
  homeTeam: string;
  awayTeam: string;
  stage: LeagueStage;
  kickoffAt: string;
  // Lightweight context only — no external odds/news data (out of scope, §8)
  headToHead?: { homeWins: number; awayWins: number; draws: number };
}

interface LeaguePredictionResult {
  winner: 'HOME' | 'AWAY' | 'DRAW';
  scoreHome: number;
  scoreAway: number;
  conviction: 'LOW' | 'MEDIUM' | 'HIGH';
  reasoning: string;
  source: 'AI' | 'FALLBACK';
}

async decideLeaguePrediction(agentId: string, matchContext: MatchContext): Promise<LeaguePredictionResult> {
  const agent = await this.agentRepo.findById(agentId); // traits, archetype, reputation snapshot
  const tribe = mapAgentToTribe(agent);                  // §3.2, shared-utils
  const systemPrompt = TRIBE_SYSTEM_PROMPTS[tribe](agent);

  try {
    const raw = await withTimeout(
      this.computeClient.inferLeaguePrediction(systemPrompt, buildMatchPrompt(matchContext)),
      LEAGUE_PREDICTION_TIMEOUT_MS, // [DECISION] 12s — between the 5s combat and 20s strategy timeouts;
                                    // pre-match predictions are not on a player-facing critical path
    );
    const parsed = parseToolArguments<LeaguePredictionToolArgs>(raw);
    validatePrediction(parsed, matchContext); // §6.3 — one retry on failure, then fallback
    return { ...parsed, source: 'AI' };
  } catch {
    return { ...generateFallbackPrediction(agent, matchContext), source: 'FALLBACK' };
  }
}
```

### 7.3 Deterministic fallback — `generateFallbackPrediction`

Must (a) always pass `validatePrediction`, and (b) be **reproducible** for the same `(agentId, matchId)` pair so a settlement re-run or a lazy-gen retry doesn't silently change an already-displayed "thinking" prediction.

```ts
function generateFallbackPrediction(agent: Agent, ctx: MatchContext): Omit<LeaguePredictionResult, 'source'> {
  // Seeded PRNG — deterministic per (agentId, matchId)
  const rng = seededRandom(`${agent.id}:${ctx.matchId}`);

  // Traits bias the pick: higher aggression/creativity -> more decisive (non-draw) picks;
  // higher patience/precision -> tighter score margins.
  const decisiveness = (agent.traits.aggression + agent.traits.creativity) / 2;
  const tightness = (agent.traits.patience + agent.traits.precision) / 2;

  let winner: PredictionOutcome;
  if (ctx.stage !== 'GROUP') {
    // no draws allowed in knockout (§6.3) — bias toward home advantage slightly
    winner = rng() < 0.52 ? 'HOME' : 'AWAY';
  } else {
    const drawChance = 0.28 * (1 - decisiveness); // more decisive agents rarely pick draws
    const r = rng();
    winner = r < drawChance ? 'DRAW' : r < drawChance + 0.5 ? 'HOME' : 'AWAY';
  }

  const margin = winner === 'DRAW' ? 0 : 1 + Math.floor(rng() * (tightness > 0.6 ? 1 : 2));
  const base = Math.floor(rng() * 2); // 0 or 1 base goals for the "losing" side
  const [scoreHome, scoreAway] =
    winner === 'HOME' ? [base + margin, base] :
    winner === 'AWAY' ? [base, base + margin] :
    [base, base];

  const conviction: ConvictionLevel = tightness > 0.7 ? 'HIGH' : tightness > 0.4 ? 'MEDIUM' : 'LOW';

  return {
    winner, scoreHome, scoreAway, conviction,
    reasoning: 'Agent is thinking...', // surfaced verbatim by the frontend per the product spec's degraded-UI state
  };
}
```

### 7.4 Tribe system prompts — pre-launch distinguishability gate

The product spec requires the 4 archetypes to "produce distinguishably different prediction text" as a **pre-launch acceptance gate**. `TRIBE_SYSTEM_PROMPTS` is a `Record<LeagueTribe, (agent: Agent) => string>` — each entry fixes tone, vocabulary, and reasoning structure:

```ts
export const TRIBE_SYSTEM_PROMPTS: Record<LeagueTribe, (agent: Agent) => string> = {
  NEXUS_01: (agent) => `
You are Nexus-01, a Statistician. You predict football matches using cold,
numerical reasoning. Reference form, tempo, and statistical tendencies in
your reasoning. Never use emotional language. Keep your conviction
proportional to how clear-cut the numbers are — only go HIGH conviction
when the data is one-sided. Agent traits: ${JSON.stringify(agent.traits)}.`,

  SHADOW_9: (agent) => `
You are Shadow-9, the Villain. You predict football matches with cynicism
and a taste for chaos. You enjoy picking against the crowd and you frame
your reasoning as if daring the favorite to prove you wrong. Lean toward
HIGH conviction when picking an underdog or an unpopular scoreline. Agent
traits: ${JSON.stringify(agent.traits)}.`,

  ATHENA: (agent) => `
You are Athena, the Oracle. You predict football matches with calm,
principled authority — as if the outcome were foretold. Your reasoning
is short, declarative, and confident without being boastful. Conviction
reflects how settled the outcome feels to you, not how popular the pick
is. Agent traits: ${JSON.stringify(agent.traits)}.`,

  VOIDWALKER: (agent) => `
You are Voidwalker, the Madman. You predict football matches by embracing
chaos — unconventional scorelines, wildcard reasoning, gut feeling over
logic. Your reasoning should feel unpredictable and a little unhinged, but
the winner/score/conviction fields must still be internally consistent.
Agent traits: ${JSON.stringify(agent.traits)}.`,
};
```

**[DECISION]** The "distinguishably different" acceptance gate is operationalized as a pre-launch QA script (`scripts/league/qa-tribe-voice.ts`, not yet written) that calls `decideLeaguePrediction` for one representative agent per tribe against a fixed set of 10 sample matches and asserts (a) no two tribes produce textually identical `reasoning` for the same match, and (b) a simple lexical-diversity check (Jaccard distance on word sets) exceeds a minimum threshold between any tribe pair. This is a release-gate script, not a runtime check — runtime never blocks on it.

---

## 8. Football Data Provider Layer

### 8.1 `IFootballDataProvider` interface — new package `packages/football-data-client`

Mirrors the structure of `packages/zerog-client`/`packages/solana-client` (a thin, swappable client package with its own `package.json`, consumed only by `league-worker`).

```ts
// packages/football-data-client/src/types.ts

export interface ProviderMatch {
  externalId: string;     // provider's fixture id — stored as LeagueMatch.providerId
  homeTeam: string;        // normalized to FIFA 3-letter code (mapping table per provider)
  awayTeam: string;
  kickoffAt: string;       // ISO 8601, UTC
  stage: string;           // provider's raw stage label — mapped to LeagueStage via a per-provider table
  venue?: string;
  matchday?: number;
}

export interface NormalizedMatchResult {
  externalId: string;
  status: 'LIVE' | 'FINISHED' | 'POSTPONED' | 'CANCELLED';
  scoreHome: number | null;          // regulation (90-min) score
  scoreAway: number | null;
  winner: 'HOME' | 'AWAY' | 'DRAW' | null;  // regulation result — used for scoring (§5.3)
  wentToPenalties?: boolean;          // informational only; does NOT change `winner` for scoring
  penaltyScore?: { home: number; away: number };
  finishedAt: string | null;          // ISO 8601, UTC
  consensus?: 'HOME' | 'AWAY' | 'DRAW'; // populated by league-worker at lock time, not by the provider
}

export interface IFootballDataProvider {
  /** Full season schedule — used by the daily schedule-sync job. */
  getSchedule(seasonExternalId: string): Promise<ProviderMatch[]>;

  /** Batched status/result lookup — used by the settlement-polling job. */
  getLiveAndFinishedResults(externalIds: string[]): Promise<NormalizedMatchResult[]>;
}
```

`@@unique([seasonId, providerId])` on `LeagueMatch` (§4.3) makes schedule sync an upsert: new fixtures insert, known fixtures update `kickoffAt`/`venue`/`stage` if the provider revises them (common for World Cup fixtures whose kickoff times shift based on prior-match outcomes in some formats).

> **Note on scope:** the World Cup 2026 fixture list is fixed at tournament-tree level but specific *kickoff times* for later knockout rounds depend on earlier results. The schedule-sync job (§8.3) re-runs daily specifically to catch these updates — `LeagueMatch.kickoffAt` is treated as provider-authoritative and may shift even for `SCHEDULED` matches.

### 8.2 Adapters

| Adapter | Purpose | Status |
|---|---|---|
| `SportmonksProvider` | Primary live data source (real fixtures, scores, status) | **[DECISION — exact Sportmonks v3 field mapping (fixture state codes, score-type "CURRENT" vs "2ND_HALF" segments, participant→FIFA-code table) must be verified against Sportmonks' current API docs at implementation time** — the companion spec that would normally pin this down does not exist on disk. The interface above is provider-agnostic specifically so this can be finalized without changing any caller.** |
| `ApiFootballProvider` | Secondary/backup source, same interface | Stubbed, not wired by default |
| `InternalAdminProvider` | Manual override — admin enters scores via an internal endpoint when both external providers are down or for testing | Always available; see §8.4 |

Each adapter is a class implementing `IFootballDataProvider`; `league-worker` selects one via `LEAGUE_DATA_PROVIDER` env var (`sportmonks` \| `api-football` \| `internal-admin`), defaulting to `internal-admin` in non-production environments so the full pipeline (schedule → predictions → lock → settle) is testable without any external API key.

### 8.3 Schedule sync job

`league-worker` daily cron: `provider.getSchedule(season.providerId)` → upsert into `LeagueMatch` keyed on `(seasonId, providerId)`. Stage-label mapping (`"Group Stage" → GROUP`, `"Round of 16" → ROUND_OF_16`, etc.) is a per-provider lookup table colocated with each adapter — not hardcoded into `league-worker`.

### 8.4 `InternalAdminProvider` and manual correction

`InternalAdminProvider.getLiveAndFinishedResults` reads from a small admin-writable table (or, simplest **[DECISION]**, directly from `LeagueMatch.result` itself when written via the admin endpoint below) — i.e., for environments without a live provider, an admin manually POSTs the result and the settlement engine treats it identically to a provider response.

```
POST /v1/league/admin/matches/:id/result   (X-Service-Key + admin role check)
Body: NormalizedMatchResult (without externalId/consensus)
```

This same endpoint is the entry point for **provider-correction re-scoring** (§10.3): posting a result for a match that already has `status: FINISHED` bumps `resultVersion` and triggers a delta-settlement pass rather than a fresh one.

### 8.5 Required data summary

Per the product spec, the provider layer must supply: **schedule** (§8.1 `ProviderMatch`), **status** (`NormalizedMatchResult.status`), **result** (scores + winner), **teams** (FIFA codes — normalized per-provider), and **players** (optional, not consumed anywhere in V1 — `NormalizedMatchResult` intentionally omits a players field; if a future feature needs lineups, it is additive to this interface, not a breaking change).

---

## 9. Agent Battles & Escrow

### 9.1 Flow overview

A League Battle pits two agents' predictions for the *same match* against each other, with both owners staking $ARENA. It deliberately mirrors the existing Arena Battle escrow lock/settle pattern (`financial-service/src/services/escrow.service.ts`) rather than inventing a new money-movement primitive.

```
1. Challenger creates battle proposal
   POST /v1/league/battles
   { matchId, challengerAgentId, opponentAgentId, stakeArena }
   → LeagueBattle{status: PENDING}
   Requires: challenger owns challengerAgentId; challengerAgentId has a
   PENDING or LOCKED prediction for matchId (auto-generated via lazy-gen
   if missing, §6.2).

2. Opponent accepts
   POST /v1/league/battles/:id/accept   (must own opponentAgentId)
   → validates opponent also has a prediction for matchId (lazy-gen if missing)
   → calls lockLeagueEscrow(battle)        (§9.2)
   → LeagueBattle{status: LOCKED, escrowId: <new EscrowRecord.id>}

3. Match settles (§10) — after BOTH predictions are SETTLED:
   → settleLeagueBattle(battle)            (§9.3)
   → LeagueBattle{status: SETTLED, winnerId}
```

`PENDING` battles expire after a configurable window (**[DECISION]** 24h, or at `kickoffAt` if sooner — whichever is earlier) and transition to `DECLINED` via the same lock-at-kickoff sweep cron (§6.4), no escrow ever touched.

### 9.2 `lockLeagueEscrow` — mirrors `escrow.service.ts` lock, new method

Placed alongside the existing escrow lock/settle methods (financial-service, or escrow-service — whichever the team designates canonical for `EscrowRecord` writes; both currently exist in the repo with overlapping responsibility, so this is a **new method added to the same module that already owns `EscrowRecord` mutations**, not a third implementation):

```ts
async lockLeagueEscrow(battle: LeagueBattle): Promise<EscrowRecord> {
  return this.db.$transaction(async (tx) => {
    const [challengerWallet, opponentWallet] = await Promise.all([
      tx.agentWallet.findUniqueOrThrow({ where: { agentId: battle.challengerId } }),
      tx.agentWallet.findUniqueOrThrow({ where: { agentId: battle.opponentId } }),
    ]);

    if (challengerWallet.balanceArena < battle.stakeArena || opponentWallet.balanceArena < battle.stakeArena) {
      throw new InsufficientBalanceError();
    }

    await tx.agentWallet.update({ where: { agentId: battle.challengerId }, data: { balanceArena: { decrement: battle.stakeArena } } });
    await tx.agentWallet.update({ where: { agentId: battle.opponentId }, data: { balanceArena: { decrement: battle.stakeArena } } });

    await tx.ledgerEntry.createMany({ data: [
      { walletId: challengerWallet.id, type: 'LEAGUE_BATTLE_WAGER', amount: -battle.stakeArena, status: 'COMPLETED', metadata: { refType: 'league_battle', refId: battle.id } },
      { walletId: opponentWallet.id,   type: 'LEAGUE_BATTLE_WAGER', amount: -battle.stakeArena, status: 'COMPLETED', metadata: { refType: 'league_battle', refId: battle.id } },
    ]});

    const escrow = await tx.escrowRecord.create({
      data: {
        state: 'LOCKED',
        agentIds: [battle.challengerId, battle.opponentId],
        amounts: { [battle.challengerId]: battle.stakeArena, [battle.opponentId]: battle.stakeArena },
        leagueBattleId: battle.id,
      },
    });

    await tx.leagueBattle.update({ where: { id: battle.id }, data: { status: 'LOCKED', escrowId: escrow.id, acceptedAt: new Date() } });
    return escrow;
  });
}
```

### 9.3 `settleLeagueBattle` — determining the winner

Runs only after **both** agents' `LeaguePrediction` rows for `matchId` are `SETTLED` (the settlement engine, §10.2, processes all predictions for a match before touching battles for that match — see §10.2 step ordering).

**[DECISION] Winner determination — "higher score wins"** is operationalized using each prediction's `arenaAwarded` value from §5.3 (which already encodes correctness, exact-score, conviction, and stage — i.e., it *is* "the score" the product spec refers to):

```ts
function determineBattleWinner(challengerPred: LeaguePrediction, opponentPred: LeaguePrediction): string | null {
  if (challengerPred.arenaAwarded! > opponentPred.arenaAwarded!) return challengerPred.agentId;
  if (opponentPred.arenaAwarded! > challengerPred.arenaAwarded!) return opponentPred.agentId;
  return null; // exact tie -> VOID, stakes refunded (§9.4)
}
```

Payout mirrors the existing escrow settle: **90% of the pool to the winner, 10% to the Arena Reserve** (`COMMISSION_RATE = 0.10`, same constant reused from `escrow.service.ts`):

```ts
async settleLeagueBattle(battle: LeagueBattle, predictions: [LeaguePrediction, LeaguePrediction]): Promise<void> {
  const winnerId = determineBattleWinner(...predictions);
  if (!winnerId) return voidLeagueBattle(battle); // §9.4

  const pool = battle.stakeArena * 2;
  const payout = pool * (1 - COMMISSION_RATE); // 90%
  const reserveCut = pool * COMMISSION_RATE;   // 10% -> Arena Reserve, recycled not inflated

  await this.db.$transaction(async (tx) => {
    const winnerWallet = await tx.agentWallet.findUniqueOrThrow({ where: { agentId: winnerId } });
    await tx.agentWallet.update({ where: { agentId: winnerId }, data: { balanceArena: { increment: payout } } });
    await tx.ledgerEntry.create({
      data: { walletId: winnerWallet.id, type: 'LEAGUE_BATTLE_REWARD', amount: payout, status: 'COMPLETED', metadata: { refType: 'league_battle', refId: battle.id, reserveCut } },
    });
    await tx.escrowRecord.update({ where: { id: battle.escrowId! }, data: { state: 'SETTLED', winnerId } });
    await tx.leagueBattle.update({ where: { id: battle.id }, data: { status: 'SETTLED', winnerId, settledAt: new Date() } });
  });

  // Best-effort, non-fatal — mirrors existing escrow.service publish pattern
  publishEvent(SUBJECTS.LEAGUE_BATTLE_SETTLED, { battleId: battle.id, winnerId }).catch(() => {});

  // Reputation: +1 battle win / +1 battle loss recorded on LeagueAgentSeasonStats,
  // feeding the battleWinRate term in §5.5's reputation formula on next recompute.
  // Rivalry: +1 matchup, win/loss tally updated (§11).
}
```

### 9.4 Void battles

If the underlying `LeagueMatch` is `CANCELLED` (§10.4) while a `LeagueBattle` is `LOCKED`, or if `determineBattleWinner` returns a tie: both stakes are refunded via `LEAGUE_BATTLE_REFUND` ledger entries, `EscrowRecord.state → CANCELLED`, `LeagueBattle.status → VOID`. No reputation or rivalry changes on a void.

### 9.5 Anti-farm rules

**[DECISION — all constants in `LeagueSeason.config.battles`]**

| Rule | Enforcement point | Detail |
|---|---|---|
| Same-owner agents cannot battle | `POST /v1/league/battles` validation | `league-service` resolves both agents' owning `userId` (via agent-service) and rejects if equal |
| Daily creation cap | `POST /v1/league/battles` | Max **20** `LeagueBattle` rows with `challengerId` owned by the same user, `createdAt` within the trailing 24h |
| Daily acceptance cap | `POST /v1/league/battles/:id/accept` | Max **30** accepted (status moves past `PENDING`) where `opponentId` is owned by the same user, within the trailing 24h |
| Win-trading detection | Settlement-time check (non-blocking) | If the same agent-pair has battled ≥3 times in the season with an alternating win pattern whose probability under `determineBattleWinner`'s implied skill differential is `< 5%`, the pair is flagged into an admin review queue (`LeagueSettlementLog`-adjacent flag table, or simplest: a `LeagueMoment`-free internal note logged via the existing `notification-service` to an admin channel). **V1 does not auto-block** — flag-for-review only, since false positives (two evenly-matched agents legitimately trading wins) are common and an auto-block would be a player-facing false-positive risk. |

---

## 10. Settlement Engine

### 10.1 Polling cron

`league-worker` runs a settlement cron **every 2 minutes** [DECISION — frequent enough that users see results within minutes of a real-world final whistle, infrequent enough to stay well within provider rate limits for ~100 fixtures/month]:

```ts
async function settlementTick() {
  const candidates = await prisma.leagueMatch.findMany({
    where: { status: { in: ['SCHEDULED', 'LIVE'] }, kickoffAt: { lte: new Date() } },
    select: { id: true, providerId: true, resultVersion: true },
  });
  if (candidates.length === 0) return;

  const results = await provider.getLiveAndFinishedResults(candidates.map(c => c.providerId));

  for (const result of results) {
    const match = candidates.find(c => c.providerId === result.externalId)!;
    if (result.status === 'LIVE') {
      await prisma.leagueMatch.update({ where: { id: match.id }, data: { status: 'LIVE', result } });
    } else if (result.status === 'FINISHED') {
      await settleMatch(match.id, result); // §10.2 — idempotent
    } else if (result.status === 'CANCELLED' || result.status === 'POSTPONED') {
      await cancelMatch(match.id, result.status); // §10.4
    }
  }
}
```

### 10.2 `settleMatch` — idempotent, ordered pipeline

The **idempotency boundary is per-prediction**, via a conditional `UPDATE ... WHERE status = 'LOCKED'`. If `settleMatch` is invoked twice for the same match (cron overlap, process restart mid-run), the second pass's `UPDATE` affects zero rows for already-settled predictions and is a correct no-op — no separate "have I done this?" check needed before the claim itself.

```ts
async function settleMatch(matchId: string, result: NormalizedMatchResult) {
  const match = await prisma.leagueMatch.findUniqueOrThrow({ where: { id: matchId } });
  const consensus = match.result?.consensus; // frozen at lock time, §5.4

  await prisma.$transaction(async (tx) => {
    // 1. Persist the final result on the match itself (idempotent — same data on retry)
    await tx.leagueMatch.update({
      where: { id: matchId },
      data: { status: 'FINISHED', result: { ...result, consensus }, settledAt: new Date() },
    });

    // 2. Claim every LOCKED prediction for this match in one statement.
    //    Returns only the rows THIS call is responsible for settling.
    const claimed = await tx.$queryRaw<LeaguePrediction[]>`
      UPDATE "LeaguePrediction"
      SET status = 'SETTLED', "settledAt" = now(), "settlementVersion" = ${match.resultVersion}
      WHERE "matchId" = ${matchId} AND status = 'LOCKED'
      RETURNING *
    `;

    // 3. Score + credit each claimed prediction.
    for (const pred of claimed) {
      const wasUnderdog = pred.winner !== consensus && pred.winner !== 'DRAW';
      const score = scoreLeaguePrediction(pred, result, match, wasUnderdog); // §5.3

      await tx.leaguePrediction.update({ where: { id: pred.id }, data: {
        isCorrectWinner: score.isCorrectWinner, isExactScore: score.isExactScore, isUpset: score.isUpset,
        basePoints: score.basePoints, arenaAwarded: score.arenaAwarded, kpAwarded: score.kpAwarded,
      }});

      if (score.arenaAwarded > 0) {
        await creditArena(tx, pred.agentId, score.arenaAwarded, 'LEAGUE_PREDICTION_REWARD', 'league_prediction', pred.id); // §5.6
      }
      const ownerId = await resolveAgentOwner(pred.agentId); // agent-service lookup, cached
      await creditKp(tx, ownerId, score.kpAwarded, score.isCorrectWinner ? 'correct' : 'predict', 'league_prediction', pred.id); // §5.7

      // 4. Recompute this agent's reputation + streak/counter fields (§5.5) — O(1).
      await updateAgentSeasonStats(tx, pred.agentId, match.seasonId, score);
    }
  });

  // 5. Settle any LeagueBattle wrapping two now-SETTLED predictions for this match.
  //    Runs AFTER the transaction above commits, so both predictions' arenaAwarded
  //    values are guaranteed final.
  const battles = await prisma.leagueBattle.findMany({ where: { matchId, status: 'LOCKED' } });
  for (const battle of battles) {
    const [a, b] = await Promise.all([
      prisma.leaguePrediction.findUnique({ where: { matchId_agentId: { matchId, agentId: battle.challengerId } } }),
      prisma.leaguePrediction.findUnique({ where: { matchId_agentId: { matchId, agentId: battle.opponentId } } }),
    ]);
    await settleLeagueBattle(battle, [a!, b!]); // §9.3 — its own transaction
  }

  // 6. Rivalry updates (§11), evolution check (best-effort), KULT Moments (§13),
  //    NATS events — all best-effort, non-fatal, run after the financial
  //    transaction has committed so a failure here never rolls back a payout.
  await Promise.allSettled([
    updateRivalries(matchId, result, consensus),
    triggerEvolutionChecks(claimedAgentIds),
    generateMoments(matchId, result, consensus),
    publishEvent(SUBJECTS.LEAGUE_MATCH_SETTLED, { matchId }),
  ]);

  // 7. Audit log — written last; if anything above threw, this row is
  //    either absent (whole settleMatch retried) or status='PARTIAL'
  //    (caught and recorded by the cron's error handler).
  await prisma.leagueSettlementLog.upsert({
    where: { matchId },
    create: { matchId, resultHash: hashResult(result), version: match.resultVersion, status: 'COMPLETED' },
    update: { resultHash: hashResult(result), version: match.resultVersion, status: 'COMPLETED', processedAt: new Date() },
  });
}
```

Step 6's best-effort fan-out matches the existing "settlement never blocks on the agent-brain gateway" requirement — memory-service writes are queued with retry (reusing whatever retry-queue mechanism `memory-service` already exposes for episodic writes; if none exists, a simple `LeagueMoment`-adjacent outbox table is the minimal addition, deferred to implementation).

### 10.3 Provider-correction re-scoring (24h window)

Football results occasionally get corrected post-match (VAR review reversals logged late, provider data-entry fixes). **[DECISION]**

- Window: corrections accepted only while `now() - LeagueMatch.settledAt < 24h`.
- Trigger: `POST /v1/league/admin/matches/:id/result` (§8.4) with a result that differs from the stored one, **admin-role-gated**.
- On accept: `LeagueMatch.resultVersion += 1`, then `settleMatch` runs again — but step 2's claim becomes:
  ```sql
  UPDATE "LeaguePrediction"
  SET "settlementVersion" = <newVersion>, ...
  WHERE "matchId" = $1 AND status = 'SETTLED' AND "settlementVersion" = <oldVersion>
  RETURNING *
  ```
  i.e., the same claim-by-conditional-update pattern, just claiming `SETTLED @ oldVersion` instead of `LOCKED`. Crediting in step 3 then computes **deltas**: `creditArena(..., newArenaAwarded - oldArenaAwarded, ...)` — a negative delta is a valid `LedgerEntry` (debit), consistent with how the existing ledger already supports negative `LEAGUE_*` amounts for corrections (§4.1 enum doc comment). KP corrections work identically via `LeagueKpLedger` with `reason: 'correction'`.
- `LeagueSettlementLog.version` is bumped to match, and `resultHash` changes — giving a clean audit trail of "this match was re-scored, here's the before/after."
- Battles already `SETTLED` under the old version are **not** automatically re-settled — a battle outcome reversal would require clawing back a payout already spent on something else (no such concept exists for $ARENA in V1, but it's still the wrong UX). **[DECISION]** Battle outcomes are final at first settlement; only prediction-level $ARENA/KP/reputation are corrected. This is called out explicitly to product as a known limitation of the correction window.

### 10.4 Cancellation / postponement → VOID

```ts
async function cancelMatch(matchId: string, status: 'CANCELLED' | 'POSTPONED') {
  if (status === 'POSTPONED') {
    // Just update kickoffAt when the provider supplies a new date (schedule sync, §8.3)
    // handles this naturally; postponed-without-new-date matches stay SCHEDULED with
    // their predictions remaining PENDING/LOCKED until either a new date arrives or
    // an admin marks it CANCELLED.
    return;
  }
  await prisma.$transaction(async (tx) => {
    await tx.leagueMatch.update({ where: { id: matchId }, data: { status: 'CANCELLED' } });
    await tx.leaguePrediction.updateMany({
      where: { matchId, status: { in: ['PENDING', 'LOCKED'] } },
      data: { status: 'VOID' },
    });
    const battles = await tx.leagueBattle.findMany({ where: { matchId, status: { in: ['PENDING', 'ACCEPTED', 'LOCKED'] } } });
    for (const battle of battles) {
      if (battle.status === 'LOCKED') await voidLeagueBattle(tx, battle); // refund both stakes, §9.4
      else await tx.leagueBattle.update({ where: { id: battle.id }, data: { status: 'VOID' } });
    }
  });
}
```

No scoring, no $ARENA/KP movement, no reputation change, no Moments for `VOID` predictions — they simply stop existing as far as the economy is concerned, while remaining visible in history with a `VOID` status for transparency.

---

## 11. Rivalry System

### 11.1 Canonical row + auto-formation

`LeagueRivalry` is keyed `(seasonId, agentLowId, agentHighId)` with `agentLowId < agentHighId` (string comparison) — both directions of a pair always resolve to one row. A row is created lazily (upsert) the first time either trigger fires:

1. **Battle** — `settleLeagueBattle` (§9.3) always upserts the rivalry row for the battling pair, incrementing `totalMatchups` and the appropriate `agentLowWins`/`agentHighWins`.
2. **Disagreement** — within `settleMatch`'s step 6 (`updateRivalries`), for every pair of agents that both had a `SETTLED` prediction on this match with **different `winner` values**, increment `disagreements` (and `totalMatchups`) on their rivalry row. **[DECISION]** to bound the cost of this step, it only runs pairwise among agents that are *already faction-mates or already have an existing rivalry row* — not an all-pairs scan across every enrolled agent (which would be O(n²) per match for potentially thousands of agents). A brand-new rivalry is seeded only via a Battle (trigger 1); disagreements only *deepen* an existing rivalry.

### 11.2 Narrative + memory importance at 5+ matchups

```ts
async function updateRivalries(matchId: string, result: NormalizedMatchResult, consensus: string) {
  // ... upsert logic per 11.1 ...

  for (const rivalry of touchedRivalries) {
    if (rivalry.totalMatchups >= 5 && !rivalry.narrative) {
      const leadAgent = rivalry.agentLowWins >= rivalry.agentHighWins ? rivalry.agentLowId : rivalry.agentHighId;
      const trailAgent = leadAgent === rivalry.agentLowId ? rivalry.agentHighId : rivalry.agentLowId;
      const [leadWins, trailWins] = leadAgent === rivalry.agentLowId
        ? [rivalry.agentLowWins, rivalry.agentHighWins]
        : [rivalry.agentHighWins, rivalry.agentLowWins];

      await prisma.leagueRivalry.update({ where: { id: rivalry.id }, data: {
        narrative: `${leadAgent} leads ${trailAgent} ${leadWins}-${trailWins}`, // persistent head-to-head record, §11.3
      }});

      await createMoment({ type: 'RIVALRY', matchId, agentId: leadAgent, /* ... */ }); // §13

      // Best-effort: bump episodic memory importance for both agents re: this rivalry
      callMemoryService('importance-bump', { agentIds: [rivalry.agentLowId, rivalry.agentHighId], topic: 'rivalry', rivalryId: rivalry.id }).catch(() => {});
    }
  }
}
```

### 11.3 Persistent record format

The frontend's `RIVALRY` mock (`{ leftAgent, rightAgent, leftWins, rightWins, reputationReward, kpReward }`) maps directly: `agentLowWins`/`agentHighWins` → `leftWins`/`rightWins` (ordering by which agent the frontend treats as "left" is a presentation concern — `league-service` returns both agent IDs and lets the frontend pick orientation based on the *viewing user's* agent, so "your agent" is always on the left). `reputationReward`/`kpReward` in the mock represent the *next* matchup's stakes — computed on read as a function of the rivalry's `totalMatchups` (higher stakes for more storied rivalries): **[DECISION]** `reputationReward = 50 + totalMatchups * 20`, `kpReward = 100 + totalMatchups * 30`, surfaced for display only — actual rewards on settlement still flow through §5 and §9.3's normal scoring/payout, these display numbers are not a separate pool.

---

## 12. Factions

### 12.1 Join / switch

`POST /v1/league/faction { tribe: LeagueTribe }` (auth required).

```ts
async function joinFaction(userId: string, tribe: LeagueTribe) {
  const profile = await prisma.leagueUserProfile.upsert({ where: { userId }, create: { userId }, update: {} });

  if (profile.factionId) {
    // Switching, not joining for the first time — enforce cooldown
    const cooldownEnds = addDays(profile.lastFactionSwitchAt ?? profile.factionJoinedAt!, 7);
    if (new Date() < cooldownEnds) {
      throw new ConflictError(`faction switch available after ${cooldownEnds.toISOString()}`);
    }
  }

  // Sybil guard: require >=1 qualifying action toward the NEW faction
  const qualifies = await hasQualifyingAction(userId, tribe);
  if (!qualifies) throw new ValidationError('no qualifying action for this faction yet');

  await prisma.leagueUserProfile.update({ where: { userId }, data: {
    factionId: tribe,
    factionJoinedAt: profile.factionId ? profile.factionJoinedAt : new Date(),
    lastFactionSwitchAt: new Date(),
  }});

  publishEvent(SUBJECTS.LEAGUE_FACTION_JOINED, { userId, tribe }).catch(() => {});
}
```

### 12.2 "Qualifying action" — `[DECISION]`

`hasQualifyingAction(userId, tribe)` returns true if **either**:
- the user owns at least one agent whose `LeagueAgentSeasonStats.tribe === tribe` (their own roster already "belongs" to that tribe), **or**
- the user has made at least one `SETTLED` or `LOCKED` prediction this season on an agent of that tribe (even if not their own — e.g., via a future "support an agent" feature).

This is deliberately cheap to check (two indexed existence queries) and ties faction eligibility to *something the user already did*, not just a click — satisfying the Sybil-resistance intent without inventing a new "activity score."

### 12.3 Leaderboard weighting — active supporters, not raw membership

The product spec requires faction leaderboards to weight by **active supporters**, not raw member count. **[DECISION]** "Active" = `LeagueUserProfile.lastActiveDate` within the trailing 7 days, where `lastActiveDate` is updated (idempotently, once per UTC day) any time the user's owned agents have a `SETTLED` prediction or the user makes an authenticated League API call. Faction score:

```
factionScore(tribe) = Σ over users where factionId = tribe AND lastActiveDate >= now() - 7d
                         of Σ over that user's agents enrolled with tribe = tribe
                           of LeagueAgentSeasonStats.reputation
```

Computed by `league-worker` as part of the weekly snapshot job (§14.3) and cached in Redis (`league:leaderboard:faction:{tribe}`) for fast reads; not recomputed on every request.

---

## 13. KULT Moments

### 13.1 Trigger catalogue and idempotency

All 8 `LeagueMomentType` values are generated inside `settleMatch`'s step 6 (`generateMoments`), keyed so retries never duplicate:

| Type | Trigger condition | `idempotencyKey` |
|---|---|---|
| `VINDICATION` | `isCorrectWinner && winner !== consensus` (correct AND went against the crowd, but not flagged `isUpset` — i.e., consensus existed but wasn't unanimous) | `VINDICATION:{matchId}:{agentId}` |
| `ROAST` | Agent's prediction was correct AND a *rival* (per §11) agent's prediction on the same match was incorrect | `ROAST:{matchId}:{agentId}:{rivalAgentId}` |
| `UPSET` | `isUpset === true` (§5.3) | `UPSET:{matchId}:{agentId}` |
| `RIVALRY` | Rivalry reaches 5+ matchups (§11.2) | `RIVALRY:{rivalryId}` |
| `STREAK` | `currentStreak` crosses a milestone (3, 5, 10...) after this settlement | `STREAK:{matchId}:{agentId}:{streakValue}` |
| `ASCENSION` | `triggerEvolutionChecks` (step 6) reports an evolution-stage change | `ASCENSION:{matchId}:{agentId}` |
| `EVOLUTION` | `triggerEvolutionChecks` reports a trait-vector shift without a stage change | `EVOLUTION:{matchId}:{agentId}` |
| `FACTION` | Weekly snapshot job (§14.3) detects a faction leaderboard lead change | `FACTION:{weekStartAt}:{tribe}` |

Every `idempotencyKey` is globally unique (`LeagueMoment.idempotencyKey @unique`, §4.3) — `generateMoments` always uses `createMany({ skipDuplicates: true })` or a per-row `upsert` no-op, so a re-run after a crash produces zero duplicate Moments.

### 13.2 Content generation — text now, images deferred

`LeagueMoment.text` is generated from a small per-type template populated with the agent's tribe voice (reusing `TRIBE_SYSTEM_PROMPTS`-style framing, but as **static string templates**, not a live 0G Compute call — Moments must generate even when 0G Compute is fully down, since they're triggered by settlement which must never block on inference per §1.4):

```ts
const MOMENT_TEMPLATES: Record<LeagueMomentType, (ctx: MomentContext) => string> = {
  VINDICATION: (c) => `${c.agentName} called it against the crowd — ${c.scoreline}.`,
  ROAST: (c) => `${c.agentName} watches ${c.rivalName} eat a wrong pick. No comment needed.`,
  UPSET: (c) => `${c.agentName} backed the underdog and got paid. +${c.arenaAwarded} $ARENA.`,
  // ... etc, one line per type, tone-adjusted by tribe where the template has a {tribeAdjective} slot
};
```

**[OPEN — flagged for product/frontend]** The product spec describes Moments as generated "via the existing OG-image pipeline." **No such pipeline exists in this backend** (`notification-service` is a Redis-list + pub/sub notifier; `storage-service`/`replay-service` don't render images). Two paths forward, neither blocking the rest of this design since `LeagueMoment` is pure structured data either way:
- **(a)** Frontend renders share cards client-side or via a Vercel/Next OG-image route (`/api/og/moment/:id`) that fetches `GET /v1/league/moments/:id` and rasterizes it — zero new backend work.
- **(b)** A new lightweight image-rendering capability is added to `notification-service` (or a new `content-service`) if server-rendered share images are a hard requirement.
This document recommends **(a)** for V1 — it's strictly additive to the frontend and requires no backend image pipeline, matching the "no backend changes beyond what's needed" principle. Final call belongs to product/frontend.

### 13.3 Feed endpoint

`GET /v1/league/moments?limit=20&agentId=&seasonId=` — simple `ORDER BY createdAt DESC` over `LeagueMoment`, indexed (`@@index([seasonId, createdAt])`). This is the `LEAGUE_MOMENTS` feed consumed by `LeagueMomentsTicker` (§15).

---

## 14. Leaderboards

### 14.1 Pattern — reuse `leaderboard-service`'s Redis-first/Postgres-fallback design

`leaderboard-service/src/services/leaderboard.service.ts` already implements the exact shape needed: Redis sorted sets (`ZADD`/`ZREVRANGE`/`ZREVRANK`) as the hot path, with Postgres as the source of truth for rebuilds. League leaderboards are **new sorted sets in the same Redis instance**, written by `league-worker` after each `updateAgentSeasonStats` call (§10.2 step 4) — not a new service.

```ts
// after reputation recompute in settleMatch:
await redis.zadd(`league:leaderboard:global:${seasonId}`, newReputation, agentId);
await redis.zadd(`league:leaderboard:faction:${tribe}:${seasonId}`, newReputation, agentId);
```

### 14.2 Priority order

Per the product spec: **Global Reputation (primary) → Faction → Weekly**. This maps to three Redis keys, all maintained continuously:

| Leaderboard | Redis key | Read endpoint |
|---|---|---|
| Global Reputation | `league:leaderboard:global:{seasonId}` | `GET /v1/league/leaderboard?scope=global` |
| Faction | `league:leaderboard:faction:{tribe}:{seasonId}` | `GET /v1/league/leaderboard?scope=faction&tribe=NEXUS_01` |
| Weekly | `league:leaderboard:weekly:{seasonId}:{weekStartAt}` | `GET /v1/league/leaderboard?scope=weekly` |

**Accuracy and Rivalry leaderboards are explicitly deferred to V1.1** per the product spec — not built in this phase. (The data to build them — `correctWinnerCount`/`predictionsTotal` and `LeagueRivalry` rows — already exists, so V1.1 is additive-only when it arrives: new Redis keys + read endpoints, no schema changes.)

### 14.3 Weekly leaderboard — Sunday 00:00 UTC reset

`league-worker` cron, scheduled for `00:00 UTC` every Sunday:

```ts
async function weeklyReset(seasonId: string) {
  const weekStartAt = startOfPreviousWeekUTC();

  for (const scope of ['global', ...FACTION_SCOPES]) {
    const key = `league:leaderboard:weekly:${seasonId}:${weekStartAt}`;
    const rankings = await redis.zrevrange(key, 0, -1, 'WITHSCORES');
    await prisma.leagueWeeklySnapshot.create({ data: { seasonId, weekStartAt, scope, rankings: serialize(rankings) } }); // frozen snapshot (§4.3)
  }

  // Clear weekly counters for the new week (global/faction reputation
  // leaderboards are NOT cleared — only the weekly-delta tracking is)
  await redis.del(`league:leaderboard:weekly:${seasonId}:*`); // pattern-scan delete
  await prisma.leagueUserProfile.updateMany({ data: { kpWeekly: 0, weekStartAt: new Date() } });
}
```

The "weekly" leaderboard tracks **KP earned this week** (`LeagueUserProfile.kpWeekly`, incremented alongside `kpBalance` in §5.7's `creditKp`), not reputation — reputation is cumulative/seasonal and belongs to the global/faction boards. This distinction matches the frontend's `KP_WEEK_PROGRESS` mock (`current`/`target`/`globalRank` — a KP progress bar, not a reputation figure).

### 14.4 Postgres fallback / rebuild

If a Redis key is missing or `league-worker` detects drift (e.g., after a Redis flush), it rebuilds from Postgres: `SELECT agentId, reputation FROM "LeagueAgentSeasonStats" WHERE seasonId = $1 ORDER BY reputation DESC` → bulk `ZADD`. This mirrors `leaderboard.service.ts`'s existing rebuild path exactly — no new rebuild logic class, just a new table/key pair fed into the same mechanism.

---

## 15. Service Topology & API Surface

### 15.1 Frontend → API mapping

Every export in `kult-games-v3/src/components/league/leagueData.ts` (currently mocked) maps to a `league-service` endpoint as follows:

| Frontend component | Mock data export | Endpoint | Notes |
|---|---|---|---|
| `LeaguePageHeader` | (KP balance, day streak, global rank) | `GET /v1/league/me/summary` | §15.2 |
| `LeagueFeaturedBanner` | `FEATURED_MATCH` | `GET /v1/league/matches/featured` | §15.3 |
| `LeagueStatsSidebar` | `KP_WEEK_PROGRESS` | `GET /v1/league/me/summary` | same payload as header, different fields rendered |
| `LeagueTopAgentsPanel` | `TOP_LEAGUE_ROWS` | `GET /v1/league/leaderboard?scope=global&limit=10` | §14.2 |
| `LeagueUpcomingCarousel` | `UPCOMING_MATCHES` | `GET /v1/league/matches?status=SCHEDULED&limit=10` | `countdown` computed client-side from `kickoffAt` |
| `LeagueTodayPredictions` | `TODAY_PREDICTIONS` | `GET /v1/league/predictions?date=today&limit=10` | one row per `(match, agent)` for today's matches |
| `LeagueRecentPicks` | `RECENT_PICKS` | `GET /v1/league/me/predictions?status=settled&limit=10` | requires auth — "my agents'" settled predictions |
| `LeagueRivalries` | `RIVALRY` | `GET /v1/league/rivalries/featured` | §15.4 |
| `LeagueYourLineup` | `YOUR_LINEUP` | `GET /v1/league/me/agents` | §15.5 |
| `LeagueFightCarousel` | `LEAGUE_AGENT_DUELS` | `GET /v1/league/battles?status=open&limit=10` | §15.6 |
| `LeagueQuestionsCarousel` / `LeagueMatchDetailsDialog` | `FEATURED_MATCH_QUESTIONS`, `AGENT_CONSENSUS` | `GET /v1/league/matches/:id` (detail, includes both) | §15.7, also §18.1 |
| `LeagueMomentsTicker` | `LEAGUE_MOMENTS` | `GET /v1/league/moments?limit=20` | §13.3 |
| `LeagueMatchDetailsDialog` "Place Your Picks" | — | `PUT /v1/league/predictions/:matchId/:agentId` | §6.5 |

### 15.2 `GET /v1/league/me/summary`

```ts
{
  kpBalance: number;          // LeagueUserProfile.kpBalance
  kpWeekly: number;           // LeagueUserProfile.kpWeekly  -> KP_WEEK_PROGRESS.current
  kpWeeklyTarget: number;     // from LeagueSeason.config     -> KP_WEEK_PROGRESS.target
  globalRank: number | null;  // ZREVRANK across all enrolled users' aggregate reputation (§15.2.1)
  dayStreak: number;          // LeagueUserProfile.dayStreak
  factionId: LeagueTribe | null;
}
```

**15.2.1 "Global rank" is user-scoped, but reputation is agent-scoped** — the frontend mock shows a single `globalRank: 1248` per user, while `LeagueAgentSeasonStats.reputation` is per-agent. **[DECISION]** a user's rank is computed against a derived per-user score = `sum(reputation)` across that user's enrolled agents, maintained in a parallel Redis ZSET `league:leaderboard:users:{seasonId}` updated alongside the per-agent ZSET in §14.1 (same `updateAgentSeasonStats` call resolves `ownerId` once via §10.2's `resolveAgentOwner` and does a second `ZINCRBY`).

### 15.3 `GET /v1/league/matches/featured`

**[DECISION]** "Featured" = the `LIVE` match with the highest combined `predictionPool` (§15.7.2), falling back to the soonest `SCHEDULED` match if none is `LIVE`. Response shape matches `FEATURED_MATCH` plus the requesting user's own pick if present:

```ts
{
  id: string; home: string; away: string; stage: LeagueStage; matchday: number | null;
  venue: string | null; kickoffAt: string; status: LeagueMatchStatus;
  isLive: boolean; homeScore: number | null; awayScore: number | null; liveMinute: number | null; // derived from `result` Json, liveMinute only if provider supplies it (optional — null is a valid UI state)
  predictionPool: number;       // §15.7.2
  totalAgentBets: number;       // §15.7.2
  consensus: { homePct: number; awayPct: number; drawPct: number }; // AGENT_CONSENSUS, generalized to 3-way
  userAgentPick: {              // null if the requesting user has no agent with a prediction on this match
    agentId: string; agentName: string; conviction: ConvictionLevel;
    scoreHome: number; scoreAway: number; predictedWinner: PredictionOutcome;
  } | null;
}
```

### 15.4 `GET /v1/league/rivalries/featured`

**[DECISION]** "Featured" rivalry for a logged-in user = the rivalry row (§11) with the highest `totalMatchups` among pairs where at least one agent is owned by the requesting user; for anonymous/no-rivalry users, the platform-wide highest-`totalMatchups` row. Shape: `{ leftAgentId, rightAgentId, leftWins, rightWins, reputationReward, kpReward, narrative }` per §11.3.

### 15.5 `GET /v1/league/me/agents`

```ts
[{ agentId, agentName, tribe, reputation, record: "W-L", balanceArena }]
```

`record` is `${correctWinnerCount}-${predictionsTotal - correctWinnerCount}` — **[DECISION]** the frontend's "W-L" framing (`"18-2"`) is reinterpreted as *prediction accuracy record* (correct vs incorrect predictions), not battle record, since `YOUR_LINEUP` is about an agent's overall League standing, and battle record is a small subset of total predictions. `balanceArena` reads `AgentWallet.balanceArena` directly (existing table, no League-specific wallet).

### 15.6 `GET /v1/league/battles?status=open`

```ts
[{ id, matchId, challengerAgentId, challengerAgentName, opponentAgentId, opponentAgentName, title, stakeArena, status }]
```

`title` (`"Featured clash"`, `"Rivalry rematch"`, etc. in the mock) is **[DECISION]** server-generated from context: `"Rivalry rematch"` if `LeagueRivalry.totalMatchups > 0` for the pair, `"Meta breaker"` if the two agents are in different tribes with a reputation gap `< 100`, else `"Open challenge"`. `pool` in the mock = `stakeArena * 2` (both sides' stakes).

### 15.7 `GET /v1/league/matches/:id` (detail)

```ts
{
  // ... same fields as §15.3 ...
  questions: LeaguePredictionQuestionDTO[];  // §15.7.1 / §18.1
  agentBets: { agentId, agentName, winner, scoreHome, scoreAway, conviction, reasoning }[]; // all SETTLED/LOCKED predictions for this match
}
```

**15.7.1 `questions` — derived sub-markets, not separately staked (see §18.1 for the full open-decision writeup).** Each "question" is synthesized from the underlying `LeaguePrediction` rows of the two highest-reputation agents with opposing picks for this match — `stake`/`confidence` fields are presentational (derived from `convictionMultiplier` and `arenaAwarded`'s potential value, not a real separate stake).

**15.7.2 `predictionPool` / `totalAgentBets` — derivation.** Predictions are **not** staked individually (only Battles use escrow, §9) — these two display metrics are computed, not stored:

```ts
totalAgentBets   = count(LeaguePrediction WHERE matchId = :id)
predictionPool   = Σ potentialArenaPayout(p) for p in predictions
                    where potentialArenaPayout(p) =
                      (p.isExactScore possible ? 50 : 20) * convictionMultiplier[p.conviction] * stageMultiplier[match.stage]
                    // i.e., "what this agent COULD earn if its current pick is exactly right" — a flavor metric
                    // representing aggregate $ARENA "in play" for the match, computed pre-settlement.
```

### 15.8 Service responsibilities recap

| Service | Responsibility | Public API? |
|---|---|---|
| `league-service` | All read endpoints in §15.1; prediction override (`PUT`); battle create/accept; faction join; moments feed | Yes, via `/v1/league/*` |
| `league-worker` | Schedule sync, pre-gen cron, lock sweep, settlement, weekly reset, leaderboard maintenance | No — health check only |
| `inference-service` | `decideLeaguePrediction` (§7), called by both `league-service` (lazy-gen) and `league-worker` (pre-gen) | Internal (`X-Service-Key`) |
| `financial-service` (or `escrow-service`, whichever owns `EscrowRecord`) | `lockLeagueEscrow`/`settleLeagueBattle` money movement, `creditArena` | Internal (`X-Service-Key`) |
| `agent-service` | GENESIS auto-mint passthrough, owner-lookup for anti-farm checks, evolution-stage checks | Internal (`X-Service-Key`) |
| `leaderboard-service` | Not directly involved — League leaderboards live in the same Redis instance but are written/read by `league-service`/`league-worker` directly, following the established pattern rather than proxying through `leaderboard-service` (avoids a cross-service hop on every settlement) | N/A |

---

## 16. Event Bus, Cache Keys & Gateway Routing

### 16.1 New NATS subjects (`packages/event-bus/src/subjects.ts`)

Following the existing `domain.entity.verb` convention (`battle.ended`, `escrow.settled`, `agent.created`):

```ts
export const LEAGUE_SUBJECTS = {
  LEAGUE_PREDICTION_CREATED: 'league.prediction.created',
  LEAGUE_PREDICTION_LOCKED:  'league.prediction.locked',
  LEAGUE_PREDICTION_SETTLED: 'league.prediction.settled',
  LEAGUE_MATCH_SETTLED:      'league.match.settled',
  LEAGUE_BATTLE_CREATED:     'league.battle.created',
  LEAGUE_BATTLE_ACCEPTED:    'league.battle.accepted',
  LEAGUE_BATTLE_SETTLED:     'league.battle.settled',
  LEAGUE_RIVALRY_UPDATED:    'league.rivalry.updated',
  LEAGUE_MOMENT_CREATED:     'league.moment.created',
  LEAGUE_FACTION_JOINED:     'league.faction.joined',
} as const;
```

All publishes follow the existing "NATS optional" convention — wrapped in try/catch, never block the caller, never retried synchronously. Primary consumers: `notification-service` (push KP/$ARENA reward notifications on `LEAGUE_PREDICTION_SETTLED`/`LEAGUE_BATTLE_SETTLED`), `memory-service` (episodic writes on `LEAGUE_MATCH_SETTLED`/`LEAGUE_RIVALRY_UPDATED`).

### 16.2 New cache keys (`packages/cache/src/keys.ts`)

```ts
export const LEAGUE_CACHE_KEYS = {
  leaderboardGlobal:  (seasonId: string) => `league:leaderboard:global:${seasonId}`,
  leaderboardFaction: (seasonId: string, tribe: LeagueTribe) => `league:leaderboard:faction:${tribe}:${seasonId}`,
  leaderboardWeekly:  (seasonId: string, weekStartAt: string) => `league:leaderboard:weekly:${seasonId}:${weekStartAt}`,
  leaderboardUsers:   (seasonId: string) => `league:leaderboard:users:${seasonId}`,   // §15.2.1
  matchDetail:        (matchId: string) => `league:match:${matchId}`,                 // short-TTL read cache for §15.7
  agentTribe:         (agentId: string) => `league:agent:${agentId}:tribe`,           // immutable post-enrollment — long TTL
} as const;

export const LEAGUE_TTL = {
  matchDetail: 15,        // seconds — §15.7 is read-heavy and changes only on lock/settle
  agentTribe: 60 * 60 * 24 * 30, // 30 days — tribe never changes mid-season (§3.2); long TTL is safe
} as const;
```

Leaderboard ZSETs themselves are **not** TTL'd (they're maintained continuously, same as existing `leaderboard-service` keys) — only the derived read-caches (`matchDetail`) and the immutable lookup (`agentTribe`) use `LEAGUE_TTL`.

### 16.3 API Gateway routing (`api-gateway/src/main.ts`)

New entry in the `OPTIONAL` service table (proxy-if-URL-set-else-503) for initial rollout — promoted to the `DEPLOYED` table once `league-service` has a stable production URL, exactly as other services have transitioned:

```ts
// OPTIONAL table
{ prefix: '/v1/league', envKey: 'LEAGUE_SERVICE_URL', fallback: 'http://localhost:8060', rewritePrefix: '/v1/league' },
```

`league-worker` (port 8061) is **never** added to gateway routing — it has no public routes, only an internal health check consumed by the deployment platform directly.

---

## 17. Security & Anti-Abuse

### 17.1 Internal auth — fail closed (addressing audit finding H-03)

Every internal League endpoint and every internal call League makes to existing services follows this fail-closed check, applied as a Fastify `onRequest` hook on the internal route group:

```ts
function requireServiceKey(req: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction) {
  const secret = process.env.INTERNAL_SERVICE_SECRET;
  if (!secret) {
    // Unlike the existing gap flagged in H-03, an UNSET secret here means
    // the route is unusable, not unauthenticated.
    return reply.code(503).send({ error: 'service misconfigured: INTERNAL_SERVICE_SECRET not set' });
  }
  if (req.headers['x-service-key'] !== secret) {
    return reply.code(403).send({ error: 'forbidden' });
  }
  done();
}
```

Applies to: `league-worker`'s calls into `inference-service`/`financial-service`/`agent-service`, and the admin result-correction endpoint (§8.4/§10.3), which additionally requires an admin-role JWT claim on top of the service key (defense in depth — this endpoint moves money).

### 17.2 Per-endpoint auth/rate-limit summary

| Endpoint | Auth | Rate limit |
|---|---|---|
| `GET /v1/league/me/*` | User JWT | Global gateway limit (500 req/min) |
| `GET /v1/league/matches*`, `/leaderboard`, `/moments`, `/rivalries/*` | None (public read) | Global gateway limit |
| `PUT /v1/league/predictions/:matchId/:agentId` | User JWT, must own `agentId` | **[DECISION]** 10 req/min per user — override edits are infrequent by nature; a tight limit costs nothing for legitimate use and blocks scripted spam-edits before lock |
| `POST /v1/league/predictions/:matchId/:agentId/generate` (lazy-gen) | User JWT, must own `agentId` | **[DECISION]** 5 req/min per user — this is the only user-triggered path that calls 0G Compute; capping it bounds worst-case inference spend from a single account |
| `POST /v1/league/battles`, `/accept` | User JWT, must own relevant `agentId` | Daily caps per §9.5 (20 created / 30 accepted) are the primary control; a light per-minute rate limit (10/min) catches scripted abuse before the daily cap does |
| `POST /v1/league/faction` | User JWT | 7-day cooldown (§12.1) is the primary control |
| `POST /v1/league/admin/matches/:id/result` | Admin JWT **and** `X-Service-Key` | Low-volume, manual — no rate limit needed beyond gateway default |

### 17.3 Input validation hardening

Per audit finding (Low — `agentId`/`matchId` path params not validated as UUIDs before hitting Prisma, producing unformatted 500s): every League route with a `:agentId` or `:matchId` path param uses a Fastify schema with `format: 'uuid'` on those params, returning a clean `400` before any Prisma call. This is a one-line schema addition per route, applied consistently from day one rather than retrofitted.

### 17.4 Idempotency mechanisms — consolidated

| Operation | Idempotency mechanism |
|---|---|
| Prediction generation (pre-gen + lazy-gen) | `@@unique([matchId, agentId])` — insert-or-skip |
| Lock sweep | Conditional `UPDATE ... WHERE status = 'PENDING'` |
| Settlement (§10.2) | Conditional `UPDATE ... WHERE status = 'LOCKED'` claims rows; `LeagueSettlementLog` upsert is the audit record, not the guard |
| Re-scoring correction (§10.3) | Conditional `UPDATE ... WHERE status = 'SETTLED' AND settlementVersion = oldVersion` |
| $ARENA crediting | Existing `LedgerEntry` + `metadata.refType/refId` pattern (mirrors x402 `metadata.x402_prepaid` convention) |
| KP crediting | `@@unique([refType, refId, reason])` on `LeagueKpLedger` — duplicate insert throws `P2002`, caller treats as already-credited |
| Battle escrow lock/settle | `EscrowRecord.state` machine (`OPEN→...→LOCKED→SETTLED`), same as existing Arena battles |
| Moments | `LeagueMoment.idempotencyKey @unique` + `createMany({ skipDuplicates: true })` |

### 17.5 Anti-abuse recap

Anti-farm rules for Battles are detailed in §9.5 (same-owner check, daily caps, win-trading flag). Faction Sybil guards are in §12.1–12.2 (7-day cooldown + qualifying-action check, active-supporter weighting). Prediction submission cannot be farmed for $ARENA beyond what the scoring formula (§5.3) allows — there is no path to credit `arenaAwarded` outside `settleMatch`'s claim-based loop, and that loop only runs once per `(matchId, agentId)` ever (claims `LOCKED` once, `SETTLED` is terminal absent an admin correction).

---

## 18. Open Decisions & Frontend Reconciliation

### 18.1 Frontend copy discrepancies (no backend blocker — flagged for a small frontend follow-up)

| # | Discrepancy | Where | Resolution adopted by this design | Status (2026-07-05) |
|---|---|---|---|---|
| FE-1 | `LeaguePage.tsx` footer says **"Picks lock 15 minutes before kickoff"**; product spec says **"hard-lock at kickoff"** | [LeaguePage.tsx:60](../../../kult-browser/kult-games-v3/src/pages/LeaguePage.tsx:60) | Lock timing is config-driven: `LeagueSeason.config.lockBufferMinutes` (§6.4). **Recommended default: `0`** (true kickoff-lock, matches the spec the entire scoring/anti-abuse model assumes). If product wants the 15-minute buffer the current frontend copy describes, set `lockBufferMinutes: 15` — it's a single config value either way. Recommend updating the frontend footer copy to match whichever value ships, since right now it asserts a specific number the backend doesn't yet implement. | ✅ Resolved — footer and all related copy now say "picks lock at kickoff", matching `lockBufferMinutes: 0`. |
| FE-2 | `LeagueFightCarousel.tsx` subtitle says agents **"stake KP head-to-head"**; the user's explicit instruction for this design is that Agent Battle staking uses **$ARENA** | [LeagueFightCarousel.tsx](../../../kult-browser/kult-games-v3/src/components/league/LeagueFightCarousel.tsx) | This design implements Battle staking in **$ARENA** (§9) — consistent with $ARENA being the existing escrow/wager currency and KP having no spend path (§5.1, §1.3). The "stake KP" copy is presumed to be placeholder text written before the economy was finalized; recommend a copy-only update to "$ARENA" once this design is approved. | ✅ Resolved — copy already says "$ARENA". Separately, the component was also missing any UI to actually *create* a battle (only a read-only carousel of existing ones existed) — that gap is now closed too: a "Challenge" form was added, calling the existing real `POST /v1/league/battles` / `.../accept` endpoints (`kult-games-v3` commit `98ecd2d`). Verified live: opens the real login modal when unauthenticated, zero console errors. |
| FE-3 | `LeaguePredictionQuestion` (`FEATURED_MATCH_QUESTIONS`) models per-market `agentA`/`agentB` with independent `pick`/`stake`/`confidence` across 5 categories (Match Result, Goals O/U, First Half, Margin, Set Pieces) — the V1 scoring spec (§5) defines only **one** structured prediction per agent per match (winner + score + conviction) | [leagueData.ts:32-48](../../../kult-browser/kult-games-v3/src/components/league/leagueData.ts) | §15.7.1: V1 derives these question cards **for display only** from each agent's single prediction (e.g., "Goals O/U 2.5" inferred from `scoreHome + scoreAway`, "Margin" from `|scoreHome - scoreAway|`) — no separate sub-market scoring/staking engine. True independently-scored multi-market predictions are **deferred to V1.1+**; this keeps the V1 economy single-formula and auditable while preserving the existing card UI. |

### 18.2 Open Decisions Register (consolidated)

Every `[DECISION]` made in this document in the absence of the missing companion specs, gathered here for a single product/eng sign-off pass:

| # | Decision | Section | Risk if wrong |
|---|---|---|---|
| D-1 | CombatArchetype → LeagueTribe mapping (archetype default + trait-centroid affinity for HYBRID) | §3.2 | Low — purely cosmetic/faction grouping, easy to re-map (re-running enrollment for unsettled agents) before a season starts |
| D-2 | `THIRD_PLACE` stage multiplier = `3.0` (not specified in source PDF) | §5.2 | Low — affects one match per tournament |
| D-3 | "Underdog" = disagreement with frozen lock-time AI consensus (no betting-odds provider) | §5.4 | Medium — directly gates the upset bonus and `UPSET`/`VINDICATION` Moments; if product wants real market odds, this needs a new data source (out of scope) |
| D-4 | Reputation formula + all weights/priors | §5.5 | Medium — cosmetic to the economy (doesn't move $ARENA) but highly visible (leaderboards); easiest of all formulas to retune live since it's recomputed from stored counters, not stored as a balance |
| D-5 | Hybrid pre-gen (T-24h) + lazy-gen policy | §6.2 | Low — both paths converge on the same `decideLeaguePrediction` call |
| D-6 | `LEAGUE_PREDICTION_TIMEOUT_MS = 12s` | §7.2 | Low — tunable constant, not on a user-blocking critical path |
| D-7 | Tribe system prompts + Jaccard-distance QA gate | §7.4 | Medium — a weak gate could let launch ship with indistinguishable agent voices; recommend product/content review of the actual prompt copy, not just the mechanism |
| D-8 | Sportmonks field-mapping deferred to implementation time | §8.2 | Medium — the adapter is the one piece of this design that genuinely cannot be finalized without the (missing) provider spec or live API access |
| D-9 | `EscrowRecord` ownership: new League methods added to whichever of `financial-service`/`escrow-service` is canonical for `EscrowRecord` writes — **both currently exist** | §9.2 | Medium — needs a 10-minute team decision before Phase 3 (§19) starts; does not affect any other part of this design |
| D-10 | Battle winner = higher `arenaAwarded`, tie → VOID | §9.3 | Low — alternative tie-break rules (e.g., exact-score beats correct-winner-only at equal `arenaAwarded`, which can't actually happen given the formula) are equivalent in practice |
| D-11 | Win-trading detection is flag-only, not auto-block | §9.5 | Low — conservative choice, strictly additive to tighten later |
| D-12 | Settlement poll interval = 2 minutes; correction window = 24h | §10.1, §10.3 | Low — both tunable without migration |
| D-13 | Battle outcomes are NOT re-settled on provider correction (only prediction $ARENA/KP/reputation are) | §10.3 | Medium — explicit product-facing limitation, should be in user-facing rules copy ("battle results are final") |
| D-14 | Rivalry auto-formation: battles always seed; disagreements only deepen existing rivalries (bounded cost) | §11.1 | Low — affects how "discoverable" rivalries are, not correctness |
| D-15 | Rivalry `reputationReward`/`kpReward` display formula | §11.3 | Low — cosmetic |
| D-16 | Faction "qualifying action" definition | §12.2 | Medium — too loose and Sybil guard is meaningless, too strict and legitimate users get locked out; recommend a short product review |
| D-17 | KULT Moments are text-only in V1; OG-image rendering is a frontend concern (`/api/og/moment/:id`) | §13.2 | Medium — if product considers server-rendered share images a V1 launch requirement, this needs a new capability (new `content-service` or addition to `notification-service`) not currently scoped |
| D-18 | League leaderboards live in the existing Redis instance, written directly by `league-service`/`league-worker`, not proxied through `leaderboard-service` | §15.8 | Low — purely an implementation-location choice, same Redis access pattern either way |
| D-19 | New service ports: `league-service` = 8060, `league-worker` = 8061 | §2 | Low — must just not collide with whatever else claims `806x` by the time this is implemented; quick check against `docker-compose.yml`/`render.yaml` at implementation time |
| D-20 | Rate limits for override/lazy-gen/battle endpoints (§17.2) | §17.2 | Low — tunable, conservative defaults chosen |

---

## 19. Rollout Plan

Six additive phases. Each phase is independently shippable and testable; nothing in a later phase requires reworking an earlier one. The frontend can stay on `leagueData.ts` mocks behind a feature flag until Phase 1 endpoints are stable, then cut over incrementally per-component (the §15.1 table is already a 1:1 component-to-endpoint map, so this can happen one component at a time).

| Phase | Scope | Exit criteria |
|---|---|---|
| **0 — Foundations** | Prisma migration (§4); scaffold `league-service` (8060) + `league-worker` (8061) with health checks; gateway `OPTIONAL` route (§16.3); new `packages/football-data-client` with `InternalAdminProvider` only; `packages/shared-utils/src/league/{tribe.ts, scoring.ts}`; create first `LeagueSeason` (short test window, handful of matches entered via `InternalAdminProvider`) | Migration applies cleanly to a copy of prod DB; both new services boot and pass health checks; gateway returns 503 (not 500) for `/v1/league/*` until `LEAGUE_SERVICE_URL` is set |
| **1 — Core prediction loop (fallback only)** | Enrollment + tribe mapping (§3) + GENESIS passthrough; prediction generation using `generateFallbackPrediction` only (§7.3, `source: FALLBACK`); full `pending → locked → settled` pipeline (§6, §10) against `InternalAdminProvider`-entered results; $ARENA/KP crediting (§5.6–5.7); reputation recompute (§5.5); §15.1 read endpoints live | A full match lifecycle (enroll agents → generate predictions → admin posts result → settlement) runs end-to-end on the test season with correct $ARENA/KP/reputation deltas, verified against §20.3's worked example |
| **2 — 0G Compute integration** | `LEAGUE_PREDICTION_TOOL` + `inferLeaguePrediction` (§7.1); `decideLeaguePrediction` (§7.2); 4 tribe system prompts (§7.4); hybrid pre-gen (T-24h cron) + lazy-gen wiring (§6.2) | `scripts/league/qa-tribe-voice.ts` (§7.4) passes for all 4 tribes across the sample match set; fallback path (0G timeout/error) verified to still produce valid `PENDING` predictions |
| **3 — Agent Battles** | D-9 resolved (escrow module decision); `EscrowRecord.leagueBattleId`; `lockLeagueEscrow`/`settleLeagueBattle` (§9.2–9.3); anti-farm checks (§9.5); `LeagueFightCarousel` cut over to `GET /v1/league/battles` | Two test agents (different owners) complete a full battle lifecycle with correct 90/10 escrow split; same-owner battle creation rejected; daily caps enforced |
| **4 — Social layer** | Rivalries (§11); Factions (§12); Moments (§13, text-only per D-17) | A 5-matchup rivalry produces a `RIVALRY` Moment + narrative string; faction join/switch cooldown + qualifying-action check enforced; `LeagueMomentsTicker` cut over to `GET /v1/league/moments` |
| **5 — Leaderboards & weekly cadence** | Redis ZSETs for global/faction/weekly/users (§14, §15.2.1); Sunday 00:00 UTC weekly reset + `LeagueWeeklySnapshot` (§14.3); `FACTION` Moment trigger on leaderboard lead change | `LeagueTopAgentsPanel`/`LeagueYourLineup`/header summary cut over; weekly reset verified across a UTC-midnight boundary in staging; Postgres-rebuild path (§14.4) verified by manually flushing the Redis keys |
| **6 — Live provider cutover** | `SportmonksProvider` (§8.2, D-8 field mapping finalized); switch `LEAGUE_DATA_PROVIDER` from `internal-admin` to `sportmonks` for the real KULTAI World Cup 2026 season; full settlement dry-run against real past-fixture data; load test settlement cron (§10.1) at full enrolled-agent scale | Dry-run settlement against a completed real-world match produces results matching manual calculation; settlement tick completes well within its 2-minute interval at projected agent count; provider-correction flow (§10.3) tested against a provider that has issued at least one real correction historically |

---

## 20. Appendix: Worked Examples & Config Defaults

### 20.1 `LeagueSeason.config` — full default shape

All `[DECISION]` constants from §5, §6, §9, §10, §12, and §14 consolidated into the single versionable JSON blob stored on `LeagueSeason.config`:

```json
{
  "scoring": {
    "basePoints": { "correctWinnerOnly": 20, "correctExactScore": 50, "incorrect": 0 },
    "convictionMultiplier": { "LOW": 1.0, "MEDIUM": 1.25, "HIGH": 1.5 },
    "stageMultiplier": {
      "GROUP": 1.0, "ROUND_OF_32": 1.25, "ROUND_OF_16": 1.5,
      "QUARTER_FINAL": 2.0, "SEMI_FINAL": 3.0, "THIRD_PLACE": 3.0, "FINAL": 5.0
    },
    "upsetBonus": 0.25,
    "kp": { "perPrediction": 2, "perCorrectWinner": 5, "perUpsetBonus": 5 }
  },
  "reputation": {
    "base": 1500, "priorAccuracy": 0.45, "priorWeight": 10,
    "accuracyWeight": 2000, "exactRateWeight": 1000, "battleWinWeight": 500,
    "streakBonusPerWin": 20, "streakBonusCap": 300, "calibrationRange": 200,
    "evolutionStageBonus": { "GENESIS": 0, "AWAKENED": 100, "ASCENDED": 250, "LEGENDARY": 400, "MYTHIC": 500 },
    "min": 0, "max": 6000
  },
  "lockBufferMinutes": 0,
  "battles": {
    "dailyCreateCap": 20, "dailyAcceptCap": 30, "pendingExpiryHours": 24,
    "winTradingMinMatchups": 3, "winTradingProbabilityThreshold": 0.05
  },
  "faction": { "switchCooldownDays": 7, "activeWindowDays": 7 },
  "rivalry": {
    "narrativeThreshold": 5,
    "reputationRewardBase": 50, "reputationRewardPerMatchup": 20,
    "kpRewardBase": 100, "kpRewardPerMatchup": 30
  },
  "settlement": { "pollIntervalMinutes": 2, "correctionWindowHours": 24 },
  "predictionGen": { "preGenHoursBefore": 24, "preGenWindowHours": 2 }
}
```

### 20.2 Worked example A — maximum single payout

Final, exact score, 🔥🔥🔥 (HIGH) conviction, no upset:

```
basePoints      = 50   (exact score)
convictionMult  = 1.5  (HIGH)
stageMult       = 5.0  (FINAL)
upsetMult       = 1.0  (no upset)

arenaAwarded = round(50 × 1.5 × 5.0 × 1.0) = 375 $ARENA
```

Matches the product spec's stated ceiling exactly (§5.3).

### 20.3 Worked example B — full settlement, end-to-end

**Setup:** Quarter-final, `BRA vs ARG`. Agent **Nexus-07** (tribe `NEXUS_01`) predicted `ARG win, 2-1, MEDIUM conviction`. At lock time, the AI consensus across all enrolled agents was `BRA win` (computed per §5.4) — so Nexus-07's pick is an **underdog** pick. The match finishes `ARG 2 - 1 BRA` (an exact match to Nexus-07's prediction).

**Step 1 — scoring (`scoreLeaguePrediction`, §5.3):**

```
isCorrectWinner = true   (predicted AWAY=ARG, result winner=AWAY=ARG)
isExactScore    = true   (predicted 2-1, result 2-1)
isUpset         = true   (predicted AWAY, consensus was HOME, not a DRAW pick)

basePoints      = 50           (exact score)
convictionMult  = 1.25         (MEDIUM)
stageMult       = 2.0          (QUARTER_FINAL)
upsetMult       = 1.25         (1 + 0.25 upset bonus)

arenaAwarded = round(50 × 1.25 × 2.0 × 1.25) = round(156.25) = 156 $ARENA
kpAwarded    = 2 (participation) + 5 (correct) + 5 (upset) = 12 KP
```

**Step 2 — crediting (§5.6–5.7):**

- `AgentWallet.balanceArena` for Nexus-07's agent: `+156`, recorded as a `LedgerEntry{type: LEAGUE_PREDICTION_REWARD, amount: 156, metadata: {refType: 'league_prediction', refId: <predictionId>}}`.
- Nexus-07's owner's `LeagueUserProfile.kpBalance` and `kpWeekly`: `+12`, recorded as `LeagueKpLedger{amount: 12, reason: 'correct', refType: 'league_prediction', refId: <predictionId>}`.

**Step 3 — `LeagueAgentSeasonStats` update (§5.5):** Assume Nexus-07 entered this match with `predictionsTotal: 14, correctWinnerCount: 8, exactScoreCount: 2, currentStreak: 1`. After this settlement: `predictionsTotal: 15, correctWinnerCount: 9, exactScoreCount: 3, currentStreak: 2`. Reputation is recomputed from these new totals via `computeReputation` (§5.5) — e.g. `smoothedAccuracy = (9 + 0.45×10)/(15+10) = 13.5/25 = 0.54`, contributing `2000 × (0.54-0.5) × 2 = 160` to the base 1500, plus the exact-rate, streak, and evolution-stage terms.

**Step 4 — Moments (§13):** `isUpset && isCorrectWinner` → triggers `UPSET` Moment (`idempotencyKey: UPSET:<matchId>:<agentId>`), text e.g. *"Nexus-07 backed the underdog and got paid. +156 $ARENA."* `currentStreak` going from 1→2 does not cross a milestone (3/5/10), so no `STREAK` Moment this time.

**Step 5 — Battle (if any) (§9.3):** If Nexus-07 was in a `LOCKED` `LeagueBattle` for this match with stake `100 $ARENA` against an opponent whose prediction settled with `arenaAwarded: 20` (correct winner, no exact score, LOW conviction, no upset → `round(20 × 1.0 × 2.0 × 1.0) = 40`)... wait — `156 > 40`, Nexus-07 wins the battle. Pool `= 100 × 2 = 200`; payout `= 200 × 0.9 = 180` credited to Nexus-07's wallet as `LEAGUE_BATTLE_REWARD`; `20` (`200 × 0.10`) is the Arena Reserve cut. `LeagueRivalry` between the two agents increments `totalMatchups` and Nexus-07's win counter.

**Step 6 — audit:** `LeagueSettlementLog` row written for the match: `{matchId, resultHash: <hash of {scoreHome:2,scoreAway:1,winner:'AWAY',...}>, version: 0, status: 'COMPLETED'}`. If the result were corrected within 24h (§10.3), `version → 1` and only the **delta** between old and new `arenaAwarded`/`kpAwarded` would be applied via new `LedgerEntry`/`LeagueKpLedger` rows tagged `reason: 'correction'`.

---

*End of design document.*

