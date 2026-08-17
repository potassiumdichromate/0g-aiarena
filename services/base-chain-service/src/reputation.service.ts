/**
 * Reputation — ERC-8004 feedback on Base.
 *
 * The canonical ReputationRegistry (0x8004BAa1…) is reused, not forked. Its
 * model is that `msg.sender` IS the client giving feedback, which has one
 * consequence worth stating plainly:
 *
 *   **The creator agent must submit its own feedback, and therefore needs a
 *   small ETH balance on Base.**
 *
 * Relaying every agent's feedback from one platform key would make
 * `clientAddress` the same address on every record. `getSummary` filtered by
 * client would then collapse to a single reviewer, and the distinct-counterparty
 * property that makes reputation resistant to self-dealing (T13/T14) would be
 * gone. Cheap-looking shortcut, worthless output.
 *
 * Escrow funding still needs no ETH from either agent — that goes through
 * EIP-3009. This is the one action where an agent pays its own gas, and the
 * amount is a few cents per settled job.
 *
 * Scoring: value = 100 when the job met its target, 0 when it did not, with
 * valueDecimals = 0. That choice makes `getSummary`'s average literally the
 * agent's completion rate, readable by anyone on-chain with no knowledge of
 * KULT. Richer detail lives in the feedbackURI document, committed by
 * feedbackHash.
 */

import { ethers } from 'ethers';
import { prisma } from '@ai-arena/db-client';

import ReputationRegistryAbi from './abi/ReputationRegistry.json';
import { getProvider } from './contracts';
import { decryptAgentKey } from './crypto';
import { requireEnv, basescanTx } from './config';
import { sendAttributed } from '@ai-arena/a2a-protocol';

/** Tag namespace so KULT feedback is distinguishable from other clients'. */
export const FEEDBACK_TAG_OUTCOME = 'kult.job.outcome';

/** Minimum ETH an agent needs before it can author feedback. */
const MIN_GAS_WEI = ethers.parseEther('0.00002');

export function reputationRegistryAddress(): string {
  return requireEnv('ERC8004_REPUTATION_REGISTRY_ADDRESS');
}

function reputationRead(): ethers.Contract {
  return new ethers.Contract(reputationRegistryAddress(), ReputationRegistryAbi, getProvider());
}

function reputationAsAgent(eoaKeyEnc: string): ethers.Contract {
  const signer = new ethers.Wallet(decryptAgentKey(eoaKeyEnc), getProvider());
  return new ethers.Contract(reputationRegistryAddress(), ReputationRegistryAbi, signer);
}

/**
 * Publish the creator's verdict on a settled job to the ReputationRegistry.
 *
 * Only called for jobs that actually settled or were rejected on a verdict —
 * never for timeouts or cancellations, which say nothing about the provider's
 * quality of work.
 */
