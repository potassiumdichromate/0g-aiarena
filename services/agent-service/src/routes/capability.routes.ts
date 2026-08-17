/**
 * Capability and eligibility endpoints.
 *
 * These live in agent-service because capability is a property of an agent, and
 * the computation itself is in @ai-arena/capability so the Phase 4 marketplace
 * service can reuse it without a second implementation drifting.
 *
 * Everything here recomputes server-side from stored evidence. An agent's
 * self-reported capability is never accepted anywhere — that is threat T8, and
 * it is why the check-eligibility endpoint takes requirements and an agent id
 * rather than a caller-supplied profile.
 */

import { FastifyInstance } from 'fastify';
import { prisma } from '@ai-arena/db-client';
import {
  computeProfile,
  computeProfiles,
  matchAgent,
  rankCandidates,
  targetIsMeaningful,
  type CapabilityPredicate,
  type JobRequirements,
} from '@ai-arena/capability';

const DEFAULT_GAME_ID = 'warzone';
/** Bound on how many candidates a single discovery call will profile. */
const MAX_CANDIDATES = 100;

function parsePredicates(raw: unknown): CapabilityPredicate[] {
  if (!Array.isArray(raw)) return [];

  return raw.map((entry, index) => {
    const p = entry as Record<string, unknown>;
    if (typeof p.metric !== 'string' || typeof p.value !== 'number') {
      throw new Error(`requirement[${index}]: metric (string) and value (number) are required`);
    }
    const op = (p.op as string) ?? 'gte';
    if (!['gte', 'gt', 'lte', 'lt', 'eq'].includes(op)) {
      throw new Error(`requirement[${index}]: unknown operator "${op}"`);
    }
    return {
      metric: p.metric,
      op: op as CapabilityPredicate['op'],
      value: p.value,
      requireMeasured: p.requireMeasured === true,
    };
  });
}

export async function capabilityRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /agents/:id/capabilities?gameId=warzone
   *
   * Public: a counterparty agent must be able to see what it is negotiating
   * with, and everything returned is derived from data already exposed
   * elsewhere.
   */
  app.get('/:id/capabilities', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { gameId } = req.query as { gameId?: string };

    const profile = await computeProfile(prisma, id, gameId || DEFAULT_GAME_ID);
    if (!profile) return reply.status(404).send({ error: 'Agent not found' });

    return { profile };
  });

  /**
   * POST /agents/:id/eligibility-check
   *
   * "May this agent take a job with these requirements?" — with a per-predicate
   * breakdown, so a rejected agent learns exactly what it is short of rather
   * than getting an opaque no.
   */
  app.post('/:id/eligibility-check', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { gameId?: string; requirements?: unknown };

    let predicates: CapabilityPredicate[];
    try {
      predicates = parsePredicates(body.requirements);
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }

    const profile = await computeProfile(prisma, id, body.gameId || DEFAULT_GAME_ID);
    if (!profile) return reply.status(404).send({ error: 'Agent not found' });

    return { match: matchAgent(profile, predicates), profile };
  });

  /**
   * POST /agents/discover
   *
   * Given a job's requirements, return the agents that qualify, best-first.
   * This is the Agent-B-finds-work direction of discovery: a provider agent
   * polls it, or the marketplace pushes to the A2A endpoint declared in an
   * agent's ERC-8004 registration file.
   *
   * Ineligible candidates are omitted entirely rather than ranked low — the
   * caller cannot accidentally offer work to an unqualified agent.
   */
  app.post('/discover', async (req, reply) => {
    const body = (req.body ?? {}) as {
      gameId?: string;
      requirements?: unknown;
      candidateAgentIds?: unknown;
      limit?: number;
    };

    let predicates: CapabilityPredicate[];
    try {
      predicates = parsePredicates(body.requirements);
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }

    const gameId = body.gameId || DEFAULT_GAME_ID;
    const limit = Math.min(Number(body.limit) || MAX_CANDIDATES, MAX_CANDIDATES);

    // Explicit candidate list, or the active roster. Retired agents are
    // excluded: they cannot take on work.
    let agentIds: string[];
    if (Array.isArray(body.candidateAgentIds) && body.candidateAgentIds.length > 0) {
      agentIds = (body.candidateAgentIds as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, limit);
    } else {
      const agents = await prisma.agent.findMany({
        where: { isRetired: false },
        select: { id: true },
        orderBy: { eloRating: 'desc' },
        take: limit,
      });
      agentIds = agents.map((a) => a.id);
    }

    const profiles = await computeProfiles(prisma, agentIds, gameId);
    const requirements: JobRequirements = {
      gameId,
      // Discovery only filters providers; the target is irrelevant here and a
      // permissive placeholder keeps the shared type satisfied.
      target: { metric: 'combatSkill', op: 'gte', value: 0 },
      providerRequirements: predicates,
    };

    const matches = rankCandidates(profiles, requirements);

    return {
      gameId,
      candidatesConsidered: profiles.length,
      eligibleCount: matches.length,
      matches,
    };
  });

  /**
   * POST /agents/:id/target-check
   *
   * Would this job's target actually be an improvement for this agent? Guards
   * against a job asking for combat skill >= 70 from an agent already at 85,
   * where a provider would collect for delivering nothing.
   */
  app.post('/:id/target-check', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { gameId?: string; target?: unknown };

    let target: CapabilityPredicate;
    try {
      const parsed = parsePredicates([body.target]);
      if (parsed.length !== 1) throw new Error('target is required');
      [target] = parsed;
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }

    const gameId = body.gameId || DEFAULT_GAME_ID;
    const profile = await computeProfile(prisma, id, gameId);
    if (!profile) return reply.status(404).send({ error: 'Agent not found' });

    return targetIsMeaningful(profile, { gameId, target, providerRequirements: [] });
  });
}
