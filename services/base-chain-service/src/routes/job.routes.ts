/**
 * On-chain job routes.
 *
 * Reads are open (everything is already public on Base); writes require
 * X-Service-Key and are called by the marketplace service, never by a browser.
 */

import { FastifyInstance } from 'fastify';
import { postJob, readJob, cancelJob, jobEscrowAddress } from '../job.service';

export async function jobRoutes(app: FastifyInstance): Promise<void> {
  /** GET /jobs/:jobId — the chain's own view, independent of our database. */
  app.get('/:jobId', async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    try {
      const job = await readJob(jobId);
      if (!job.exists) return reply.status(404).send({ error: 'Job not registered on Base' });
      return job;
    } catch (err) {
      return reply.status(502).send({ error: (err as Error).message });
    }
  });

  /** POST /jobs — register a job. Idempotent on jobId. */
  app.post('/', async (req, reply) => {
    const body = req.body as {
      jobId?: string; creatorAgentId?: string; creatorWallet?: string;
      requirementsHash?: string; budgetMinBaseUnits?: string;
      budgetMaxBaseUnits?: string; executionWindowSeconds?: number;
    };

    const missing = ([
      'jobId', 'creatorAgentId', 'creatorWallet', 'requirementsHash',
      'budgetMinBaseUnits', 'budgetMaxBaseUnits', 'executionWindowSeconds',
    ] as const).filter((k) => body?.[k] === undefined || body[k] === null);

    if (missing.length) {
      return reply.status(400).send({ error: `missing required fields: ${missing.join(', ')}` });
    }

    try {
      const result = await postJob({
        jobId: body.jobId!,
        creatorAgentId: body.creatorAgentId!,
        creatorWallet: body.creatorWallet!,
        requirementsHash: body.requirementsHash!,
        budgetMinBaseUnits: body.budgetMinBaseUnits!,
        budgetMaxBaseUnits: body.budgetMaxBaseUnits!,
        executionWindowSeconds: Number(body.executionWindowSeconds),
      });
      return reply.status(result.alreadyOnChain ? 200 : 201).send(result);
    } catch (err) {
      return reply.status(502).send({ error: (err as Error).message });
    }
  });

  /** POST /jobs/:jobId/cancel — withdraw an unfunded job. */
  app.post('/:jobId/cancel', async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    try {
      return await cancelJob(jobId);
    } catch (err) {
      return reply.status(502).send({ error: (err as Error).message });
    }
  });

  /** GET /jobs/_contract — the escrow address, for explorer links. */
  app.get('/_contract', async (_req, reply) => {
    try {
      return { address: jobEscrowAddress(), explorer: `https://basescan.org/address/${jobEscrowAddress()}` };
    } catch (err) {
      return reply.status(503).send({ error: (err as Error).message });
    }
  });
}
