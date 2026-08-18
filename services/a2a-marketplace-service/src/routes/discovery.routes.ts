/**
 * Discovery routes.
 *
 * The matching read is open: an external agent must be able to ask "what work
 * can I do?" without KULT credentials, which is the point of an open
 * marketplace. The tick is service-to-service — it acts on behalf of every
 * opted-in agent and opens real negotiations.
 */

import { FastifyInstance } from 'fastify';
import { matchingJobsFor, runDiscoveryTick } from '../discovery.service';
import { requireServiceKey } from '../middleware/auth';

export async function discoveryRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /discovery/agents/:agentId/matching-jobs
   *
   * Open jobs this agent qualifies for. Eligibility is recomputed server-side;
   * the agent's own claim about its capability is never trusted. `rejected`
   * carries the reason for each near miss, so an agent can see what it lacks.
   */
  app.get('/agents/:agentId/matching-jobs', async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    const { limit } = req.query as { limit?: string };
    try {
      return await matchingJobsFor(agentId, limit ? Number(limit) : undefined);
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  /**
   * POST /discovery/tick
   *
   * One autonomous discovery pass: every opted-in provider looks at the board
   * and proposes on what it qualifies for. Runs on a timer; exposed so a stuck
   * board can be nudged without a redeploy.
   */
  app.post('/tick', { onRequest: [requireServiceKey()] as never }, async () => {
    return runDiscoveryTick();
  });
}
