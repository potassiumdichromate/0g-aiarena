/**
 * Sending Base transactions with ERC-8021 attribution.
 *
 * Lives here rather than in one service because more than one service submits
 * Base transactions: base-chain-service holds the relayer and the agent keys,
 * evaluation-service holds the verifier key. Attribution that covers only one
 * of them leaves the other invisible in base.dev, and attribution cannot be
 * applied retroactively.
 *
 * viem has a `dataSuffix` option; ethers does not, so a call has to be
 * populated, extended, and sent by hand. Two rules hold throughout:
 *
 *   1. **Never break a transaction to add a tag.** With no builder code
 *      configured the suffix is '0x' and the calldata is byte-identical to an
 *      untagged call. Settlement does not depend on a marketing feature.
 *   2. **Simulate without the suffix.** A static call exists to surface a
 *      revert reason; keeping it identical to the plain call means a failure
 *      can never be blamed on the extra bytes.
 */

import type { Contract, Signer } from 'ethers';
import { appendDataSuffix, configuredBuilderCodeSuffix } from './builderCode';

export interface AttributedTxResult {
  txHash: string;
  blockNumber: number;
  /** True when a builder code was configured and actually appended. */
  attributed: boolean;
}

/**
 * Simulate, then send a contract call with the ERC-8021 suffix appended.
 *
 * `revertReasonOf` is injected so this module does not depend on any one
 * service's error formatting. `simulate: false` skips the static call for
 * methods where a dry run is misleading — an ERC-8004 `register` simulated
 * twice, for instance, reports a duplicate that the real call would not hit.
 */
export async function sendAttributed(
  contract: Contract,
  method: string,
  args: readonly unknown[],
  options: {
    revertReasonOf?: (err: unknown) => string;
    simulate?: boolean;
  } = {},
): Promise<AttributedTxResult> {
  const { revertReasonOf = defaultRevertReason, simulate = true } = options;

  if (simulate) {
    try {
      await (contract as never as Record<string, { staticCall: (...a: unknown[]) => Promise<unknown> }>)
        [method].staticCall(...args);
    } catch (err) {
      throw new Error(`${method} would revert: ${revertReasonOf(err)}`);
    }
  }

  const runner = contract.runner as Signer | null;
  if (!runner?.sendTransaction) {
    throw new Error(`${method}: contract has no signer attached`);
  }

  const suffix = configuredBuilderCodeSuffix();

  // No builder code: take the ordinary path, fewer moving parts.
  if (suffix === '0x') {
    const tx = await (contract as never as Record<string, (...a: unknown[]) => Promise<{ hash: string; wait: () => Promise<{ blockNumber: number }> }>>)[method](...args);
    const receipt = await tx.wait();
    return { txHash: tx.hash, blockNumber: Number(receipt.blockNumber), attributed: false };
  }

  const populated = await (contract as never as Record<string, { populateTransaction: (...a: unknown[]) => Promise<{ to?: string; data?: string }> }>)
    [method].populateTransaction(...args);

  const tx = await runner.sendTransaction({
    ...populated,
    data: appendDataSuffix(populated.data ?? '0x', suffix),
  });
  const receipt = await tx.wait();

  return {
    txHash: tx.hash,
    blockNumber: Number(receipt!.blockNumber),
    attributed: true,
  };
}

/**
 * Attach the suffix to an already-populated transaction.
 *
 * For calls that cannot go through `sendAttributed` because they need the
 * receipt parsed for a return value, or use an overload signature ethers
 * cannot resolve by name.
 */
export function withAttribution<T extends { data?: string }>(populated: T): T {
  const suffix = configuredBuilderCodeSuffix();
  if (suffix === '0x') return populated;
  return { ...populated, data: appendDataSuffix(populated.data ?? '0x', suffix) };
}

function defaultRevertReason(err: unknown): string {
  const e = err as { shortMessage?: string; reason?: string; message?: string };
  return e.shortMessage ?? e.reason ?? e.message ?? 'unknown error';
}

/** Whether a builder code is configured. Surfaced on health endpoints. */
export function attributionStatus(): { enabled: boolean; code: string | null; suffixBytes: number } {
  const suffix = configuredBuilderCodeSuffix();
  return {
    enabled: suffix !== '0x',
    code: process.env.BASE_BUILDER_CODE?.trim() || null,
    suffixBytes: suffix === '0x' ? 0 : (suffix.length - 2) / 2,
  };
}
