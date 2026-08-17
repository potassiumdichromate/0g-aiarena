/**
 * Matching decides who may take a paid job, so these tests are about the
 * decision boundary, not about happy paths.
 *
 * The Definition of Done scenario is encoded verbatim at the bottom: a job
 * requiring combat skill >= 90 and 100+ Warzone wins must accept an agent at
 * 94/187 and reject one at 80.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluatePredicate,
  matchAgent,
  matchAgentToJob,
  rankCandidates,
  targetIsMeaningful,
  describePredicate,
} from '../src/matching.js';
import type { CapabilityMetric, CapabilityProfile, JobRequirements } from '../src/types.js';

const OBSERVED = '2026-08-16T00:00:00.000Z';

function measured(value: number): CapabilityMetric {
  return { value, source: 'evaluation', confidence: 'measured', observedAt: OBSERVED };
}

function indicative(value: number): CapabilityMetric {
  return { value, source: 'telemetry_traits', confidence: 'indicative', observedAt: OBSERVED };
}

function profile(
  agentId: string,
  metrics: Record<string, CapabilityMetric>,
  gameId = 'warzone',
): CapabilityProfile {
  return {
    agentId,
    gameId,
    computedAt: OBSERVED,
    metrics,
    provenance: { battlesConsidered: 0, simulatedBattlesExcluded: 0 },
  };
}

// ── Operators ───────────────────────────────────────────────────────────────

test('operators compare correctly at the boundary', () => {
  const p = profile('a', { combatSkill: measured(90) });

  assert.equal(evaluatePredicate(p, { metric: 'combatSkill', op: 'gte', value: 90 }).satisfied, true);
  assert.equal(evaluatePredicate(p, { metric: 'combatSkill', op: 'gt', value: 90 }).satisfied, false);
  assert.equal(evaluatePredicate(p, { metric: 'combatSkill', op: 'lte', value: 90 }).satisfied, true);
  assert.equal(evaluatePredicate(p, { metric: 'combatSkill', op: 'lt', value: 90 }).satisfied, false);
  assert.equal(evaluatePredicate(p, { metric: 'combatSkill', op: 'eq', value: 90 }).satisfied, true);
});

// ── Missing evidence ────────────────────────────────────────────────────────

test('a missing metric FAILS rather than passing by default', () => {
  // Treating unknown as satisfied would let an agent take work it has never
  // been measured on.
  const result = evaluatePredicate(profile('a', {}), {
    metric: 'combatSkill', op: 'gte', value: 50,
  });

  assert.equal(result.satisfied, false);
  assert.equal(result.actualValue, null);
  assert.match(result.reason, /never been measured/);
});

test('requireMeasured rejects an indicative metric even when the value passes', () => {
  const p = profile('a', { combatSkill: indicative(95) });

  assert.equal(
    evaluatePredicate(p, { metric: 'combatSkill', op: 'gte', value: 90 }).satisfied,
    true,
    'without requireMeasured, an indicative value is acceptable',
  );
  const strict = evaluatePredicate(p, { metric: 'combatSkill', op: 'gte', value: 90, requireMeasured: true });
  assert.equal(strict.satisfied, false);
  assert.match(strict.reason, /requires a measured evaluation/);
});

// ── Conjunction ─────────────────────────────────────────────────────────────

test('every predicate must hold — three of four is not eligible', () => {
  const p = profile('a', {
    combatSkill: measured(95), wins: measured(150), eloRating: indicative(1400), precision: measured(40),
  });

  const result = matchAgent(p, [
    { metric: 'combatSkill', op: 'gte', value: 90 },
    { metric: 'wins', op: 'gte', value: 100 },
    { metric: 'eloRating', op: 'gte', value: 1200 },
    { metric: 'precision', op: 'gte', value: 60 },
  ]);

  assert.equal(result.eligible, false);
  assert.match(result.failureSummary ?? '', /precision/);
});

test('an empty requirement list matches anyone', () => {
  assert.equal(matchAgent(profile('a', {}), []).eligible, true);
});

// ── Game scoping ────────────────────────────────────────────────────────────

test('a profile from another game cannot satisfy the job', () => {
  // "100 wins" means wins in THIS game — otherwise a Robowar veteran qualifies
  // for a Warzone job.
  const robowar = profile('a', { combatSkill: measured(99), wins: measured(500) }, 'robowar');
  const job: JobRequirements = {
    gameId: 'warzone',
    target: { metric: 'combatSkill', op: 'gte', value: 70 },
    providerRequirements: [{ metric: 'combatSkill', op: 'gte', value: 90 }],
  };

  const result = matchAgentToJob(robowar, job);
  assert.equal(result.eligible, false);
  assert.match(result.failureSummary ?? '', /robowar.*warzone/);
});

// ── Ranking ─────────────────────────────────────────────────────────────────

test('ranking drops ineligible candidates entirely', () => {
  const job: JobRequirements = {
    gameId: 'warzone',
    target: { metric: 'combatSkill', op: 'gte', value: 70 },
    providerRequirements: [{ metric: 'combatSkill', op: 'gte', value: 90 }],
  };

  const ranked = rankCandidates(
    [
      profile('strong', { combatSkill: measured(98) }),
      profile('weak', { combatSkill: measured(80) }),
      profile('ok', { combatSkill: measured(91) }),
    ],
    job,
  );

  // Dropped, not sorted last — reading past the eligible set must be impossible.
  assert.deepEqual(ranked.map((r) => r.agentId), ['strong', 'ok']);
});

test('margin normalizes across metric scales', () => {
  // combatSkill is 0-100, wins is unbounded; neither should dominate ranking.
  const result = matchAgent(profile('a', { combatSkill: measured(95), wins: measured(200) }), [
    { metric: 'combatSkill', op: 'gte', value: 90 },
    { metric: 'wins', op: 'gte', value: 100 },
  ]);

  // (95-90)/90 = 0.0556 and (200-100)/100 = 1.0 → mean ~0.528
  assert.ok(result.margin > 0.5 && result.margin < 0.56, `margin was ${result.margin}`);
});

test('margin never rescues an ineligible candidate', () => {
  const result = matchAgent(profile('a', { combatSkill: measured(89), wins: measured(100000) }), [
    { metric: 'combatSkill', op: 'gte', value: 90 },
    { metric: 'wins', op: 'gte', value: 100 },
  ]);
  assert.equal(result.eligible, false);
});

// ── Target sanity ───────────────────────────────────────────────────────────

test('a target the agent already meets is not meaningful work', () => {
  // Otherwise a provider collects for delivering nothing.
  const check = targetIsMeaningful(profile('a', { combatSkill: measured(85) }), {
    gameId: 'warzone',
    target: { metric: 'combatSkill', op: 'gte', value: 70 },
    providerRequirements: [],
  });

  assert.equal(check.meaningful, false);
  assert.equal(check.currentValue, 85);
  assert.match(check.reason, /nothing to deliver/);
});

test('a target above the agent is meaningful', () => {
  const check = targetIsMeaningful(profile('a', { combatSkill: measured(52) }), {
    gameId: 'warzone',
    target: { metric: 'combatSkill', op: 'gte', value: 70 },
    providerRequirements: [],
  });
  assert.equal(check.meaningful, true);
  assert.equal(check.currentValue, 52);
});

test('an unmeasured agent can always be improved', () => {
  const check = targetIsMeaningful(profile('a', {}), {
    gameId: 'warzone',
    target: { metric: 'combatSkill', op: 'gte', value: 70 },
    providerRequirements: [],
  });
  assert.equal(check.meaningful, true);
  assert.equal(check.currentValue, null);
});

test('describePredicate is readable', () => {
  assert.equal(describePredicate({ metric: 'combatSkill', op: 'gte', value: 90 }), 'combatSkill >= 90');
});

// ── The Definition of Done scenario ─────────────────────────────────────────

test('Warzone scenario: agent 94/187 qualifies, agent 80 does not', () => {
  const job: JobRequirements = {
    gameId: 'warzone',
    target: { metric: 'combatSkill', op: 'gte', value: 70 },
    providerRequirements: [
      { metric: 'combatSkill', op: 'gte', value: 90 },
      { metric: 'wins', op: 'gte', value: 100 },
    ],
  };

  const agentB = profile('agent-b', { combatSkill: measured(94), wins: measured(187) });
  const underskilled = profile('under-skill', { combatSkill: measured(80), wins: measured(187) });
  const underexperienced = profile('under-wins', { combatSkill: measured(94), wins: measured(42) });

  assert.equal(matchAgentToJob(agentB, job).eligible, true);

  const skillFail = matchAgentToJob(underskilled, job);
  assert.equal(skillFail.eligible, false);
  assert.match(skillFail.failureSummary ?? '', /combatSkill >= 90 not met — actual 80/);

  const winsFail = matchAgentToJob(underexperienced, job);
  assert.equal(winsFail.eligible, false);
  assert.match(winsFail.failureSummary ?? '', /wins >= 100 not met — actual 42/);
});
