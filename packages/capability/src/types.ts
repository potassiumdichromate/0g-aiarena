/**
 * Capability profiles and job requirement predicates.
 *
 * A CapabilityProfile is the answer to "what can this agent actually do", and
 * it is the thing job requirements are evaluated against. Two rules shape it:
 *
 *   1. Everything is DERIVED from stored evidence — seeded evaluations and real
 *      battle rows. Nothing here is ever set by hand or supplied by the agent.
 *   2. Every metric carries provenance. A number a counterparty cannot trace
 *      back to its evidence is not a capability claim, it is a rumour.
 */

/** Where a metric's value came from. */
export type CapabilitySource =
  /** A seeded evaluation of a policy checkpoint — the strongest evidence. */
  | 'evaluation'
  /** Counted from real Battle rows, excluding simulator-generated ones. */
  | 'battle_history'
  /** Agent.traits, evolved from Unity match telemetry via evolve-traits. */
  | 'telemetry_traits'
  /** Agent.eloRating. */
  | 'elo';

export interface CapabilityMetric {
  value: number;
  source: CapabilitySource;
  /**
   * How much weight a counterparty should put on this. Evaluation-backed
   * metrics are authoritative; telemetry-derived ones are indicative only.
   * Matching can require a minimum confidence so a job that needs proven
   * ability is not satisfied by an inferred number.
   */
  confidence: 'measured' | 'indicative';
  /** Formula version for evaluation-backed metrics, e.g. "cap-v1". */
  formulaVersion?: string;
  /** Evaluation protocol version, e.g. "eval-v2". */
  protocolVersion?: string;
  /** When the underlying evidence was produced. */
  observedAt: string;
}

export interface CapabilityProvenance {
  /** AgentCapabilitySnapshot.id backing the evaluation metrics, if any. */
  snapshotId?: string;
  /** sha256 of the checkpoint that was evaluated. */
  checkpointDigest?: string;
  /** sha256 of the evaluation report. */
  reportDigest?: string;
  /** How many real (non-simulated) battles fed the history counters. */
  battlesConsidered: number;
  /** Battles excluded because they were simulator-generated. */
  simulatedBattlesExcluded: number;
}

export interface CapabilityProfile {
  agentId: string;
  gameId: string;
  computedAt: string;

  /**
   * Metrics keyed by canonical name. Namespaced by domain so a job predicate
   * is unambiguous:
   *   combatSkill, precision, aggression, ...   evaluation or telemetry
   *   wins, losses, winRate                     per-game battle history
   *   eloRating                                 platform-wide
   */
  metrics: Record<string, CapabilityMetric>;

  provenance: CapabilityProvenance;
}

// ── Requirement predicates ──────────────────────────────────────────────────

export type PredicateOperator = 'gte' | 'gt' | 'lte' | 'lt' | 'eq';

export interface CapabilityPredicate {
  /** Canonical metric name — must exist in CapabilityProfile.metrics. */
  metric: string;
  op: PredicateOperator;
  value: number;
  /**
   * Reject a candidate whose metric is merely indicative when the job needs
   * proven ability. Defaults to false so ordinary jobs stay easy to satisfy.
   */
  requireMeasured?: boolean;
}

/**
 * What a job asks for. Produced by the Phase 4 natural-language parser; defined
 * here because matching is what gives the shape meaning.
 */
export interface JobRequirements {
  gameId: string;
  /** What the finished work must achieve, e.g. combatSkill >= 70. */
  target: CapabilityPredicate;
  /** Who is allowed to take the job, e.g. combatSkill >= 90 AND wins >= 100. */
  providerRequirements: CapabilityPredicate[];
}

// ── Match results ───────────────────────────────────────────────────────────

export interface PredicateEvaluation {
  predicate: CapabilityPredicate;
  satisfied: boolean;
  /** null when the profile has no such metric at all. */
  actualValue: number | null;
  /** Human-readable reason, always populated on failure. */
  reason: string;
}

export interface MatchResult {
  agentId: string;
  eligible: boolean;
  evaluations: PredicateEvaluation[];
  /**
   * How far clear of the requirements the candidate is, averaged over
   * satisfied numeric predicates. Used only for ranking — never for
   * eligibility, which is strictly pass/fail.
   */
  margin: number;
  failureSummary: string | null;
}
