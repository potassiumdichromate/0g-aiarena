/**
 * The bridge between a funded job and real work.
 *
 * Escrow funding and training were two disconnected halves: nothing created a
 * TrainingJob when USDC landed, and nothing committed a deliverable when
 * training finished. A job could be funded and then sit at ESCROWED until it
 * timed out and refunded. This closes both ends.
 *
 *   ESCROWED  --startExecution-->  EXECUTING  --pollExecution-->  DELIVERED
 *                                                                     |
 *                        training-worker verification pass  <---------+
 *                                     |
 *                        evaluation-service submitVerdict --> SETTLED / REFUNDED
 *
 * Two decisions worth stating:
 *
 * **The provider's own policy is the input.** `trainerCheckpointPath` points at
 * the provider agent's most recent checkpoint. That is what makes the
 * provider's capability an economic input rather than a filter — a weak
 * trainer donates weak demonstrations and produces a weak student.
 *
 * **The training seed root is not the verification seed root.** Training gets a
 * root derived from the job id; verification generates a fresh one at
 * verification time. A provider that overfits to the seeds it trained against
 * fails verification (threat T18).
 */

import { createHash } from 'crypto';
import { prisma } from '@ai-arena/db-client';

const BASE_CHAIN_SERVICE_URL = process.env.BASE_CHAIN_SERVICE_URL ?? 'http://localhost:8051';

async function relay(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${BASE_CHAIN_SERVICE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Service-Key': process.env.INTERNAL_SERVICE_SECRET ?? '',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`base-chain-service ${path} responded ${response.status}: ${await response.text()}`);
  }
  return response.json() as Promise<Record<string, unknown>>;
}

/** Deterministic per-job seed root, so a training run can be reproduced. */
function trainingSeedRoot(jobId: string): number {
  const digest = createHash('sha256').update(`training:${jobId}`).digest();
  return digest.readUInt32BE(0) % 2 ** 31;
}

/**
 * Kick off the real work for a funded job.
 *
 * Idempotent: a job that already has a trainingJobId returns it rather than
 * queueing a second run. A retried call after a dropped response must not
 * double-charge the provider's compute.
 */
export async function startExecution(jobId: string): Promise<{
  jobId: string;
  trainingJobId: string;
  alreadyStarted: boolean;
}> {
  const job = await prisma.a2AJob.findUnique({ where: { id: jobId } });
  if (!job) throw new Error(`Job ${jobId} not found`);

  if (job.trainingJobId) {
    return { jobId, trainingJobId: job.trainingJobId, alreadyStarted: true };
  }
  if (job.status !== 'ESCROWED') {
    throw new Error(`Job ${jobId} is ${job.status}; only an ESCROWED job can start executing`);
  }
  if (!job.providerAgentId) {
    throw new Error(`Job ${jobId} has no provider — it was funded without a winning negotiation`);
  }

  // The provider's most recent checkpoint is the asset it sells. Absent one
  // (a provider that has never trained), the pipeline falls back to a scripted
  // baseline and records that it did — the evidence bundle must never imply a
  // trained trainer was used when it was not.
  const providerModel = await prisma.aIModel.findFirst({
    where: { agentId: job.providerAgentId, isActive: true },
    orderBy: { version: 'desc' },
  });

  const trainingJob = await prisma.trainingJob.create({
    data: {
      agentId: job.creatorAgentId,
      type: 'REINFORCEMENT_LEARNING',
      status: 'QUEUED',
      priority: 1, // paid work outranks background training
      config: {
        marketplaceJobId: job.id,
        targetMetric: job.targetMetric,
        targetValue: job.targetValue,
        evalSeedRoot: trainingSeedRoot(job.id),
        trainerCheckpointPath: providerModel?.checkpointPath ?? null,
        trainerAgentId: job.providerAgentId,
        gameId: job.gameId,
      } as never,
    },
  });

  await prisma.a2AJob.update({
    where: { id: jobId },
    data: { trainingJobId: trainingJob.id, status: 'EXECUTING' },
  });

  // Best-effort: markExecuting only timestamps the start on-chain. Failing it
  // must not strand a job whose training has already been queued — the escrow
  // accepts a deliverable from ESCROWED as well as EXECUTING for exactly this.
  try {
    const result = await relay(`/settlement/jobs/${jobId}/executing`, {});
    await prisma.a2AJob.update({
      where: { id: jobId },
      data: { executingTxHash: (result.txHash as string) ?? null },
    });
  } catch (err) {
    console.warn(`[a2a] markExecuting failed for ${jobId} (non-fatal):`, (err as Error).message);
  }

  return { jobId, trainingJobId: trainingJob.id, alreadyStarted: false };
}

/**
 * Advance EXECUTING jobs whose training has finished.
 *
 * Called on a tick. Commits the deliverable hash on-chain and moves the job to
 * DELIVERED, at which point the worker's verification pass picks it up.
 */
