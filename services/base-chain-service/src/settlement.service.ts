/**
 * The money path, relayed.
 *
 * Every function here follows the same shape as job.service.ts's postJob:
 * simulate with a static call first so a revert surfaces as a readable reason
 * instead of a burnt-gas failure, then broadcast.
 *
 * This service holds the RELAYER key. It can drive a job's state but can never
 * choose a payee — the payout destination is fixed on-chain at funding, from a
 * signature both agents produced. `submitVerdict` is gated on VERIFIER_ROLE,
 * which by deployment policy is a DIFFERENT key: one side drives state, the
 * other judges outcomes (threat T3).
 */

import { ethers } from 'ethers';
import { basescanTx } from './config';
import { jobEscrowRead, jobEscrowWrite } from './job.service';
import { revertReason } from './contracts';
import { sendAttributed } from './attribution';

export interface AgreementInput {
  jobId: string;
  creatorAgentId: string;
  providerAgentId: string;
  providerWallet: string;
  agreedPrice: string;
  requirementsHash: string;
  executionWindow: number;
  transcriptHash: string;
  expiry: number;
}

export interface ReceiveAuthorizationInput {
  from: string;
  to: string;
  value: string;
  validAfter: number | string;
  validBefore: number | string;
  nonce: string;
  v: number;
  r: string;
  s: string;
}

/** Field order must match the Solidity struct exactly — ethers encodes positionally. */
function toAgreementTuple(a: AgreementInput) {
  return {
    jobId: a.jobId,
    creatorAgentId: BigInt(a.creatorAgentId),
    providerAgentId: BigInt(a.providerAgentId),
    providerWallet: ethers.getAddress(a.providerWallet),
    agreedPrice: BigInt(a.agreedPrice),
    requirementsHash: a.requirementsHash,
    executionWindow: a.executionWindow,
    transcriptHash: a.transcriptHash,
    expiry: a.expiry,
  };
}

function toAuthTuple(auth: ReceiveAuthorizationInput) {
  return {
    from: ethers.getAddress(auth.from),
    to: ethers.getAddress(auth.to),
    value: BigInt(auth.value),
    validAfter: BigInt(auth.validAfter),
    validBefore: BigInt(auth.validBefore),
    nonce: auth.nonce,
    v: auth.v,
    r: auth.r,
    s: auth.s,
  };
}

/**
 * Fund escrow: commit the agreement and pull the creator's USDC atomically.
 *
 * Signatures are checked on-chain, but `verifyAgreement` is called first as a
 * view so a bad signature returns a clear error rather than an opaque revert.
 */
export async function fundJob(params: {
  jobId: string;
  agreement: AgreementInput;
  creatorSigner: string;
  creatorSignature: string;
  providerSigner: string;
  providerSignature: string;
  authorization: ReceiveAuthorizationInput;
}): Promise<{ txHash: string; blockNumber: number; explorer: string; alreadyFunded: boolean }> {
  const read = jobEscrowRead();

  // JobStatus: 0 NONE, 1 POSTED, 2 ESCROWED, 3 EXECUTING, 4 DELIVERED,
  // 5 SETTLED, 6 REFUNDED, 7 CANCELLED, 8 DISPUTED.
  const status = Number(await read.jobStatus(params.jobId));

  if (status === 0) {
    throw new Error(`Job ${params.jobId} is not registered on-chain — post it before funding`);
  }
  if (status === 7) {
    throw new Error(`Job ${params.jobId} was cancelled and cannot be funded`);
  }
  if (status !== 1) {
    // Anything past POSTED means the money already moved. A retry after a
    // dropped receipt must report success, not double-fund.
    return { txHash: '', blockNumber: 0, explorer: '', alreadyFunded: true };
  }

  const agreement = toAgreementTuple(params.agreement);

  const signaturesValid = await read.verifyAgreement(
    agreement,
    ethers.getAddress(params.creatorSigner),
    params.creatorSignature,
    ethers.getAddress(params.providerSigner),
    params.providerSignature,
  );
  if (!signaturesValid) {
    throw new Error(
      'Agreement signatures do not verify on-chain. The terms submitted differ from the terms signed.',
    );
  }

  const write = jobEscrowWrite();
  const args = [
    params.jobId,
    agreement,
    ethers.getAddress(params.creatorSigner),
    params.creatorSignature,
    ethers.getAddress(params.providerSigner),
    params.providerSignature,
    toAuthTuple(params.authorization),
  ] as const;

  const sent = await sendAttributed(write, 'fundWithAuthorization', args, revertReason);

  return {
    txHash: sent.txHash,
    blockNumber: sent.blockNumber,
    explorer: basescanTx(sent.txHash),
    alreadyFunded: false,
  };
}

/** Mark work started. Informational, but it timestamps the beginning. */
export async function markExecuting(jobId: string) {
  return relay('markExecuting', [jobId]);
}

/** Commit the deliverable hash. Must land before the execution deadline. */
export async function submitDeliverable(jobId: string, deliverableHash: string) {
  return relay('submitDeliverable', [jobId, deliverableHash]);
}

/**
 * The verifier's verdict — pays the provider or refunds the creator.
 *
 * Requires VERIFIER_ROLE. If this service's relayer key does not hold that
 * role (the correct production posture), the call reverts and the error says
 * so plainly rather than looking like a contract bug.
 */
export async function submitVerdict(jobId: string, accepted: boolean, reportHash: string) {
  return relay('submitVerdict', [jobId, accepted, reportHash]);
}

/**
 * Trigger a timeout refund.
 *
 * Permissionless on-chain — exposed here only as a convenience so the platform
 * can sweep stuck jobs. The funds can only ever reach the creator, so there is
 * no privilege being exercised.
 */
export async function claimTimeoutRefund(jobId: string) {
  return relay('claimTimeoutRefund', [jobId]);
}

/** Arbiter splits a disputed escrow. Sum must equal the escrowed amount. */
export async function resolveDispute(jobId: string, toProviderBaseUnits: string, toCreatorBaseUnits: string) {
  return relay('resolveDispute', [jobId, BigInt(toProviderBaseUnits), BigInt(toCreatorBaseUnits)]);
}

async function relay(method: string, args: readonly unknown[]) {
  const sent = await sendAttributed(jobEscrowWrite(), method, args, revertReason);
  return {
    txHash: sent.txHash,
    blockNumber: sent.blockNumber,
    explorer: basescanTx(sent.txHash),
  };
}

/** Whether a timeout refund is currently claimable. Straight from the chain. */
export async function refundClaimable(jobId: string): Promise<boolean> {
  return jobEscrowRead().refundClaimable(jobId);
}
