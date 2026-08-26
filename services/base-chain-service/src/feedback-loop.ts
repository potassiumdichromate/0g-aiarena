/**
 * Publish creator feedback on judged jobs, without waiting to be asked.
 *
 * This is the same gap that left verified work unsettled: publishJobFeedback
 * was complete and correct, POST /reputation/jobs/:jobId/publish exposed it,
 * and nothing ever called it. So no ERC-8004 feedback had been written for any
 * job, and every agent's reputation read back empty — not because the agents
 * had none, but because the record was never authored.
 *
 * Polled from Postgres for the reason the training worker documents: a dropped
 * message here would silently cost an agent its reputation, and polling a table
 * cannot drop anything. It also fixes itself retroactively — jobs that settled
 * before this existed are picked up on the first pass.
 *
 * Feedback is authored by the creator agent's own key, so it costs that agent a
 * few cents of Base gas. That is deliberate and is explained in
 * reputation.service: ERC-8004 records msg.sender as the reviewer, and relaying
 * every agent's feedback from one platform key would collapse every review onto
 * a single address, destroying the distinct-counterparty property that makes
 * the score resistant to self-dealing.
 */

import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '@ai-arena/db-client';

import { publishJobFeedback } from './reputation.service';

const POLL_INTERVAL_MS = Number(process.env.FEEDBACK_POLL_INTERVAL_S ?? '60') * 1000;

/**
 * Backoff for a job whose feedback will not publish.
 *
 * The common failure is a creator agent EOA with no ETH, which is a standing
 * condition rather than a blip — retrying it every minute would spend nothing
 * but log lines. Failures back off exponentially and cap, and are held in
 * memory because this is a rate limit, not a record worth a migration.
 */
const FIRST_BACKOFF_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;

const backoff = new Map<string, { retryAt: number; failures: number }>();

async function publishOnce(log: FastifyBaseLogger): Promise<void> {
  // A verdict is what makes feedback meaningful. A job that timed out or was
  // cancelled says nothing about the provider's work, and publishJobFeedback
  // refuses those anyway — selecting on the same condition keeps the loop from
  // repeatedly asking for something it will always be denied.
  const judged = await prisma.a2AJob.findMany({
    where: { verdictAccepted: { not: null }, reputationTxHash: null },
    select: { id: true },
    orderBy: { settledAt: 'asc' },
    take: 20,
  });

  const due = judged.filter(({ id }) => {
    const entry = backoff.get(id);
    return entry === undefined || Date.now() >= entry.retryAt;
  });
  if (due.length === 0) {
    if (judged.length > 0) {
      log.info({ judged: judged.length }, 'feedback pending but all jobs are backing off');
    }
    return;
  }

  log.info({ judged: judged.length, due: due.length }, 'publishing job feedback');

  // One at a time: each is a transaction from that creator agent's key, and two
  // jobs sharing a creator would otherwise race for the same nonce.
  for (const { id } of due) {
    try {
      const result = await publishJobFeedback(id);
      backoff.delete(id);
      log.info(
        { jobId: id, client: result.clientAddress, provider: result.providerAgentId, value: result.value, tx: result.txHash },
        result.alreadyPublished ? 'feedback already on-chain' : 'feedback published to ERC-8004',
      );
    } catch (err) {
      const failures = (backoff.get(id)?.failures ?? 0) + 1;
      const delay = Math.min(FIRST_BACKOFF_MS * 2 ** (failures - 1), MAX_BACKOFF_MS);
      backoff.set(id, { retryAt: Date.now() + delay, failures });
      const message = (err as Error).message;
      log.warn({ err, jobId: id, retryInMs: delay }, 'feedback publish failed');

      // Put it where it can be seen. Logging alone made a job that could not
      // publish indistinguishable from one not yet attempted — reputation zero,
      // lastError null, and the reason only in a log nobody was tailing.
      await prisma.a2AJob
        .update({
          where: { id },
          data: { lastError: `feedback: ${message}`.slice(0, 500) },
        })
        .catch(() => undefined);
    }
  }
}

/** Start the loop. Returns a function that stops it. */
export function startFeedbackLoop(log: FastifyBaseLogger): () => void {
  if (process.env.FEEDBACK_PUBLISHING === 'false') {
    log.warn('FEEDBACK_PUBLISHING=false — no ERC-8004 feedback will be authored');
    return () => undefined;
  }

  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  // Chained timeouts rather than setInterval: a slow pass must not have the
  // next one start underneath it and re-send a transaction already in flight.
  const tick = async (): Promise<void> => {
    try {
      await publishOnce(log);
    } catch (err) {
      log.error({ err }, 'feedback pass failed');
    }
    if (!stopped) timer = setTimeout(tick, POLL_INTERVAL_MS);
  };

  log.info({ intervalMs: POLL_INTERVAL_MS }, 'feedback loop started');
  timer = setTimeout(tick, POLL_INTERVAL_MS);

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
