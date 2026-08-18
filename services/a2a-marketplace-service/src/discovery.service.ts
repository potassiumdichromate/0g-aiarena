/**
 * Discovery — how a provider agent finds work.
 *
 * The matching logic existed from the start, but nothing invoked it: an agent
 * could be checked for eligibility when it proposed, and there was no way for
 * it to learn a job existed in the first place. A posted job therefore sat at
 * POSTED indefinitely.
 *
 * Two halves, deliberately separate:
 *
 *   matchingJobsFor()  a pull API. Given an agent, which open jobs does it
 *                      qualify for? Eligibility is recomputed server-side from
 *                      real battle history and evaluation snapshots — an
 *                      agent's claim about itself is never an input.
 *
 *   runDiscoveryTick() the autonomous half. Every provider agent with an
 *                      auto-bid policy looks at the board and opens a
 *                      negotiation on jobs it qualifies for. This is what makes
 *                      the marketplace agent-to-agent rather than a job board
 *                      humans click through.
 */

import { prisma } from '@ai-arena/db-client';
import { computeProfile, matchAgent, type MatchResult } from '@ai-arena/capability';
import { openNegotiation, providerRespond } from './negotiation.service';

/** Providers only auto-bid when the owner has opted in, on this agent. */
export interface AutoBidPolicy {
  enabled: boolean;
  floorBaseUnits: string;
  concessionRate?: number;
  openingFraction?: number;
  /** Restrict to these games. Empty means any game the agent has a profile for. */
  gameIds?: string[];
}

export function readAutoBidPolicy(metadata: unknown): AutoBidPolicy | null {
  const meta = (metadata ?? {}) as Record<string, unknown>;
  const raw = meta.a2aAutoBid as Record<string, unknown> | undefined;
  if (!raw || raw.enabled !== true) return null;
  if (typeof raw.floorBaseUnits !== 'string') return null;

  return {
    enabled: true,
    floorBaseUnits: raw.floorBaseUnits,
    concessionRate: typeof raw.concessionRate === 'number' ? raw.concessionRate : undefined,
    openingFraction: typeof raw.openingFraction === 'number' ? raw.openingFraction : undefined,
    gameIds: Array.isArray(raw.gameIds) ? (raw.gameIds as string[]) : undefined,
  };
}

/**
 * Open jobs this agent qualifies for.
 *
 * Jobs the agent has already engaged are excluded — a provider does not need
 * to rediscover a negotiation it is already in.
 */
export async function matchingJobsFor(agentId: string, limit = 25): Promise<{
  agentId: string;
  matches: Array<{ jobId: string; gameId: string; match: MatchResult; budget: { min: string; max: string } }>;
  rejected: Array<{ jobId: string; reason: string }>;
}> {
  const open = await prisma.a2AJob.findMany({
    where: { status: { in: ['POSTED', 'NEGOTIATING'] } },
    orderBy: { createdAt: 'desc' },
    take: Math.min(limit, 100),
  });

  const engaged = new Set(
    (await prisma.a2ANegotiation.findMany({
      where: { providerAgentId: agentId },
      select: { jobId: true },
    })).map((n) => n.jobId),
  );

  const matches = [];
  const rejected = [];
  // Profiles are per-game and expensive; compute once per game, not per job.
  const profiles = new Map<string, Awaited<ReturnType<typeof computeProfile>>>();

  for (const job of open) {
    if (engaged.has(job.id)) continue;

    // An agent cannot take its own job. Self-dealing is rejected on-chain at
    // funding, but surfacing it here avoids a negotiation that can never settle.
    if (job.creatorAgentId === agentId) {
      rejected.push({ jobId: job.id, reason: 'agent posted this job itself' });
      continue;
    }

    if (!profiles.has(job.gameId)) {
      profiles.set(job.gameId, await computeProfile(prisma, agentId, job.gameId));
    }
    const profile = profiles.get(job.gameId);
    if (!profile) {
      rejected.push({ jobId: job.id, reason: `no capability profile for ${job.gameId}` });
      continue;
    }

    const match = matchAgent(profile, job.providerRequirements as never);
    if (match.eligible) {
      matches.push({
        jobId: job.id,
        gameId: job.gameId,
        match,
        budget: { min: job.budgetMinBaseUnits, max: job.budgetMaxBaseUnits },
      });
    } else {
      rejected.push({ jobId: job.id, reason: match.failureSummary ?? 'requirements not met' });
    }
  }

  // Best margin first: the agent most comfortably over the bar.
  matches.sort((a, b) => b.match.margin - a.match.margin);
  return { agentId, matches, rejected };
}

/**
 * One autonomous discovery pass across every opted-in provider.
 *
 * A provider whose floor exceeds a job's ceiling declines by simply not
 * bidding — `respondAsProvider` would return DECLINE, and opening a
 * negotiation just to abandon it would litter the job with dead threads.
 */
export async function runDiscoveryTick(): Promise<{
  agentsConsidered: number;
  proposalsOpened: number;
  results: Array<Record<string, unknown>>;
}> {
  // Only agents with a Base identity can propose at all.
  const identities = await prisma.agentBaseIdentity.findMany({
    where: { erc8004AgentId: { not: null } },
    select: { agentId: true },
  });

  const results: Array<Record<string, unknown>> = [];
  let proposalsOpened = 0;
  let agentsConsidered = 0;

  for (const { agentId } of identities) {
    const agent = await prisma.agent.findUnique({
      where: { id: agentId },
      select: { metadata: true, isRetired: true },
    });
    if (!agent || agent.isRetired) continue;

    const policy = readAutoBidPolicy(agent.metadata);
    if (!policy) continue;

    agentsConsidered += 1;

    const { matches } = await matchingJobsFor(agentId);
    for (const candidate of matches) {
      if (policy.gameIds?.length && !policy.gameIds.includes(candidate.gameId)) continue;

      // Do not open a thread the agent would immediately abandon.
      if (BigInt(policy.floorBaseUnits) > BigInt(candidate.budget.max)) {
        results.push({
          agentId, jobId: candidate.jobId, action: 'skipped',
          reason: `floor ${policy.floorBaseUnits} exceeds job ceiling ${candidate.budget.max}`,
        });
        continue;
      }

      try {
        const negotiation = await openNegotiation({
          jobId: candidate.jobId,
          providerAgentId: agentId,
        });
        // Immediately play the opening move, so the creator sees a real offer
        // rather than an empty thread.
        const decision = await providerRespond({
          negotiationId: negotiation.id,
          floorBaseUnits: policy.floorBaseUnits,
          concessionRate: policy.concessionRate,
          openingFraction: policy.openingFraction,
        });
        proposalsOpened += 1;
        results.push({ agentId, jobId: candidate.jobId, action: 'proposed', decision });
      } catch (err) {
        results.push({ agentId, jobId: candidate.jobId, action: 'error', error: (err as Error).message });
      }
    }
  }

  return { agentsConsidered, proposalsOpened, results };
}
