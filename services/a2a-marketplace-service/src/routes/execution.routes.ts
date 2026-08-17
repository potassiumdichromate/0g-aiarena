/**
 * Execution routes.
 *
 * /progress is public — it is what the UI polls to show the live training
 * panel, and it exposes nothing an observer could not derive from the chain
 * plus the published requirement document.
 */

import { FastifyInstance } from 'fastify';
import { executionProgress, pollExecution, startExecution } from '../execution.service';
import { requireServiceKey } from '../middleware/auth';

export async function executionRoutes(app: FastifyInstance): Promise<void> {
  /** POST /execution/jobs/:jobId/start — queue the real work for a funded job. */
  app.post('/jobs/:jobId/start', { onRequest: [requireServiceKey()] as never }, async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    try {
      return await startExecution(jobId);
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  /**
   * POST /execution/poll — advance EXECUTING jobs whose training finished.
   *
   * Exposed as an endpoint rather than only a timer so it can be driven by an
   * external scheduler, and so a stuck job can be nudged without a redeploy.
   */
  app.post('/poll', { onRequest: [requireServiceKey()] as never }, async (req) => {
    const { limit } = (req.body ?? {}) as { limit?: number };
    return { results: await pollExecution(limit) };
  });

  /** GET /execution/jobs/:jobId/progress — live counters from the worker. */
  app.get('/jobs/:jobId/progress', async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    const progress = await executionProgress(jobId);
    if (!progress) return reply.status(404).send({ error: 'Job not found' });
    return progress;
  });
}
