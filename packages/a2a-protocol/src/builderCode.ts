/**
 * ERC-8021 attribution suffix (Base Builder Codes).
 *
 * A byte sequence appended to the END of transaction calldata that identifies
 * the app which originated the transaction. Contracts ignore trailing data
 * beyond their declared arguments, so this needs no contract changes and
 * cannot affect execution. Offchain indexers read it after the fact.
 *
 * Layout, built backwards from the end of calldata:
 *
 *   [ codes (utf-8, comma-joined) ][ length: 1 byte ][ schemaId: 1 byte ][ marker: 16 bytes ]
 *
 * Marker is 0x8021 repeated eight times.
 *
 * --- On the byte ordering, and why it is this way round ---
 *
 * Base's published material is inconsistent here. The blog post's construction
 * formula puts the length AFTER the codes:
 *
 *   schemaData = codes.join(",") + codesLength   -> 0x6261736561707007  ("baseapp", 7)
 *
 * while an example string in the docs shows the length first
 * (0x0762617365617070). Both decode cleanly under their own reading, so the
 * example alone cannot settle it.
 *
 * The tie-breaker is the documented parsing algorithm: a reader verifies the
 * last 16 bytes are the marker, reads the schema byte, then extracts the
 * codes — working backwards from the end. A backwards reader must know the
 * length BEFORE it can locate where the codes begin, so the length has to sit
 * adjacent to the schema id. Length-first would force a parser to scan, which
 * is not a format anyone designs deliberately.
 *
 * We therefore implement the blog's ordering, and `ERC8021_REFERENCE_VECTOR`
 * pins the exact documented example so a future correction is a one-line
 * change with a failing test to prove it.
 *
 * --- Risk if this is wrong ---
 *
 * None to the transaction. A malformed suffix is still ignored by the
 * contract; the only consequence is that attribution silently does not
 * register. No funds at risk, no reverts. That is why shipping this ahead of a
 * spec confirmation is acceptable, and why it must be validated against Base's
 * checker before anyone relies on the attribution numbers.
 */

import { getBytes, hexlify, toUtf8Bytes, toUtf8String } from 'ethers';

/** 0x8021 repeated eight times — 16 bytes marking the end of ERC-8021 data. */
export const ERC8021_MARKER = '0x80218021802180218021802180218021';

/** Schema 0: comma-joined utf-8 codes with a single-byte length. */
export const ERC8021_SCHEMA_BASIC = 0x00;

/** Base's documented example, kept as a regression pin. */
export const ERC8021_REFERENCE_VECTOR = {
  codes: ['baseapp'],
  suffix: '0x62617365617070070080218021802180218021802180218021',
} as const;

const MARKER_BYTES = 16;
const MAX_CODES_BYTES = 255; // single-byte length

/**
 * Build the suffix for one or more builder codes.
 *
 * Returns '0x' for an empty list so callers can append unconditionally without
 * branching — an unconfigured builder code must never alter calldata.
 */
export function encodeBuilderCodeSuffix(codes: string[]): string {
  const present = codes.map((c) => c.trim()).filter(Boolean);
  if (present.length === 0) return '0x';

  for (const code of present) {
    if (code.includes(',')) {
      // The separator is a comma, so a code containing one would silently
      // split into two on the indexer's side.
      throw new Error(`Builder code "${code}" contains a comma, which is the code separator`);
    }
  }

  const codesBytes = toUtf8Bytes(present.join(','));
  if (codesBytes.length > MAX_CODES_BYTES) {
    throw new Error(`Builder codes encode to ${codesBytes.length} bytes; the length field allows at most ${MAX_CODES_BYTES}`);
  }

  return hexlify(
    new Uint8Array([
      ...codesBytes,
      codesBytes.length,
      ERC8021_SCHEMA_BASIC,
      ...getBytes(ERC8021_MARKER),
    ]),
  );
}

/**
 * Read an attribution suffix back out of calldata.
 *
 * Returns null when there is no well-formed suffix — this is the common case
 * for ordinary transactions, not an error.
 */
export function decodeBuilderCodeSuffix(calldata: string): { codes: string[]; schemaId: number } | null {
  let bytes: Uint8Array;
  try {
    bytes = getBytes(calldata);
  } catch {
    return null;
  }

  // marker + schemaId + length, at minimum.
  if (bytes.length < MARKER_BYTES + 2) return null;

  const marker = hexlify(bytes.slice(bytes.length - MARKER_BYTES));
  if (marker.toLowerCase() !== ERC8021_MARKER.toLowerCase()) return null;

  const schemaId = bytes[bytes.length - MARKER_BYTES - 1];
  const codesLength = bytes[bytes.length - MARKER_BYTES - 2];

  const codesEnd = bytes.length - MARKER_BYTES - 2;
  const codesStart = codesEnd - codesLength;
  // A length that runs past the front of the calldata means this is trailing
  // data that happens to end in the marker, not a real suffix.
  if (codesStart < 0) return null;

  try {
    const codes = toUtf8String(bytes.slice(codesStart, codesEnd)).split(',').filter(Boolean);
    return { codes, schemaId };
  } catch {
    return null;
  }
}

/**
 * Append a suffix to encoded calldata.
 *
 * A no-op when the suffix is empty, so an unconfigured builder code leaves the
 * transaction byte-identical to what it would otherwise have been.
 */
export function appendDataSuffix(calldata: string, suffix: string): string {
  if (!suffix || suffix === '0x') return calldata;
  return calldata + suffix.replace(/^0x/, '');
}

/**
 * Resolve the configured suffix from the environment.
 *
 * Cached because it is consulted on every transaction, and computed lazily so
 * a missing BASE_BUILDER_CODE is simply "no attribution" rather than a
 * start-up failure.
 */
let cachedSuffix: string | null = null;

export function configuredBuilderCodeSuffix(): string {
  if (cachedSuffix !== null) return cachedSuffix;

  const code = process.env.BASE_BUILDER_CODE?.trim();
  if (!code) {
    cachedSuffix = '0x';
    return cachedSuffix;
  }

  try {
    cachedSuffix = encodeBuilderCodeSuffix([code]);
  } catch (err) {
    // Never let a bad code break transaction submission — attribution is a
    // nice-to-have, settlement is not.
    console.warn(`[erc-8021] BASE_BUILDER_CODE is unusable, continuing without attribution: ${(err as Error).message}`);
    cachedSuffix = '0x';
  }

  return cachedSuffix;
}

/** Test seam. */
export function resetBuilderCodeCache(): void {
  cachedSuffix = null;
}
