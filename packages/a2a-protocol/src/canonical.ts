/**
 * Canonical serialization and hashing for A2A job requirements.
 *
 * The hash produced here is committed to Base mainnet at job creation and is
 * what makes the off-chain requirement document verifiable: anyone can fetch
 * the stored JSON, re-run `canonicalize`, hash it, and compare against the
 * chain. If serialization is not byte-stable, that check fails and the whole
 * "verifiable off-chain data" claim collapses.
 *
 * Four rules, each of which has a test:
 *
 *   1. Object keys are sorted. JS preserves insertion order for string keys,
 *      but relying on that means any code edit that reorders a literal
 *      silently changes the hash.
 *   2. Arrays keep their order. They are ordered data, not sets.
 *   3. No floating point anywhere. `0.1 + 0.2` and locale/precision
 *      differences make floats a reproducibility hazard, so USDC amounts are
 *      integer strings in 6-decimal base units and predicate values are
 *      integers. A non-integer number throws rather than silently rounding.
 *   4. `undefined` keys are omitted, `null` is preserved. Otherwise
 *      `{a: undefined}` and `{}` would hash differently despite being the
 *      same document.
 */

import { keccak256, toUtf8Bytes } from 'ethers';

/** Bumped if the canonical shape ever changes; old jobs must stay verifiable. */
export const CANONICAL_SCHEMA_VERSION = 'a2a-req-v1';

export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

/**
 * Recursively sort object keys and reject anything that cannot hash stably.
 *
 * `path` is threaded through purely so an error names the offending field —
 * debugging "Invalid number" in a nested requirement document is otherwise
 * miserable.
 */
export function canonicalize(value: unknown, path = '$'): CanonicalValue {
  if (value === null) return null;

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`${path}: ${value} is not finite and cannot be canonicalized`);
    }
    if (!Number.isInteger(value)) {
      throw new Error(
        `${path}: ${value} is not an integer. Floats are not permitted in canonical ` +
          'documents — use integer base units (USDC has 6 decimals) or an integer-valued string.',
      );
    }
    return value;
  }

  if (typeof value === 'string' || typeof value === 'boolean') return value;

  if (Array.isArray(value)) {
    return value.map((entry, index) => canonicalize(entry, `${path}[${index}]`));
  }

  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const result: Record<string, CanonicalValue> = {};
    for (const key of Object.keys(source).sort()) {
      // Omit undefined so an explicitly-absent optional field and a missing one
      // produce the same document.
      if (source[key] === undefined) continue;
      result[key] = canonicalize(source[key], `${path}.${key}`);
    }
    return result;
  }

  throw new Error(`${path}: values of type ${typeof value} cannot be canonicalized`);
}

/** Canonical JSON bytes. No whitespace — every byte is significant. */
export function canonicalBytes(value: unknown): Uint8Array {
  return toUtf8Bytes(JSON.stringify(canonicalize(value)));
}

export function canonicalString(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/**
 * keccak256 of the canonical bytes, as a 0x-prefixed 32-byte hex string.
 *
 * keccak256 rather than sha256 because this value is stored and compared
 * on-chain, where keccak256 is the native primitive.
 */
export function canonicalHash(value: unknown): string {
  return keccak256(canonicalBytes(value));
}

// ── USDC amounts ────────────────────────────────────────────────────────────

export const USDC_DECIMALS = 6;

/**
 * Parse a human USDC amount ("0.25") into integer base units ("250000").
 *
 * Deliberately string-based rather than `Math.round(x * 1e6)`: the float path
 * turns 0.29 into 289999.99999999994, and a budget that is one base unit off
 * is a budget that fails an on-chain bounds check for no visible reason.
 */
export function parseUsdc(amount: string | number): bigint {
  const text = String(amount).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new Error(`"${amount}" is not a valid non-negative USDC amount`);
  }

  const [whole, fraction = ''] = text.split('.');
  if (fraction.length > USDC_DECIMALS) {
    throw new Error(
      `"${amount}" has ${fraction.length} decimal places; USDC supports at most ${USDC_DECIMALS}`,
    );
  }

  return BigInt(whole + fraction.padEnd(USDC_DECIMALS, '0'));
}

/** Format integer base units back to a human string ("250000" -> "0.25"). */
export function formatUsdc(baseUnits: bigint | string): string {
  const units = BigInt(baseUnits);
  const divisor = 10n ** BigInt(USDC_DECIMALS);
  const whole = units / divisor;
  const fraction = (units % divisor).toString().padStart(USDC_DECIMALS, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