export async function pollExecution(limit = 10): Promise<Array<Record<string, unknown>>> {
  const executing = await prisma.a2AJob.findMany({
    where: { status: 'EXECUTING', trainingJobId: { not: null } },
    take: limit,
  });

  const results: Array<Record<string, unknown>> = [];

  for (const job of executing) {
    try {
      const training = await prisma.trainingJob.findUnique({ where: { id: job.trainingJobId! } });
      if (!training) {
        results.push({ jobId: job.id, action: 'skipped', reason: 'training job missing' });
        continue;
      }

      if (training.status === 'QUEUED' || training.status === 'RUNNING') {
        results.push({ jobId: job.id, action: 'waiting', stage: training.stage, progress: training.progress });
        continue;
      }

      if (training.status === 'FAILED' || training.status === 'CANCELLED') {
        // Deliberately NOT marked terminal off-chain. The escrow's timeout
        // refund is the creator's guaranteed exit and it is the only thing
        // that actually moves the money.
        await prisma.a2AJob.update({
          where: { id: job.id },
          data: { lastError: `training ${training.status}: ${training.errorLog ?? 'no detail'}` },
        });
        results.push({ jobId: job.id, action: 'training-failed', status: training.status });
        continue;
      }

      // COMPLETED. The deliverable is the checkpoint the provider produced,
      // identified by the digest recorded in its FINAL snapshot.
      const finalSnapshot = await prisma.agentCapabilitySnapshot.findFirst({
        where: { trainingJobId: training.id, kind: 'FINAL' },
        orderBy: { createdAt: 'desc' },
      });

      if (!finalSnapshot?.checkpointDigest) {
        await prisma.a2AJob.update({
          where: { id: job.id },
          data: { lastError: 'training completed without a FINAL snapshot carrying a checkpoint digest' },
        });
        results.push({ jobId: job.id, action: 'no-deliverable' });
        continue;
      }

      // The on-chain field is bytes32; the digest is "sha256:<hex>".
      const deliverableHash = `0x${finalSnapshot.checkpointDigest.replace(/^sha256:/, '')}`;

      const result = await relay(`/settlement/jobs/${job.id}/deliverable`, { deliverableHash });

      await prisma.a2AJob.update({
        where: { id: job.id },
        data: {
          status: 'DELIVERED',
          deliverableHash: finalSnapshot.checkpointDigest,
          deliverTxHash: (result.txHash as string) ?? null,
          deliveredAt: new Date(),
          lastError: null,
        },
      });

      results.push({ jobId: job.id, action: 'delivered', txHash: result.txHash });
    } catch (err) {
      console.error(`[a2a] pollExecution failed for ${job.id}:`, (err as Error).message);
      results.push({ jobId: job.id, action: 'error', error: (err as Error).message });
    }
  }

  return results;
}

/** Live progress for the UI, straight from the worker's own counters. */
export async function executionProgress(jobId: string) {
  const job = await prisma.a2AJob.findUnique({ where: { id: jobId } });
  if (!job) return null;

  const training = job.trainingJobId
    ? await prisma.trainingJob.findUnique({ where: { id: job.trainingJobId } })
    : null;

  const verification = job.verificationSnapshotId
    ? await prisma.agentCapabilitySnapshot.findUnique({ where: { id: job.verificationSnapshotId } })
    : null;

  return {
    jobId: job.id,
    status: job.status,
    training: training && {
      status: training.status,
      stage: training.stage,
      stageStep: training.stageStep,
      stageTotal: training.stageTotal,
      progress: training.progress,
      currentMetric: training.currentMetric,
      heartbeatAt: training.heartbeatAt,
    },
    target: { metric: job.targetMetric, op: job.targetOp, value: job.targetValue },
    // Present only once an INDEPENDENT verification has run — never the
    // provider's own measurement.
    verified: verification && {
      snapshotId: verification.id,
      combatSkill: verification.combatSkill,
      traits: verification.traits,
      seedRoot: verification.seedRoot,
      formulaVersion: verification.formulaVersion,
      protocolVersion: verification.protocolVersion,
    },
    verdict: job.verdictAccepted === null ? null : {
      accepted: job.verdictAccepted,
      measured: job.verifiedValue,
      reason: job.verdictReason,
      txHash: job.verdictTxHash,
    },
    lastError: job.lastError,
  };
}

/**
 * Start work on any job that is funded but never began.
 *
 * Covers two cases the funding path cannot: a job funded before automatic
 * start existed, and one where the start call failed after the USDC had
 * already locked. Without this such a job sits at ESCROWED until its deadline
 * and refunds, having done nothing.
 *
 * Idempotent — startExecution returns the existing training job rather than
 * queueing a second one.
 */
export async function startPendingExecutions(limit = 10): Promise<Array<Record<string, unknown>>> {
  const stranded = await prisma.a2AJob.findMany({
    where: { status: 'ESCROWED', trainingJobId: null },
    orderBy: { fundedAt: 'asc' },
    take: limit,
  });

  const results: Array<Record<string, unknown>> = [];
  for (const job of stranded) {
    try {
      const started = await startExecution(job.id);
      results.push({ jobId: job.id, action: 'started', trainingJobId: started.trainingJobId });
    } catch (err) {
      results.push({ jobId: job.id, action: 'error', error: (err as Error).message });
    }
  }
  return results;
}
