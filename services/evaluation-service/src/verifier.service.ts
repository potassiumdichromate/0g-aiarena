/**
 * The verifier.
 *
 * Holds VERIFIER_ROLE and NOTHING else. It does not relay job state, it does
 * not hold agent keys, and it cannot choose a payee — the payout destination
 * was fixed on-chain at funding from a signature both agents produced. Its one
 * power is to decide whether delivered work met the target, and that decision
 * pays the provider or refunds the creator in the same transaction.
 *
 * Why a separate service and a separate key: if the same key both drove a
 * job's state and judged its outcome, a single compromise would let an
 * attacker manufacture an accepted verdict on a job it also controlled. That
 * is threat T3, and key separation is the mitigation.
 *
 * The verdict is NEVER based on a number the provider supplied. The Python
 * evaluation worker independently re-runs the seeded harness against the
 * delivered checkpoint under a fresh seed root, and this service reads that
 * VERIFICATION snapshot. A provider that overfits to the seeds it was given
 * still fails, because it never saw these.
 */

import { ethers } from 'ethers';
import { prisma } from '@ai-arena/db-client';
import { getZeroGConfig, ZeroGStorageClient } from '@ai-arena/zerog-client';

import A2AJobEscrowAbi from './abi/A2AJobEscrow.json';
import { sendAttributed } from '@ai-arena/a2a-protocol';

const storage = new ZeroGStorageClient(getZeroGConfig());

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

let _provider: ethers.JsonRpcProvider | null = null;
function getProvider(): ethers.JsonRpcProvider {
  if (!_provider) _provider = new ethers.JsonRpcProvider(requireEnv('BASE_RPC_URL'));
  return _provider;
}

let _verifier: ethers.Wallet | null = null;
function getVerifierSigner(): ethers.Wallet {
  if (!_verifier) _verifier = new ethers.Wallet(requireEnv('A2A_VERIFIER_PRIVATE_KEY'), getProvider());
  return _verifier;
}

export function verifierAddress(): string {
  return getVerifierSigner().address;
}

function escrowWrite(): ethers.Contract {
  return new ethers.Contract(requireEnv('A2A_JOB_ESCROW_ADDRESS'), A2AJobEscrowAbi, getVerifierSigner());
}

function escrowRead(): ethers.Contract {
  return new ethers.Contract(requireEnv('A2A_JOB_ESCROW_ADDRESS'), A2AJobEscrowAbi, getProvider());
}

function revertReason(err: unknown): string {
  const e = err as { shortMessage?: string; reason?: string; message?: string };
  return e.shortMessage ?? e.reason ?? e.message ?? 'unknown error';
}

function basescanTx(hash: string): string {
  return `https://basescan.org/tx/${hash}`;
}

/**
 * Compare a measured value against the job's target predicate.
 *
 * Kept explicit rather than reusing the capability matcher: this decides
 * whether real money moves, and it should be obvious from reading this file
 * exactly what comparison was made.
 */
function meetsTarget(measured: number, op: string, target: number): boolean {
  switch (op) {
    case 'gte': return measured >= target;
    case 'gt':  return measured >  target;
    case 'lte': return measured <= target;
    case 'lt':  return measured <  target;
    case 'eq':  return measured === target;
    default:
      throw new Error(`Unknown target operator "${op}"`);
  }
}

export interface VerdictResult {
  jobId: string;
  accepted: boolean;
  targetMetric: string;
  targetValue: number;
  measuredValue: number;
  reason: string;
  reportHash: string;
  reportRootHash: string | null;
  deliverTxHash: string | null;
  verdictTxHash: string;
  explorer: string;
}

/**
 * Verify one delivered job and settle it.
 *
 * Sequence, and why:
 *   1. Load the VERIFICATION snapshot — produced independently, fresh seeds.
 *   2. Publish the report to 0G Storage BEFORE committing its hash on-chain,
 *      so the chain never references a document nobody can fetch.
 *   3. Commit the deliverable hash (if the relayer has not already).
 *   4. Submit the verdict, which pays out or refunds in the same transaction.
 */
