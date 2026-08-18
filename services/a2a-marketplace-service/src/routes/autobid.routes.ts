/**
 * Auto-bid policy — whether an agent takes work on its own.
 *
 * A dedicated endpoint rather than raw metadata editing, for two reasons. The
 * values are validated (a floor of "abc" or a negative concession rate would
 * otherwise sit in the database until the discovery tick tripped over it), and
 * the write is read-modify-write so enabling auto-bid cannot clobber the
 * agent's other metadata — autonomousConfig, backstory, avatar hashes.
 *
 * Auto-bid does not spend the owner's USDC; a provider is paid, not charged.
 * What it does commit is compute time and the agent's public ERC-8004
 * reputation, since a job taken and failed is recorded permanently. That is
 * why it is a deliberate switch rather than on by default.
 */

import { FastifyInstance } from 'fastify';
import { prisma } from '@ai-arena/db-client';
import { requireAuth, assertOwnsAgent } from '../middleware/auth';
import { readAutoBidPolicy } from '../discovery.service';

/** 0.05 USDC. Below this a job cannot cover its own settlement gas. */
const MIN_FLOOR_BASE_UNITS = 50_000n;

export async function autoBidRoutes(app: FastifyInstance): Promise<void> {
  /** GET /agents/:agentId/auto-bid — current policy. Open: it is not a secret. */
  app.get('/:agentId/auto-bid', async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    const agent = await prisma.agent.findUnique({
      where: { id: agentId },
      select: { metadata: true },
    });
    if (!agent) return reply.status(404).send({ error: 'Agent not found' });

    const policy = readAutoBidPolicy(agent.metadata);
    return policy ?? { enabled: false, floorBaseUnits: null };
  });

  /** PUT /agents/:agentId/auto-bid — enable, adjust, or disable. */
  app.put('/:agentId/auto-bid', { onRequest: [requireAuth(app)] as never }, async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    const body = (req.body ?? {}) as {
      enabled?: boolean;
      floorBaseUnits?: string;
      concessionRate?: number;
      openingFraction?: number;
      gameIds?: string[];
    };

    if (!(await assertOwnsAgent(req, reply, agentId))) return;

    // Disabling needs no other field to be valid.
    if (body.enabled === false) {
      const updated = await writePolicy(agentId, { enabled: false });
      return { enabled: false, agentId, metadata: updated };
    }

    if (typeof body.floorBaseUnits !== 'string' || !/^\d+$/.test(body.floorBaseUnits)) {
      return reply.status(400).send({
        error: 'floorBaseUnits must be a whole number of USDC base units, as a string. 0.25 USDC is "250000".',
      });
    }
    if (BigInt(body.floorBaseUnits) < MIN_FLOOR_BASE_UNITS) {
      return reply.status(400).send({
        error: `floorBaseUnits must be at least ${MIN_FLOOR_BASE_UNITS} (0.05 USDC); below that a job cannot cover its own settlement gas.`,
      });
    }
    for (const [name, value] of [['concessionRate', body.concessionRate], ['openingFraction', body.openingFraction]] as const) {
      if (value !== undefined && (typeof value !== 'number' || value < 0 || value > 1)) {
        return reply.status(400).send({ error: `${name} must be a number between 0 and 1` });
      }
    }

    // An agent with no Base identity cannot propose, so enabling auto-bid
    // would silently do nothing every tick.
    const identity = await prisma.agentBaseIdentity.findUnique({
      where: { agentId },
      select: { erc8004AgentId: true },
    });
    if (!identity?.erc8004AgentId) {
      return reply.status(400).send({
        error: 'Register this agent on Base before enabling auto-bid — an unregistered agent cannot propose.',
      });
    }

    const updated = await writePolicy(agentId, {
      enabled: true,
      floorBaseUnits: body.floorBaseUnits,
      ...(body.concessionRate !== undefined ? { concessionRate: body.concessionRate } : {}),
      ...(body.openingFraction !== undefined ? { openingFraction: body.openingFraction } : {}),
      ...(body.gameIds?.length ? { gameIds: body.gameIds } : {}),
    });

    return { enabled: true, agentId, policy: updated };
  });
}

/** Read-modify-write so other metadata keys survive. */
async function writePolicy(agentId: string, policy: Record<string, unknown>) {
  const agent = await prisma.agent.findUniqueOrThrow({
    where: { id: agentId },
    select: { metadata: true },
  });
  const metadata = (agent.metadata ?? {}) as Record<string, unknown>;

  await prisma.agent.update({
    where: { id: agentId },
    data: { metadata: { ...metadata, a2aAutoBid: policy } as never },
  });

  return policy;
}
