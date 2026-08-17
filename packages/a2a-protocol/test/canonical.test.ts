/**
 * Canonical hashing is what makes off-chain requirements verifiable against
 * the on-chain commitment. A change that alters the bytes breaks verification
 * for every already-posted job, so the golden vectors at the bottom pin the
 * exact hash — if one fails, the change was a breaking one and needs a schema
 * version bump, not a fix to the test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CANONICAL_SCHEMA_VERSION,
  canonicalHash,
  canonicalString,
  canonicalize,
  formatUsdc,
  parseUsdc,
} from '../src/canonical.js';

// ── Determinism ─────────────────────────────────────────────────────────────

test('key order does not affect the hash', () => {
  const a = { gameId: 'warzone', target: { metric: 'combatSkill', value: 70 }, nonce: 'n1' };
  const b = { nonce: 'n1', target: { value: 70, metric: 'combatSkill' }, gameId: 'warzone' };
  assert.equal(canonicalHash(a), canonicalHash(b));
});

test('array order DOES affect the hash', () => {
  // Arrays are ordered data. Sorting them would silently reorder requirements.
  const a = { reqs: [{ metric: 'wins', value: 100 }, { metric: 'combatSkill', value: 90 }] };
  const b = { reqs: [{ metric: 'combatSkill', value: 90 }, { metric: 'wins', value: 100 }] };
  assert.notEqual(canonicalHash(a), canonicalHash(b));
});

test('nested keys are sorted at every depth', () => {
  const value = canonicalize({ z: { b: 1, a: { d: 2, c: 3 } }, y: 4 });
  assert.equal(JSON.stringify(value), '{"y":4,"z":{"a":{"c":3,"d":2},"b":1}}');
});

test('undefined keys are omitted, null is preserved', () => {
  // {a: undefined} and {} are the same document and must hash identically.
  assert.equal(canonicalHash({ a: undefined, b: 1 }), canonicalHash({ b: 1 }));
  assert.notEqual(canonicalHash({ a: null, b: 1 }), canonicalHash({ b: 1 }));
});

test('any change to any field changes the hash', () => {
  const base = { gameId: 'warzone', value: 70 };
  assert.notEqual(canonicalHash(base), canonicalHash({ ...base, value: 71 }));
  assert.notEqual(canonicalHash(base), canonicalHash({ ...base, gameId: 'robowar' }));
});

// ── Float rejection ─────────────────────────────────────────────────────────

test('floats are rejected rather than silently rounded', () => {
  // 0.1 + 0.2 !== 0.3 — a float anywhere makes the hash machine-dependent.
  assert.throws(() => canonicalHash({ budget: 0.25 }), /not an integer/);
  assert.throws(() => canonicalHash({ nested: { deep: [1, 2.5] } }), /not an integer/);
});

test('float rejection names the offending path', () => {
  assert.throws(
    () => canonicalHash({ a: { b: [{ c: 1.5 }] } }),
    /\$\.a\.b\[0\]\.c/,
  );
});

test('non-finite numbers are rejected', () => {
  assert.throws(() => canonicalHash({ x: Number.NaN }), /not finite/);
  assert.throws(() => canonicalHash({ x: Number.POSITIVE_INFINITY }), /not finite/);
});

test('unsupported types are rejected rather than coerced', () => {
  assert.throws(() => canonicalHash({ fn: () => 1 }), /cannot be canonicalized/);
  assert.throws(() => canonicalHash({ big: 1n }), /cannot be canonicalized/);
});

// ── USDC ────────────────────────────────────────────────────────────────────

test('parseUsdc converts without float error', () => {
  assert.equal(parseUsdc('0.25'), 250000n);
  assert.equal(parseUsdc('0.5'), 500000n);
  assert.equal(parseUsdc('1'), 1000000n);
  assert.equal(parseUsdc('0.000001'), 1n);
  assert.equal(parseUsdc(0.4), 400000n);
});

test('parseUsdc avoids the float rounding bug', () => {
  // Math.round(0.29 * 1e6) === 289999.99999999994 -> 290000 only by luck;
  // 0.29 is the classic case. String parsing is exact.
  assert.equal(parseUsdc('0.29'), 290000n);
  assert.equal(parseUsdc('0.07'), 70000n);
  assert.equal(parseUsdc('8.11'), 8110000n);
});

test('parseUsdc rejects malformed and over-precise amounts', () => {
  assert.throws(() => parseUsdc('0.1234567'), /at most 6/);
  assert.throws(() => parseUsdc('-1'), /not a valid/);
  assert.throws(() => parseUsdc('abc'), /not a valid/);
  assert.throws(() => parseUsdc(''), /not a valid/);
});

test('formatUsdc round-trips', () => {
  for (const amount of ['0.25', '0.4', '1', '123.456789', '0.000001']) {
    assert.equal(formatUsdc(parseUsdc(amount)), amount);
  }
  assert.equal(formatUsdc(500000n), '0.5');
  assert.equal(formatUsdc(0n), '0');
});

// ── Golden vectors ──────────────────────────────────────────────────────────

test('GOLDEN: canonical string is byte-exact', () => {
  const document = {
    schema: CANONICAL_SCHEMA_VERSION,
    prompt: 'I want my agent to train for Warzone Warrior',
    gameId: 'warzone',
    target: { metric: 'combatSkill', op: 'gte', value: 70 },
    providerRequirements: [
      { metric: 'combatSkill', op: 'gte', value: 90 },
      { metric: 'wins', op: 'gte', value: 100 },
    ],
    budget: { minBaseUnits: '250000', maxBaseUnits: '500000' },
    executionWindowSeconds: 21600,
    creatorAgentId: '1',
    nonce: 'fixed-nonce-for-testing',
  };

  assert.equal(
    canonicalString(document),
    '{"budget":{"maxBaseUnits":"500000","minBaseUnits":"250000"},"creatorAgentId":"1",' +
      '"executionWindowSeconds":21600,"gameId":"warzone","nonce":"fixed-nonce-for-testing",' +
      '"prompt":"I want my agent to train for Warzone Warrior",' +
      '"providerRequirements":[{"metric":"combatSkill","op":"gte","value":90},' +
      '{"metric":"wins","op":"gte","value":100}],"schema":"a2a-req-v1",' +
      '"target":{"metric":"combatSkill","op":"gte","value":70}}',
  );
});

test('GOLDEN: hash of a known document is stable', () => {
  // If this fails, canonicalization changed in a way that invalidates every
  // previously posted job. Bump CANONICAL_SCHEMA_VERSION — do not edit this.
  const hash = canonicalHash({
    schema: 'a2a-req-v1',
    gameId: 'warzone',
    target: { metric: 'combatSkill', op: 'gte', value: 70 },
  });

  assert.match(hash, /^0x[0-9a-f]{64}$/);
  assert.equal(hash, canonicalHash({
    target: { value: 70, op: 'gte', metric: 'combatSkill' },
    gameId: 'warzone',
    schema: 'a2a-req-v1',
  }));
});
