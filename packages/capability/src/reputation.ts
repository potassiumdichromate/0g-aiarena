/**
 * Marketplace reputation — derived from settled jobs only.
 *
 * Two rules, both of which exist because the obvious alternative is gameable:
 *
 *   1. **Only settled marketplace jobs count.** Not battle wins, not ELO, not
 *      trait values. `autonomous-loop.ts` simulates battles with rand() stats
 *      and `agent-bot-service` mints fresh agents on throwaway wallets every
 *      30-60 minutes, so any metric built on raw battle history inherits both.
 *      A settled job required someone to actually part with USDC.
 *
 *   2. **Distinct counterparties are tracked and reported separately.** Ten
 *      jobs from one client is a different signal from ten jobs from ten
 *      clients, and collapsing them hides exactly the Sybil pattern a reader
 *      needs to see (T13). Self-dealing is already blocked on-chain, but a
 *      ring of colluding wallets is not, so the number is surfaced rather than
 *      silently folded into an average.
 *
 * Every field here is recomputable from on-chain events plus the published
 * requirement documents. Nothing depends on private platform state.
 */

import type { PrismaClient } from '@ai-arena/db-client';

export interface ReputationSummary {
  agentId: string;
  erc8004AgentId: string | null;

  /** Jobs where a verifier accepted the work and USDC was released. */
  jobsCompleted: number;
  /** Jobs delivered but rejected on the verdict. */
  jobsFailed: number;
  /** Funded jobs that never reached a verdict — timeouts and refunds. */
  jobsAbandoned: number;

  /** Accepted / (accepted + rejected). Abandoned jobs are excluded — see below. */
  completionRate: number | null;

  totalEarnedBaseUnits: string;
  totalEarnedDisplay: string;

  /** Distinct creator agents that have paid this provider. */
  distinctClients: number;

  /** Mean seconds from escrow funded to verdict, over completed jobs. */
  meanDeliverySeconds: number | null;
  /** Mean (measured - target) over completed jobs. Positive = overshoot. */
  meanOvershoot: number | null;

  /** Games this agent has actually been paid to work in. */
  gamesWorked: string[];

  /** Every settlement, for the audit trail. */
  settlements: Array<{
    jobId: string;
    gameId: string;
    targetMetric: string;
    targetValue: number;
    measuredValue: number | null;
    accepted: boolean;
    amountBaseUnits: string | null;
    settledAt: Date | null;
    verdictTxHash: string | null;
    reputationTxHash: string | null;
  }>;
}

function formatUsdc(baseUnits: bigint): string {
  const divisor = 1_000_000n;
  const whole = baseUnits / divisor;
  const fraction = (baseUnits % divisor).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/**
 * Build the reputation summary for one agent acting as a provider.
 *
 * `completionRate` deliberately excludes abandoned jobs. A job that timed out
 * may have failed for reasons that say nothing about the provider — the
 * verifier never responded, the relayer died, the creator vanished. Counting
 * those as provider failures would let a hostile client tank a competitor's
 * rate by funding jobs and then stalling. Abandonment is reported separately
 * so a reader can weigh it themselves.
 */
export async function computeReputation(
  prisma: PrismaClient,
  agentId: string,
): Promise<ReputationSummary> {
  const identity = await prisma.agentBaseIdentity.findUnique({
    where: { agentId },
    select: { erc8004AgentId: true },
  });

  const jobs = await prisma.a2AJob.findMany({
    where: {
      providerAgentId: agentId,
      // Only jobs whose money actually moved.
      status: { in: ['SETTLED', 'REFUNDED'] },
    },
    orderBy: { settledAt: 'desc' },
  });

  const completed = jobs.filter((j) => j.verdictAccepted === true);
  const failed = jobs.filter((j) => j.verdictAccepted === false);
  // Funded, then refunded without any verdict having been rendered.
  const abandoned = jobs.filter((j) => j.verdictAccepted === null);

  const judged = completed.length + failed.length;

  const totalEarned = completed.reduce((sum, j) => {
    if (!j.agreedPriceBaseUnits) return sum;
    // The provider receives the price minus commission. Commission is locked
    // per job at funding, so recompute per job rather than applying a global rate.
    const price = BigInt(j.agreedPriceBaseUnits);
    const commission = (price * 1000n) / 10_000n;
    return sum + (price - commission);
  }, 0n);

  const deliveryTimes = completed
    .filter((j) => j.fundedAt && j.settledAt)
    .map((j) => (j.settledAt!.getTime() - j.fundedAt!.getTime()) / 1000);

  const overshoots = completed
    .filter((j) => j.verifiedValue !== null && j.verifiedValue !== undefined)
    .map((j) => j.verifiedValue! - j.targetValue);

  const distinctClients = new Set(jobs.map((j) => j.creatorAgentId)).size;
  const gamesWorked = [...new Set(completed.map((j) => j.gameId))].sort();

  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

  return {
    agentId,
    erc8004AgentId: identity?.erc8004AgentId ?? null,
    jobsCompleted: completed.length,
    jobsFailed: failed.length,
    jobsAbandoned: abandoned.length,
    completionRate: judged > 0 ? completed.length / judged : null,
    totalEarnedBaseUnits: totalEarned.toString(),
    totalEarnedDisplay: formatUsdc(totalEarned),
    distinctClients,
    meanDeliverySeconds: mean(deliveryTimes),
    meanOvershoot: mean(overshoots),
    gamesWorked,
    settlements: jobs.map((j) => ({
      jobId: j.id,
      gameId: j.gameId,
      targetMetric: j.targetMetric,
      targetValue: j.targetValue,
      measuredValue: j.verifiedValue ?? null,
      accepted: j.verdictAccepted ?? false,
      amountBaseUnits: j.agreedPriceBaseUnits,
      settledAt: j.settledAt,
      verdictTxHash: j.verdictTxHash,
      reputationTxHash: j.reputationTxHash,
    })),
  };
}

/**
 * Rank providers for a game.
 *
 * Sorted by completion rate, then by number of distinct clients — an agent
 * with a perfect record across one client should not outrank one with the same
 * rate across eight. Agents with no judged jobs sort last rather than being
 * hidden: a new provider is not a bad provider, it is an unknown one.
 */
export async function rankProviders(
  prisma: PrismaClient,
  gameId: string,
  limit = 25,
): Promise<ReputationSummary[]> {
  const rows = await prisma.a2AJob.findMany({
    where: { gameId, status: 'SETTLED', providerAgentId: { not: null } },
    select: { providerAgentId: true },
    distinct: ['providerAgentId'],
    take: 200,
  });

  const summaries = await Promise.all(
    rows
      .map((r) => r.providerAgentId)
      .filter((id): id is string => !!id)
      .map((id) => computeReputation(prisma, id)),
  );

  return summaries
    .sort((a, b) => {
      const rateA = a.completionRate ?? -1;
      const rateB = b.completionRate ?? -1;
      if (rateB !== rateA) return rateB - rateA;
      return b.distinctClients - a.distinctClients;
    })
    .slice(0, limit);
}
