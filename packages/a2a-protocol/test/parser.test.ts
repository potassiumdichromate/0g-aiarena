/**
 * Parser tests.
 *
 * The prompt from the product spec is the primary case and is asserted
 * verbatim. The rest cover the distinction that actually matters: separating
 * "what I want achieved" from "who is allowed to do it", when both clauses
 * mention the same metric.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIRMATION_THRESHOLD, extractDeterministic, mergeExtractions } from '../src/parser.js';

const SPEC_PROMPT =
  'I want my agent to train for Warzone Warrior and I want at least 70 combat skills. ' +
  'The agent I want this job for should have minimum combat skills of 90 and have over 100+ wins in Warzone.';

test('SPEC: parses the product-specification prompt correctly', () => {
  const result = extractDeterministic(SPEC_PROMPT);

  assert.equal(result.gameId, 'warzone');
  assert.deepEqual(result.target, { metric: 'combatSkill', op: 'gte', value: 70 });

  const byMetric = Object.fromEntries(result.providerRequirements.map((p) => [p.metric, p.value]));
  assert.equal(byMetric.combatSkill, 90, 'trainer must need combat skill 90');
  assert.equal(byMetric.wins, 100, 'trainer must need 100 wins');

  assert.ok(result.confidence >= CONFIRMATION_THRESHOLD, `confidence was ${result.confidence}`);
});

test('SPEC: the shorter phrasing from the brief also parses', () => {
  const result = extractDeterministic(
    'I want my agent to train for Warzone Warrior and I want at least 70 combat skills. ' +
      'The trainer should have at least 90 combat skill and 100+ Warzone wins.',
  );

  assert.equal(result.gameId, 'warzone');
  assert.deepEqual(result.target, { metric: 'combatSkill', op: 'gte', value: 70 });

  const byMetric = Object.fromEntries(result.providerRequirements.map((p) => [p.metric, p.value]));
  assert.equal(byMetric.combatSkill, 90);
  assert.equal(byMetric.wins, 100);
});

// ── Target vs provider separation ───────────────────────────────────────────

test('the same metric on both sides is not confused', () => {
  // Both clauses say "combat skill"; only the trainer clause separates them.
  const result = extractDeterministic(
    'I want at least 60 combat skill. The trainer should have at least 95 combat skill.',
  );
  assert.equal(result.target?.value, 60);
  assert.equal(result.providerRequirements[0]?.value, 95);
});

test('with no provider clause, later constraints are flagged not silently dropped', () => {
  const result = extractDeterministic('I want at least 70 combat skill and 50 precision.');
  assert.equal(result.target?.metric, 'combatSkill');
  assert.ok(result.warnings.some((w) => /provider requirements|confirm/i.test(w)));
});

// ── Phrasing variants ───────────────────────────────────────────────────────

const VARIANTS: Array<[string, number]> = [
  ['train my agent to at least 70 combat skill in warzone', 70],
  ['warzone: I need combat skill of at least 75', 75],
  ['get my warzone agent to 80+ combat skill', 80],
  ['minimum 65 combat skill for warzone please', 65],
  ['warzone agent needs combat skill above 55', 55],
  ['I want combat skill 72 in warzone', 72],
];

for (const [prompt, expected] of VARIANTS) {
  test(`variant: "${prompt.slice(0, 44)}..." → ${expected}`, () => {
    const result = extractDeterministic(prompt);
    assert.equal(result.target?.metric, 'combatSkill');
    assert.equal(result.target?.value, expected);
  });
}

test('metric aliases resolve to canonical names', () => {
  assert.equal(extractDeterministic('warzone, accuracy of at least 60').target?.metric, 'precision');
  assert.equal(extractDeterministic('warzone, elo of at least 1400').target?.metric, 'eloRating');
  assert.equal(extractDeterministic('warzone, at least 30 victories').target?.metric, 'wins');
});

test('longest alias wins so "combat skill" beats "combat"', () => {
  assert.equal(extractDeterministic('warzone, at least 70 combat skill').target?.metric, 'combatSkill');
});

// ── Refusals and warnings ───────────────────────────────────────────────────

test('unrecognised game is flagged rather than defaulted', () => {
  // Defaulting the game would silently post a job for the wrong one.
  const result = extractDeterministic('I want at least 70 combat skill');
  assert.equal(result.gameId, null);
  assert.ok(result.warnings.some((w) => /game/i.test(w)));
  assert.ok(result.confidence < CONFIRMATION_THRESHOLD);
});

test('a prompt with no constraint yields no target and low confidence', () => {
  const result = extractDeterministic('please make my warzone agent better somehow');
  assert.equal(result.target, null);
  assert.ok(result.confidence < CONFIRMATION_THRESHOLD);
  assert.ok(result.warnings.some((w) => /completion condition/i.test(w)));
});

test('unmeasurable traits are rejected with an explanation', () => {
  const result = extractDeterministic('warzone: I want at least 80 loyalty');
  assert.equal(result.target, null);
  assert.ok(result.warnings.some((w) => /loyalty/.test(w) && /cannot be measured/.test(w)));
});

// ── LLM merge ───────────────────────────────────────────────────────────────

test('merge drops an LLM value that is not in the prompt', () => {
  // The single most dangerous failure: a hallucinated threshold becoming an
  // on-chain commitment.
  const prompt = 'warzone, I want at least 70 combat skill';
  const merged = mergeExtractions(
    prompt,
    { gameId: 'warzone', target: { metric: 'combatSkill', op: 'gte', value: 95 }, providerRequirements: [] },
    extractDeterministic(prompt),
  );

  assert.equal(merged.target?.value, 70, 'must fall back to the grounded value');
  assert.ok(merged.warnings.some((w) => /does not appear in the prompt/.test(w)));
});

test('merge keeps an LLM reading that IS grounded', () => {
  const prompt = 'warzone, my agent should reach 70 combat skill; trainer needs 90 combat skill';
  const merged = mergeExtractions(
    prompt,
    {
      gameId: 'warzone',
      target: { metric: 'combatSkill', op: 'gte', value: 70 },
      providerRequirements: [{ metric: 'combatSkill', op: 'gte', value: 90 }],
    },
    extractDeterministic(prompt),
  );

  assert.equal(merged.target?.value, 70);
  assert.equal(merged.providerRequirements[0]?.value, 90);
  assert.equal(merged.method, 'llm+deterministic');
});

test('merge flags a disagreement instead of silently choosing', () => {
  const prompt = 'warzone, at least 70 combat skill and at least 40 precision';
  const merged = mergeExtractions(
    prompt,
    { gameId: 'warzone', target: { metric: 'precision', op: 'gte', value: 40 }, providerRequirements: [] },
    extractDeterministic(prompt),
  );
  assert.ok(merged.warnings.some((w) => /Interpretations differ/.test(w)));
});

test('merge refuses an unmeasurable metric from the LLM', () => {
  const prompt = 'warzone, at least 70 loyalty';
  const merged = mergeExtractions(
    prompt,
    { gameId: 'warzone', target: { metric: 'loyalty', op: 'gte', value: 70 }, providerRequirements: [] },
    extractDeterministic(prompt),
  );
  assert.equal(merged.target, null);
});
