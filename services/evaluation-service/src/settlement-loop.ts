/**
 * Settle verified jobs without waiting to be asked.
 *
 * The verification pipeline was complete except for its last link. The Python
 * worker re-runs the delivered checkpoint under a fresh seed root and writes a
 * VERIFICATION snapshot; verifyAndSettle reads that snapshot, publishes the
 * report and submits the verdict, which pays the provider or refunds the
 * creator in the same transaction. Both halves worked. Nothing connected them:
 * /jobs/:jobId/verify existed, and no caller ever hit it.
 *
 * So a job whose work had been done, delivered, and independently verified sat
 * at DELIVERED indefinitely, with its escrow untouched and nothing in any error
 * field to say why — because nothing had failed.
 *
 * This polls Postgres rather than reacting to an event, matching the choice the
 * training worker already documents: NATS is unreliable on this infrastructure,
 * and a dropped message here would strand a paid job. Polling a table cannot
 * drop anything. It also self-heals — a verdict missed during a deploy is
 * picked up on the next tick rather than needing someone to notice.
 */

import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '@ai-arena/db-client';

import { pendingVerdicts, verifyAndSettle } from './verifier.service';

const POLL_INTERVAL_MS = Number(process.env.VERDICT_POLL_INTERVAL_S ?? '30') * 1000;

/**
 * Backoff for a job whose settlement keeps failing.
 *
 * Some failures are transient (an RPC blip, a nonce race) and some are
 * permanent (the target metric was never measured). Retrying either one every
 * tick would mean a permanently broken job hammering Base forever, so failures
 * back off exponentially and cap.
 *
 * Held in memory on purpose: it is a rate limit, not a record. A restart
 * costing one extra attempt per job is the correct trade against a migration
 * and a column that exists only to slow something down.
 */
const FIRST_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;

const backoff = new Map<string, { retryAt: number; failures: number }>();

function shouldSkip(jobId: string): boolean {
  const entry = backoff.get(jobId);
  return entry !== undefined && Date.now() < entry.retryAt;
}

function recordFailure(jobId: string): number {
  const failures = (backoff.get(jobId)?.failures ?? 0) + 1;
  const delay = Math.min(FIRST_BACKOFF_MS * 2 ** (failures - 1), MAX_BACKOFF_MS);
  backoff.set(jobId, { retryAt: Date.now() + delay, failures });
  return delay;
}

/**
 * One pass over every job holding a verification snapshot and no verdict.
 *
 * Jobs are settled one at a time rather than in parallel. Each verdict is a
 * transaction from a single key, and firing several at once means several
 * transactions competing for the same nonce.
 */
async function settleOnce(log: FastifyBaseLogger): Promise<void> {
  const pending = await pendingVerdicts(20);
  if (pending.length === 0) return;

  const due = pending.filter((job) => !shouldSkip(job.jobId));
  if (due.length === 0) return;

  log.info(
    { pending: pending.length, due: due.length },
    'settling verified jobs',
  );

  for (const job of due) {
    try {
      const result = await verifyAndSettle(job.jobId);
      backoff.delete(job.jobId);
      log.info(
        {
          jobId: result.jobId,
          accepted: result.accepted,
          measured: result.measuredValue,
          target: result.targetValue,
          tx: result.verdictTxHash,
        },
        result.accepted ? 'job settled — provider paid' : 'job refunded — target missed',
      );
    } catch (err) {
      const delay = recordFailure(job.jobId);
      const message = (err as Error).message;
      log.error({ err, jobId: job.jobId, retryInMs: delay }, 'settlement failed');

      // Surface it on the job itself. A settlement that keeps failing is
      // invisible if it only ever appears in this service's logs, and the
      // creator watching the job is the person who most needs to know.
      await prisma.a2AJob
        .update({
          where: { id: job.jobId },
          data: { lastError: `settlement: ${message}`.slice(0, 500) },
        })
        .catch(() => undefined);
    }
  }
}

/**
 * Start the loop. Returns a function that stops it.
 *
 * Chained timeouts rather than setInterval: a pass that takes longer than the
 * interval must not have the next one start underneath it, or two passes race
 * to settle the same job and one of them reverts.
 */
export function startSettlementLoop(log: FastifyBaseLogger): () => void {
  if (process.env.VERDICT_POLLING === 'false') {
    log.warn('VERDICT_POLLING=false — verified jobs will not settle until /jobs/:jobId/verify is called');
    return () => undefined;
  }

  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const tick = async (): Promise<void> => {
    try {
      await settleOnce(log);
    } catch (err) {
      // A failure here is the loop itself breaking — a lost database
      // connection, most likely. One job's failure is handled inside.
      log.error({ err }, 'settlement pass failed');
    }
    if (!stopped) timer = setTimeout(tick, POLL_INTERVAL_MS);
  };

  log.info({ intervalMs: POLL_INTERVAL_MS }, 'settlement loop started');
  timer = setTimeout(tick, POLL_INTERVAL_MS);

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
