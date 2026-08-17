/**
 * Predicate evaluation and candidate matching.
 *
 * Pure functions over a CapabilityProfile — no database, no clock, no network.
 * That matters because this is the code that decides who may take a paid job:
 * it has to be trivially testable and produce the same verdict for the same
 * inputs every time, on the server and in a dispute review alike.
 *
 * Eligibility is strictly pass/fail. `margin` exists only to rank candidates
 * that already qualify; it can never rescue one that does not.
 */

import type {
  CapabilityMetric,
  CapabilityPredicate,
  CapabilityProfile,
  JobRequirements,
  MatchResult,
  PredicateEvaluation,
  PredicateOperator,
} from './types';

const OPERATOR_LABELS: Record<PredicateOperator, string> = {
  gte: '>=',
  gt: '>',
  lte: '<=',
  lt: '<',
  eq: '==',
};

function compare(actual: number, op: PredicateOperator, expected: number): boolean {
  switch (op) {
    case 'gte': return actual >= expected;
    case 'gt':  return actual >  expected;
    case 'lte': return actual <= expected;
    case 'lt':  return actual <  expected;
    case 'eq':  return actual === expected;
    default: {
      // Exhaustiveness guard: a new operator must be handled here rather than
      // silently defaulting to "satisfied".
      const unreachable: never = op;
      throw new Error(`Unhandled predicate operator: ${String(unreachable)}`);
    }
  }
}

export function describePredicate(predicate: CapabilityPredicate): string {
  return `${predicate.metric} ${OPERATOR_LABELS[predicate.op]} ${predicate.value}`;
}

/** Evaluate one predicate against a profile. */
export function evaluatePredicate(
  profile: CapabilityProfile,
  predicate: CapabilityPredicate,
): PredicateEvaluation {
  const metric: CapabilityMetric | undefined = profile.metrics[predicate.metric];

  // A missing metric FAILS. Treating "unknown" as "satisfied" would let an
  // agent qualify for work it has no evidence of being able to do — and the
  // absence is often meaningful (no evaluation has ever been run on it).
  if (!metric) {
    return {
      predicate,
      satisfied: false,
      actualValue: null,
      reason: `no evidence for "${predicate.metric}" — agent has never been measured on it`,
    };
  }

  if (predicate.requireMeasured && metric.confidence !== 'measured') {
    return {
      predicate,
      satisfied: false,
      actualValue: metric.value,
      reason:
        `"${predicate.metric}" is ${metric.confidence} (from ${metric.source}), ` +
        'but this job requires a measured evaluation',
    };
  }

  const satisfied = compare(metric.value, predicate.op, predicate.value);
  return {
    predicate,
    satisfied,
    actualValue: metric.value,
    reason: satisfied
      ? `${describePredicate(predicate)} — actual ${metric.value}`
      : `${describePredicate(predicate)} not met — actual ${metric.value}`,
  };
}

/**
 * Relative headroom above a satisfied threshold, used for ranking only.
 *
 * Normalized by the threshold so metrics on wildly different scales (combat
 * skill 0-100 vs. win counts in the hundreds) contribute comparably.
 */
function predicateMargin(evaluation: PredicateEvaluation): number | null {
  const { predicate, actualValue, satisfied } = evaluation;
  if (!satisfied || actualValue === null) return null;

  const threshold = predicate.value;
  if (threshold === 0) return actualValue > 0 ? 1 : 0;

  const raw =
    predicate.op === 'lte' || predicate.op === 'lt'
      ? (threshold - actualValue) / Math.abs(threshold)
      : (actualValue - threshold) / Math.abs(threshold);

  return Math.max(0, raw);
}

/** Evaluate a full requirement set against one candidate. */
export function matchAgent(
  profile: CapabilityProfile,
  predicates: CapabilityPredicate[],
): MatchResult {
  const evaluations = predicates.map((p) => evaluatePredicate(profile, p));
  const failures = evaluations.filter((e) => !e.satisfied);

  const margins = evaluations
    .map(predicateMargin)
    .filter((m): m is number => m !== null);

  return {
    agentId: profile.agentId,
    // Every predicate must hold. An agent that meets three of four requirements
    // is not eligible — the job author wrote all four.
    eligible: failures.length === 0,
    evaluations,
    margin: margins.length ? margins.reduce((a, b) => a + b, 0) / margins.length : 0,
    failureSummary: failures.length ? failures.map((f) => f.reason).join('; ') : null,
  };
}

/** Convenience wrapper for a whole JobRequirements. */
export function matchAgentToJob(profile: CapabilityProfile, requirements: JobRequirements): MatchResult {
  // A profile computed for a different game cannot satisfy this job: "100 wins"
  // means wins in THIS game, and silently comparing across games would let a
  // Robowar veteran qualify for a Warzone job.
  if (profile.gameId !== requirements.gameId) {
    return {
      agentId: profile.agentId,
      eligible: false,
      evaluations: [],
      margin: 0,
      failureSummary:
        `profile is for game "${profile.gameId}" but the job is for "${requirements.gameId}"`,
    };
  }

  return matchAgent(profile, requirements.providerRequirements);
}

/**
 * Rank eligible candidates best-first.
 *
 * Ineligible candidates are dropped rather than sorted to the bottom, so a
 * caller cannot accidentally offer a job to an unqualified agent by reading
 * past the end of the eligible set.
 */
export function rankCandidates(
  profiles: CapabilityProfile[],
  requirements: JobRequirements,
): MatchResult[] {
  return profiles
    .map((profile) => matchAgentToJob(profile, requirements))
    .filter((result) => result.eligible)
    .sort((a, b) => b.margin - a.margin);
}

/**
 * Would this job's target be a real improvement for the agent, or is it
 * already met?
 *
 * Guards against a job that asks for combat skill >= 70 from an agent already
 * at 85, which would let a provider collect for delivering nothing.
 */
export function targetIsMeaningful(
  profile: CapabilityProfile,
  requirements: JobRequirements,
): { meaningful: boolean; reason: string; currentValue: number | null } {
  const evaluation = evaluatePredicate(profile, requirements.target);

  if (evaluation.actualValue === null) {
    return {
      meaningful: true,
      reason: 'agent has no measurement for this metric yet — any result is an improvement',
      currentValue: null,
    };
  }

  if (evaluation.satisfied) {
    return {
      meaningful: false,
      reason:
        `agent already satisfies ${describePredicate(requirements.target)} ` +
        `(currently ${evaluation.actualValue}) — nothing to deliver`,
      currentValue: evaluation.actualValue,
    };
  }

  return {
    meaningful: true,
    reason: `agent is at ${evaluation.actualValue}, target is ${describePredicate(requirements.target)}`,
    currentValue: evaluation.actualValue,
  };
}
