/**
 * ERC-8021 attribution on outgoing transactions.
 *
 * viem exposes a `dataSuffix` option; ethers does not, so a call has to be
 * populated, extended, and sent manually. `sendAttributed` does that in one
 * place so every transaction path gets attribution the same way rather than
 * each remembering to append bytes.
 *
 * Design rules, both of which matter more than the attribution itself:
 *
 *   1. **Never break a transaction to add a tag.** If the builder code is
 *      unset or malformed, the suffix is '0x' and the calldata is
 *      byte-identical to an unattributed call. Settlement must not depend on
 *      a marketing feature.
 *   2. **Simulate without the suffix.** A static call is there to surface a
 *      revert reason; keeping it identical to the plain call means a failure
 *      can never be blamed on the extra bytes.
 */

import { ethers } from 'ethers';
import { appendDataSuffix, configuredBuilderCodeSuffix } from '@ai-arena/a2a-protocol';

export interface AttributedTxResult {
  txHash: string;
  blockNumber: number;
  /** True when a builder code was configured and actually appended. */
  attributed: boolean;
}

/**
 * Simulate, then send a contract call with the ERC-8021 suffix appended.
 *
 * `revertReasonOf` is injected so this module does not depend on the caller's
 * error-formatting helper.
 */
export async function sendAttributed(
  contract: ethers.Contract,
  method: string,
  args: readonly unknown[],
  revertReasonOf: (err: unknown) => string,
): Promise<AttributedTxResult> {
  // Simulate the plain call — no suffix, so a revert is unambiguously the
  // contract's own logic.
  try {
    await contract[method].staticCall(...args);
  } catch (err) {
    throw new Error(`${method} would revert: ${revertReasonOf(err)}`);
  }

  const runner = contract.runner as ethers.Signer | null;
  if (!runner || !runner.sendTransaction) {
    throw new Error(`${method}: contract has no signer attached`);
  }

  const suffix = configuredBuilderCodeSuffix();

  // No builder code: take the ordinary path. Fewer moving parts when the
  // feature is off.
  if (suffix === '0x') {
    const tx = await contract[method](...args);
    const receipt = await tx.wait();
    return { txHash: tx.hash, blockNumber: Number(receipt.blockNumber), attributed: false };
  }

  const populated = await contract[method].populateTransaction(...args);
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

/** Whether a builder code is configured. Surfaced on /health. */
export function attributionStatus(): { enabled: boolean; code: string | null; suffixBytes: number } {
  const suffix = configuredBuilderCodeSuffix();
  return {
    enabled: suffix !== '0x',
    code: process.env.BASE_BUILDER_CODE?.trim() || null,
    suffixBytes: suffix === '0x' ? 0 : (suffix.length - 2) / 2,
  };
}
