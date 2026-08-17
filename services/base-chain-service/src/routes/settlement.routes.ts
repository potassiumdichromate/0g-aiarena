/**
 * Settlement routes — the relayed money path.
 *
 * All writes. Guarded by X-Service-Key at the service level (see main.ts):
 * these move real USDC and are not part of any public surface.
 */

import { FastifyInstance } from 'fastify';
import {
  claimTimeoutRefund,
  fundJob,
  markExecuting,
  refundClaimable,
  resolveDispute,
  submitDeliverable,
  submitVerdict,
} from '../settlement.service';

export async function settlementRoutes(app: FastifyInstance): Promise<void> {
  /** POST /settlement/jobs/:jobId/fund — commit the agreement and pull USDC. */
  app.post('/jobs/:jobId/fund', async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    const body = (req.body ?? {}) as Record<string, unknown>;

    const required = ['agreement', 'creatorSigner', 'creatorSignature', 'providerSigner', 'providerSignature', 'authorization'];
    const missing = required.filter((k) => !body[k]);
    if (missing.length) {
      return reply.status(400).send({ error: `missing required fields: ${missing.join(', ')}` });
    }

    try {
      return await fundJob({
        jobId,
        agreement: body.agreement as never,
        creatorSigner: body.creatorSigner as string,
        creatorSignature: body.creatorSignature as string,
        providerSigner: body.providerSigner as string,
        providerSignature: body.providerSignature as string,
        authorization: body.authorization as never,
      });
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  app.post('/jobs/:jobId/executing', async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    try {
      return await markExecuting(jobId);
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  app.post('/jobs/:jobId/deliverable', async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    const { deliverableHash } = (req.body ?? {}) as { deliverableHash?: string };
    if (!deliverableHash) return reply.status(400).send({ error: 'deliverableHash is required' });

    try {
      return await submitDeliverable(jobId, deliverableHash);
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  /**
   * POST /settlement/jobs/:jobId/verdict
   *
   * Requires VERIFIER_ROLE on-chain. In production that role belongs to the
   * evaluation service's key, NOT this relayer — so this endpoint is expected
   * to revert here and exists for single-key development setups only.
   */
  app.post('/jobs/:jobId/verdict', async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    const { accepted, reportHash } = (req.body ?? {}) as { accepted?: boolean; reportHash?: string };
    if (typeof accepted !== 'boolean' || !reportHash) {
      return reply.status(400).send({ error: 'accepted (boolean) and reportHash are required' });
    }

    try {
      return await submitVerdict(jobId, accepted, reportHash);
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  app.post('/jobs/:jobId/refund', async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    try {
      return await claimTimeoutRefund(jobId);
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  app.post('/jobs/:jobId/resolve-dispute', async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    const { toProviderBaseUnits, toCreatorBaseUnits } = (req.body ?? {}) as Record<string, string>;
    if (!toProviderBaseUnits || !toCreatorBaseUnits) {
      return reply.status(400).send({ error: 'toProviderBaseUnits and toCreatorBaseUnits are required' });
    }

    try {
      return await resolveDispute(jobId, toProviderBaseUnits, toCreatorBaseUnits);
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  /** GET /settlement/jobs/:jobId/refund-claimable — straight from the chain. */
  app.get('/jobs/:jobId/refund-claimable', async (req) => {
    const { jobId } = req.params as { jobId: string };
    return { jobId, claimable: await refundClaimable(jobId) };
  });
}