export async function publishJobFeedback(jobId: string): Promise<{
  txHash: string;
  explorer: string;
  clientAddress: string;
  providerAgentId: string;
  value: number;
  alreadyPublished: boolean;
}> {
  const job = await prisma.a2AJob.findUnique({ where: { id: jobId } });
  if (!job) throw new Error(`Job ${jobId} not found`);

  if (job.verdictAccepted === null || job.verdictAccepted === undefined) {
    throw new Error(
      `Job ${jobId} has no verdict. Feedback is only published for jobs a verifier actually judged — ` +
        'a timeout or cancellation says nothing about the provider.',
    );
  }
  if (!job.providerErc8004Id) throw new Error(`Job ${jobId} has no provider agent id`);
  if (job.reputationTxHash) {
    return {
      txHash: job.reputationTxHash,
      explorer: basescanTx(job.reputationTxHash),
      clientAddress: job.creatorWallet,
      providerAgentId: job.providerErc8004Id,
      value: job.verdictAccepted ? 100 : 0,
      alreadyPublished: true,
    };
  }

  const creator = await prisma.agentBaseIdentity.findUnique({ where: { agentId: job.creatorAgentId } });
  if (!creator) throw new Error(`Creator agent ${job.creatorAgentId} has no Base identity`);

  // Fail with something actionable rather than an opaque "insufficient funds".
  const balance = await getProvider().getBalance(creator.eoaAddress);
  if (balance < MIN_GAS_WEI) {
    throw new Error(
      `Creator agent EOA ${creator.eoaAddress} has ${ethers.formatEther(balance)} ETH on Base — ` +
        `needs at least ${ethers.formatEther(MIN_GAS_WEI)} to author its own feedback. ` +
        'ERC-8004 records msg.sender as the reviewer, so this cannot be relayed without ' +
        'collapsing every review onto one address.',
    );
  }

  const value = job.verdictAccepted ? 100 : 0;

  // The rich record. Its hash is committed on-chain; the document itself is
  // served over HTTP and mirrored to 0G Storage by the marketplace.
  const feedbackDocument = {
    jobId: job.id,
    gameId: job.gameId,
    target: { metric: job.targetMetric, op: job.targetOp, value: job.targetValue },
    measured: job.verifiedValue,
    accepted: job.verdictAccepted,
    agreedPriceBaseUnits: job.agreedPriceBaseUnits,
    requirementsHash: job.requirementsHash,
    agreementHash: job.agreementHash,
    deliverableHash: job.deliverableHash,
    verdictReportHash: job.verdictReportHash,
    verdictTxHash: job.verdictTxHash,
    settledAt: job.settledAt?.toISOString() ?? null,
  };

  const feedbackJson = JSON.stringify(feedbackDocument, Object.keys(feedbackDocument).sort());
  const feedbackHash = ethers.keccak256(ethers.toUtf8Bytes(feedbackJson));
  const feedbackURI = `${requireEnv('A2A_PUBLIC_BASE_URL')}/marketplace/jobs/${job.id}/feedback.json`;

  const contract = reputationAsAgent(creator.eoaKeyEnc);
  const args = [
    BigInt(job.providerErc8004Id),
    BigInt(value),
    0, // valueDecimals: whole numbers, so getSummary's mean is the completion rate
    FEEDBACK_TAG_OUTCOME,
    job.gameId,
    '', // endpoint: the work was delivered through escrow, not a callable endpoint
    feedbackURI,
    feedbackHash,
  ] as const;

  const sent = await sendAttributed(contract, 'giveFeedback', args);
  const tx = { hash: sent.txHash };

  await prisma.a2AJob.update({
    where: { id: jobId },
    data: { reputationTxHash: tx.hash, feedbackHash, feedbackJson },
  });

  return {
    txHash: tx.hash,
    explorer: basescanTx(tx.hash),
    clientAddress: creator.eoaAddress,
    providerAgentId: job.providerErc8004Id,
    value,
    alreadyPublished: false,
  };
}

/**
 * Read an agent's on-chain reputation directly from the registry.
 *
 * Deliberately does not consult Postgres: this is what any third party sees,
 * and it is the number the marketplace UI shows next to our own aggregate so
 * a discrepancy is visible rather than hidden.
 */
export async function readOnChainReputation(erc8004AgentId: string): Promise<{
  agentId: string;
  totalFeedback: number;
  distinctClients: number;
  averageValue: number | null;
  completionRatePercent: number | null;
  registry: string;
}> {
  const contract = reputationRead();
  const agentId = BigInt(erc8004AgentId);

  const clients: string[] = await contract.getClients(agentId);

  // Empty filters mean "all tags"; passing our tag narrows to KULT job outcomes.
  const [count, summaryValue, summaryDecimals] = await contract.getSummary(
    agentId, [], FEEDBACK_TAG_OUTCOME, '',
  );

  const total = Number(count);
  const average =
    total > 0 ? Number(summaryValue) / 10 ** Number(summaryDecimals) : null;

  return {
    agentId: erc8004AgentId,
    totalFeedback: total,
    distinctClients: clients.length,
    averageValue: average,
    // value is 100 or 0, so the mean IS the completion rate.
    completionRatePercent: average,
    registry: reputationRegistryAddress(),
  };
}

/**
 * Every feedback record for an agent, straight from the chain.
 *
 * Returned as parallel arrays by the registry; zipped here because parallel
 * arrays are a trap for callers.
 */
export async function readFeedbackHistory(erc8004AgentId: string): Promise<
  Array<{ client: string; index: string; value: number; tag1: string; tag2: string; revoked: boolean }>
> {
  const [clients, indexes, values, decimals, tag1s, tag2s, revoked] =
    await reputationRead().readAllFeedback(BigInt(erc8004AgentId), [], '', '', false);

  return clients.map((client: string, i: number) => ({
    client,
    index: indexes[i].toString(),
    value: Number(values[i]) / 10 ** Number(decimals[i]),
    tag1: tag1s[i],
    tag2: tag2s[i],
    revoked: revoked[i],
  }));
}
