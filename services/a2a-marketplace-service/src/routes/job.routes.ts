/**
 * Job routes.
 *
 * Two-step creation is intentional: POST /jobs/draft parses and stages,
 * POST /jobs/:id/confirm publishes to Base. The parsed document is what the
 * escrow settles against, so the author confirms the interpretation before it
 * becomes a commitment.
 */

import { FastifyInstance } from 'fastify';
import { requireAuth, assertOwnsAgent, assertOwnsJobCreator } from '../middleware/auth';
import {
  confirmAndPost,
  listJobs,
  createDraft,
  getJob,
  getRequirementsDocument,
  listOpenJobs,
  parsePrompt,
} from '../job.service';

export async function jobRoutes(app: FastifyInstance): Promise<void> {
  /** POST /jobs/parse — preview an interpretation without storing anything. */
  app.post('/parse', { onRequest: [requireAuth(app)] as never }, async (req, reply) => {
    const { prompt } = (req.body ?? {}) as { prompt?: string };
    if (!prompt?.trim()) return reply.status(400).send({ error: 'prompt is required' });
    return parsePrompt(prompt);
  });

  /** POST /jobs/draft — parse, validate and stage. Nothing on-chain yet. */
  app.post('/draft', { onRequest: [requireAuth(app)] as never }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, never>;
    const required = ['creatorAgentId', 'prompt', 'budgetMin', 'budgetMax'] as const;
    const missing = required.filter((k) => !body[k]);
    if (missing.length) {
      return reply.status(400).send({ error: `missing required fields: ${missing.join(', ')}` });
    }

    // Without this, any caller could post a job as somebody else's agent.
    if (!(await assertOwnsAgent(req, reply, String(body.creatorAgentId)))) return;

    try {
      return reply.status(201).send(await createDraft(body as never));
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  /** POST /jobs/:jobId/confirm — publish the confirmed draft to Base. */
  app.post('/:jobId/confirm', { onRequest: [requireAuth(app)] as never }, async (req, reply) => {
    const { jobId } = req.params as { jobId: string };

    // Confirming spends gas and commits the job on-chain — creator only.
    if (!(await assertOwnsJobCreator(req, reply, jobId))) return;
    try {
      return await confirmAndPost(jobId);
    } catch (err) {
      return reply.status(502).send({ error: (err as Error).message });
    }
  });

  /** GET /jobs — open job feed. */
  app.get('/', async (req) => {
    const { gameId, limit, scope } = req.query as {
      gameId?: string; limit?: string; scope?: 'open' | 'active' | 'completed' | 'all';
    };
    return listJobs({ gameId, limit: limit ? Number(limit) : undefined, scope });
  });

  /** GET /jobs/:jobId — off-chain record, hash verification, and the chain's view. */
  app.get('/:jobId', async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    const result = await getJob(jobId);
    if (!result) return reply.status(404).send({ error: 'Job not found' });
    return result;
  });

  /**
   * GET /jobs/:jobId/requirements.json
   *
   * The EXACT canonical bytes whose keccak256 is committed on-chain. Served
   * verbatim from storage, never re-serialized — re-emitting here would hide
   * precisely the drift this endpoint exists to let anyone detect.
   */
  app.get('/:jobId/requirements.json', async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    const document = await getRequirementsDocument(jobId);
    if (!document) return reply.status(404).send({ error: 'Job not found' });

    return reply
      .header('Content-Type', 'application/json')
      .header('Cache-Control', 'public, max-age=60')
      .send(document);
  });
}
