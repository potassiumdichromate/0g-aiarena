/**
 * Retry wrapper for flaky RPC endpoints.
 *
 * Base's public endpoint (mainnet.base.org) rate-limits aggressively and drops
 * TLS connections mid-request. That is survivable for reads, but a write that
 * dies after broadcast is genuinely dangerous — you cannot tell whether the
 * transaction landed.
 *
 * So the two cases are treated differently:
 *
 *   withRetry      — for reads. Retries freely; a read has no side effects.
 *   sendWithRetry  — for writes. Retries ONLY while the failure provably
 *                    happened before broadcast (nonce unchanged). Once the
 *                    nonce has moved, the transaction exists and retrying
 *                    would send a second one.
 */

import { ethers } from 'hardhat';

const TRANSIENT = [
  'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT',
  'SERVER_ERROR', 'TIMEOUT', 'NETWORK_ERROR',
  'over rate limit', 'rate limit', 'too many requests', '429', '503', '502',
];

export function isTransient(err: unknown): boolean {
  const e = err as { code?: string; message?: string; shortMessage?: string };
  const haystack = `${e.code ?? ''} ${e.message ?? ''} ${e.shortMessage ?? ''}`.toLowerCase();
  return TRANSIENT.some((needle) => haystack.includes(needle.toLowerCase()));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retry a read with exponential backoff. Safe: reads have no side effects. */
export async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  attempts = 6,
): Promise<T> {
  let lastError: unknown;

  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isTransient(err)) throw err;

      const delay = Math.min(1000 * 2 ** i, 15_000);
      process.stdout.write(`\n    ${label}: ${(err as Error).message?.slice(0, 60)} — retrying in ${delay / 1000}s `);
      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * Send a transaction, retrying only when it provably never left.
 *
 * The nonce is captured first. If a send fails and the nonce has NOT advanced,
 * nothing was broadcast and a retry is safe. If it HAS advanced, the
 * transaction is out there and we stop and say so rather than risk a duplicate.
 */
export async function sendWithRetry(
  label: string,
  signerAddress: string,
  send: () => Promise<{ hash: string; wait: () => Promise<unknown> }>,
  attempts = 4,
): Promise<string> {
  for (let i = 0; i < attempts; i += 1) {
    const nonceBefore = await withRetry(
      `${label} nonce`,
      () => ethers.provider.getTransactionCount(signerAddress, 'latest'),
    );

    try {
      const tx = await send();
      await tx.wait();
      return tx.hash;
    } catch (err) {
      if (!isTransient(err)) throw err;

      const nonceAfter = await withRetry(
        `${label} nonce recheck`,
        () => ethers.provider.getTransactionCount(signerAddress, 'latest'),
      );

      if (nonceAfter > nonceBefore) {
        throw new Error(
          `${label}: connection dropped, but the nonce advanced ${nonceBefore} -> ${nonceAfter}, ` +
            'so the transaction WAS broadcast. Not retrying — re-run this script and it will ' +
            'skip whatever already succeeded.',
        );
      }

      const delay = Math.min(2000 * 2 ** i, 15_000);
      process.stdout.write(`\n    ${label}: not broadcast (nonce still ${nonceBefore}) — retrying in ${delay / 1000}s `);
      await sleep(delay);
    }
  }

  throw new Error(`${label}: gave up after ${attempts} attempts`);
}