export async function verifyAndSettle(jobId: string): Promise<VerdictResult> {
  const job = await prisma.a2AJob.findUnique({ where: { id: jobId } });
  if (!job) throw new Error(`Job ${jobId} not found`);
  if (!job.verificationSnapshotId) {
    throw new Error(
      `Job ${jobId} has no verification snapshot yet — the evaluation worker has not re-run the deliverable`,
    );
  }

  const snapshot = await prisma.agentCapabilitySnapshot.findUnique({
    where: { id: job.verificationSnapshotId },
  });
  if (!snapshot) throw new Error(`Verification snapshot ${job.verificationSnapshotId} not found`);
  if (snapshot.kind !== 'VERIFICATION') {
    // A FINAL snapshot is the provider's own measurement. Settling on it would
    // mean paying against a number the paid party produced.
    throw new Error(
      `Snapshot ${snapshot.id} is ${snapshot.kind}, not VERIFICATION — refusing to settle on a provider-supplied measurement`,
    );
  }

  // Resolve the measured value for this job's target metric.
  const traits = (snapshot.traits ?? {}) as Record<string, number | null>;
  const measured =
    job.targetMetric === 'combatSkill' ? snapshot.combatSkill : traits[job.targetMetric] ?? null;

  if (measured === null || measured === undefined) {
    throw new Error(
      `Target metric "${job.targetMetric}" was not measured in the verification run — cannot settle`,
    );
  }

  const accepted = meetsTarget(measured, job.targetOp, job.targetValue);
  const reason = accepted
    ? `Measured ${job.targetMetric} ${measured} satisfies ${job.targetOp} ${job.targetValue}`
    : `Measured ${job.targetMetric} ${measured} does not satisfy ${job.targetOp} ${job.targetValue}`;

  // ── Publish the report before committing its hash ─────────────────────────
  const report = {
    jobId,
    verifier: verifierAddress(),
    verifiedAt: new Date().toISOString(),
    target: { metric: job.targetMetric, op: job.targetOp, value: job.targetValue },
    measured,
    accepted,
    reason,
    // Everything needed to re-run this evaluation independently.
    reproduction: {
      formulaVersion: snapshot.formulaVersion,
      protocolVersion: snapshot.protocolVersion,
      seedRoot: snapshot.seedRoot,
      seeds: snapshot.seeds,
      difficulties: snapshot.difficulties,
      episodesRun: snapshot.episodesRun,
      checkpointDigest: snapshot.checkpointDigest,
    },
    measurement: {
      combatSkill: snapshot.combatSkill,
      traits: snapshot.traits,
      components: snapshot.components,
      counters: snapshot.counters,
    },
  };

  const reportJson = JSON.stringify(report, Object.keys(report).sort());
  const reportHash = ethers.keccak256(ethers.toUtf8Bytes(reportJson));

  let reportRootHash: string | null = null;
  try {
    const upload = await storage.uploadBuffer(Buffer.from(reportJson, 'utf8'));
    reportRootHash = upload.rootHash;
    await prisma.storageIndex.upsert({
      where: { logicalPath: `a2a/jobs/${jobId}/verdict/v1` },
      update: { rootHash: reportRootHash },
      create: {
        logicalPath: `a2a/jobs/${jobId}/verdict/v1`,
        rootHash: reportRootHash,
        mimeType: 'application/json',
        sizeBytes: Buffer.byteLength(reportJson, 'utf8'),
        uploadedBy: 'evaluation-service',
        tags: ['a2a', 'verdict', jobId],
      },
    });
  } catch (err) {
    // Non-fatal: the report is durable in Postgres and served over HTTP. 0G
    // Storage is a second, content-addressed copy.
    console.warn('[verifier] 0G Storage upload failed, continuing:', (err as Error).message);
  }

  // ── Commit the deliverable hash if it is not already on-chain ─────────────
  const read = escrowRead();
  const write = escrowWrite();
  const status = Number(await read.jobStatus(jobId));

  let deliverTxHash: string | null = job.deliverTxHash;

  // 2 ESCROWED, 3 EXECUTING, 4 DELIVERED
  if (status === 2 || status === 3) {
    if (!job.deliverableHash) {
      throw new Error(`Job ${jobId} has no deliverable hash recorded — nothing to commit`);
    }
    const sent = await sendAttributed(write, 'submitDeliverable', [jobId, job.deliverableHash], {
      revertReasonOf: revertReason,
    });
    deliverTxHash = sent.txHash;
  } else if (status !== 4) {
    throw new Error(`Job ${jobId} is on-chain status ${status}; expected ESCROWED, EXECUTING or DELIVERED`);
  }

  // ── Verdict ───────────────────────────────────────────────────────────────
  const verdictSent = await sendAttributed(write, 'submitVerdict', [jobId, accepted, reportHash], {
    revertReasonOf: revertReason,
  });
  const verdictTx = { hash: verdictSent.txHash };

  await prisma.a2AJob.update({
    where: { id: jobId },
    data: {
      status: accepted ? 'SETTLED' : 'REFUNDED',
      verifiedValue: measured,
      verdictAccepted: accepted,
      verdictReportHash: reportHash,
      verdictReason: reason,
      deliverTxHash,
      verdictTxHash: verdictTx.hash,
      settledAt: new Date(),
    },
  });

  return {
    jobId,
    accepted,
    targetMetric: job.targetMetric,
    targetValue: job.targetValue,
    measuredValue: measured,
    reason,
    reportHash,
    reportRootHash,
    deliverTxHash,
    verdictTxHash: verdictTx.hash,
    explorer: basescanTx(verdictTx.hash),
  };
}

/** Jobs that have a verification snapshot and are waiting on a verdict. */
export async function pendingVerdicts(limit = 20) {
  const jobs = await prisma.a2AJob.findMany({
    where: {
      status: 'DELIVERED',
      verificationSnapshotId: { not: null },
      verdictAccepted: null,
    },
    orderBy: { deliveredAt: 'asc' },
    take: limit,
  });
  return jobs.map((j) => ({
    jobId: j.id,
    targetMetric: j.targetMetric,
    targetValue: j.targetValue,
    deliveredAt: j.deliveredAt,
  }));
}

/**
 * Health signal that actually means something: whether this service's key
 * holds VERIFIER_ROLE on the configured escrow. A misconfigured verifier looks
 * healthy right up until the first verdict reverts.
 */
export async function roleCheck(): Promise<{ address: string; hasVerifierRole: boolean; escrow: string }> {
  const read = escrowRead();
  const address = verifierAddress();
  const role = await read.VERIFIER_ROLE();

  return {
    address,
    hasVerifierRole: await read.hasRole(role, address),
    escrow: requireEnv('A2A_JOB_ESCROW_ADDRESS'),
  };
}
