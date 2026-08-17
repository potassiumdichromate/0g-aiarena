/**
 * A2AJobEscrow relaying.
 *
 * base-chain-service holds the only Base signer, so every on-chain job
 * transition goes through here. The marketplace service owns job *meaning*
 * (prose, parsing, matching); this owns only the chain interaction.
 *
 * Phase 4 implements posting. Funding, delivery and settlement land in Phase 6
 * alongside their fork tests — the contract already declares them, but there
 * is no relayer path until those tests exist, deliberately: a settlement
 * function that has never been exercised against real USDC should not be
 * reachable from an HTTP route.
 */

import { ethers } from 'ethers';
import A2AJobEscrowAbi from './abi/A2AJobEscrow.json';
import { getProvider, getRelayerSigner, revertReason } from './contracts';
import { sendAttributed } from './attribution';
import { requireEnv, basescanTx } from './config';

export function jobEscrowAddress(): string {
  return requireEnv('A2A_JOB_ESCROW_ADDRESS');
}

export function jobEscrowRead(): ethers.Contract {
  return new ethers.Contract(jobEscrowAddress(), A2AJobEscrowAbi, getProvider());
}

export function jobEscrowWrite(): ethers.Contract {
  return new ethers.Contract(jobEscrowAddress(), A2AJobEscrowAbi, getRelayerSigner());
}

export const JOB_STATUS_NAMES = [
  'NONE', 'POSTED', 'ESCROWED', 'EXECUTING', 'DELIVERED',
  'SETTLED', 'REFUNDED', 'CANCELLED', 'DISPUTED',
] as const;

export interface PostJobParams {
  jobId: string;
  creatorAgentId: string;   // ERC-8004 tokenId
  creatorWallet: string;
  requirementsHash: string;
  budgetMinBaseUnits: string;
  budgetMaxBaseUnits: string;
  executionWindowSeconds: number;
}

export interface PostJobResult {
  jobId: string;
  txHash: string;
  blockNumber: number;
  explorer: string;
  alreadyOnChain: boolean;
}

/**
 * Register a job on Base.
 *
 * Idempotent by construction: `jobId` is derived from the creator, the
 * requirements hash and a nonce, so a retry hits the same id. Rather than
 * letting the "job exists" revert surface as a failure, an existing record is
 * treated as success — a network blip between broadcast and receipt must not
 * strand a job the chain already knows about (T7).
 */
export async function postJob(params: PostJobParams): Promise<PostJobResult> {
  const read = jobEscrowRead();

  if (await read.exists(params.jobId)) {
    return {
      jobId: params.jobId,
      txHash: '',
      blockNumber: 0,
      explorer: '',
      alreadyOnChain: true,
    };
  }

  // Simulate first. postJob reverts on several validation failures (bad
  // budget bounds, bad window, zero hash) and a static call surfaces the
  // reason without spending gas.
  const write = jobEscrowWrite();
  const args = [
    params.jobId,
    BigInt(params.creatorAgentId),
    ethers.getAddress(params.creatorWallet),
    params.requirementsHash,
    BigInt(params.budgetMinBaseUnits),
    BigInt(params.budgetMaxBaseUnits),
    params.executionWindowSeconds,
  ] as const;

  const sent = await sendAttributed(write, 'postJob', args, revertReason);

  return {
    jobId: params.jobId,
    txHash: sent.txHash,
    blockNumber: sent.blockNumber,
    explorer: basescanTx(sent.txHash),
    alreadyOnChain: false,
  };
}

/**
 * Read a job straight from Base.
 *
 * Deliberately returns the chain's view without consulting Postgres — this is
 * what an independent verifier would see, and it is how the UI proves the
 * off-chain record matches.
 */
export async function readJob(jobId: string): Promise<{
  exists: boolean;
  status: string;
  creatorAgentId: string;
  providerAgentId: string;
  creatorWallet: string;
  providerWallet: string;
  requirementsHash: string;
  agreementHash: string;
  deliverableHash: string;
  budgetMinBaseUnits: string;
  budgetMaxBaseUnits: string;
  agreedPriceBaseUnits: string;
  createdAt: number;
  executionDeadline: number;
  refundClaimable: boolean;
  contract: string;
}> {
  const read = jobEscrowRead();
  const [job, refundClaimable] = await Promise.all([
    read.getJob(jobId),
    read.refundClaimable(jobId),
  ]);

  const statusIndex = Number(job.status);

  return {
    exists: statusIndex !== 0,
    status: JOB_STATUS_NAMES[statusIndex] ?? `UNKNOWN(${statusIndex})`,
    creatorAgentId: job.creatorAgentId.toString(),
    providerAgentId: job.providerAgentId.toString(),
    creatorWallet: job.creatorWallet,
    providerWallet: job.providerWallet,
    requirementsHash: job.requirementsHash,
    agreementHash: job.agreementHash,
    deliverableHash: job.deliverableHash,
    budgetMinBaseUnits: job.budgetMin.toString(),
    budgetMaxBaseUnits: job.budgetMax.toString(),
    agreedPriceBaseUnits: job.agreedPrice.toString(),
    createdAt: Number(job.createdAt),
    executionDeadline: Number(job.executionDeadline),
    refundClaimable,
    contract: jobEscrowAddress(),
  };
}

/** Withdraw a job that was never funded. */
export async function cancelJob(jobId: string): Promise<{ txHash: string; explorer: string }> {
  const write = jobEscrowWrite();
  try {
    await write.cancelBeforeFunding.staticCall(jobId);
  } catch (err) {
    throw new Error(`cancelBeforeFunding would revert: ${revertReason(err)}`);
  }

  const tx = await write.cancelBeforeFunding(jobId);
  await tx.wait();
  return { txHash: tx.hash, explorer: basescanTx(tx.hash) };
}
