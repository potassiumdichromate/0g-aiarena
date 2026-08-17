/**
 * Authentication and agent ownership for the marketplace.
 *
 * Reads stay open by design: an external agent must be able to discover jobs,
 * read a negotiation transcript and fetch a requirements document without KULT
 * credentials. That is what makes the marketplace independently verifiable.
 *
 * Writes are a different matter. Every write here acts AS a specific agent —
 * posting a job, making an offer, signing an agreement — and an unauthenticated
 * caller could otherwise act as any agent it names in a request body. So each
 * write proves two things: a valid session, and that the session's user owns
 * the agent being acted for.
 */

import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '@ai-arena/db-client';

/** Require a valid AI Arena JWT. Mirrors agent-service's middleware. */
export function requireAuth(_app: FastifyInstance) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    try {
      await req.jwtVerify();
    } catch {
      reply.status(401).send({ error: 'Unauthorized' });
    }
  };
}

/**
 * Confirm the authenticated user owns this agent.
 *
 * Returns the agent on success. On failure it has already sent the response,
 * and the caller must return immediately.
 *
 * A missing agent and an agent owned by someone else both return 404, not 403:
 * distinguishing them would let any caller enumerate which agent ids exist.
 */
export async function assertOwnsAgent(
  req: FastifyRequest,
  reply: FastifyReply,
  agentId: string,
): Promise<{ id: string; userId: string; name: string } | null> {
  const { userId } = (req.user ?? {}) as { userId?: string };

  if (!userId) {
    reply.status(401).send({ error: 'Unauthorized' });
    return null;
  }

  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { id: true, userId: true, name: true },
  });

  if (!agent || agent.userId !== userId) {
    reply.status(404).send({ error: 'Agent not found' });
    return null;
  }

  return agent;
}

/**
 * Confirm the user owns the agent that created a given job.
 *
 * Used by creator-side actions — confirming a draft, making a counter-offer —
 * where the agent is identified indirectly through the job.
 */
export async function assertOwnsJobCreator(
  req: FastifyRequest,
  reply: FastifyReply,
  jobId: string,
): Promise<{ jobId: string; creatorAgentId: string } | null> {
  const job = await prisma.a2AJob.findUnique({
    where: { id: jobId },
    select: { id: true, creatorAgentId: true },
  });

  if (!job) {
    reply.status(404).send({ error: 'Job not found' });
    return null;
  }

  const agent = await assertOwnsAgent(req, reply, job.creatorAgentId);
  if (!agent) return null;

  return { jobId: job.id, creatorAgentId: job.creatorAgentId };
}

/**
 * Confirm the user owns the side of a negotiation they claim to speak for.
 *
 * A negotiation has two sides. CREATOR actions must come from the owner of the
 * job's creator agent, PROVIDER actions from the owner of the provider agent.
 * Without this check either party could post messages as the other and forge
 * a convergence they never agreed to.
 */
export async function assertOwnsNegotiationSide(
  req: FastifyRequest,
  reply: FastifyReply,
  negotiationId: string,
  role: 'CREATOR' | 'PROVIDER',
): Promise<boolean> {
  const negotiation = await prisma.a2ANegotiation.findUnique({
    where: { id: negotiationId },
    select: { id: true, jobId: true, providerAgentId: true },
  });

  if (!negotiation) {
    reply.status(404).send({ error: 'Negotiation not found' });
    return false;
  }

  let agentId = negotiation.providerAgentId;

  if (role === 'CREATOR') {
    const job = await prisma.a2AJob.findUnique({
      where: { id: negotiation.jobId },
      select: { creatorAgentId: true },
    });
    if (!job) {
      reply.status(404).send({ error: 'Job not found' });
      return false;
    }
    agentId = job.creatorAgentId;
  }

  return !!(await assertOwnsAgent(req, reply, agentId));
}

/**
 * Internal-only guard for orchestration endpoints.
 *
 * Starting execution and running the delivery poll are system actions, not
 * user actions — they spend compute and submit transactions. They are called
 * by the service itself and by internal schedulers, never from a browser.
 */
export function requireServiceKey() {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const expected = process.env.INTERNAL_SERVICE_SECRET;
    if (!expected) {
      reply.status(503).send({ error: 'INTERNAL_SERVICE_SECRET not configured' });
      return;
    }
    if (req.headers['x-service-key'] !== expected) {
      reply.status(401).send({ error: 'Invalid or missing X-Service-Key' });
    }
  };
}
