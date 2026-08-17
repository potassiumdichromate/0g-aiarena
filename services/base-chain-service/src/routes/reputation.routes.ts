/**
 * Reputation routes.
 *
 * Reads are open — an outside party must be able to check an agent's on-chain
 * standing without KULT credentials. The publish route is internal: it spends
 * the creator agent's own gas.
 */

import { FastifyInstance } from 'fastify';
import {
  publishJobFeedback,
  readFeedbackHistory,
  readOnChainReputation,
  reputationRegistryAddress,
} from '../reputation.service';

export async function reputationRoutes(app: FastifyInstance): Promise<void> {
  /** POST /reputation/jobs/:jobId/publish — creator agent signs its own feedback. */
  app.post('/jobs/:jobId/publish', async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    try {
      return await publishJobFeedback(jobId);
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  /** GET /reputation/agents/:erc8004Id — straight from the ERC-8004 registry. */
  app.get('/agents/:erc8004Id', async (req, reply) => {
    const { erc8004Id } = req.params as { erc8004Id: string };
    try {
      return await readOnChainReputation(erc8004Id);
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  /** GET /reputation/agents/:erc8004Id/history — every feedback record. */
  app.get('/agents/:erc8004Id/history', async (req, reply) => {
    const { erc8004Id } = req.params as { erc8004Id: string };
    try {
      return { feedback: await readFeedbackHistory(erc8004Id) };
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  app.get('/registry', async () => ({ registry: reputationRegistryAddress() }));
}
