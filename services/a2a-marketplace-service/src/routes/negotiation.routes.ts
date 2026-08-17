/**
 * Negotiation routes.
 *
 * Reads are open so an external agent can inspect a transcript and verify it
 * independently. Writes go through the gateway's JWT and are additionally
 * bounded by the protocol itself — turn order, budget range and the hash chain
 * are enforced in @ai-arena/a2a-protocol, not here.
 */

import { FastifyInstance } from 'fastify';
import {
  appendOffer,
  getNegotiation,
  listForJob,
  openNegotiation,
  providerRespond,
  signAgreement,
} from '../negotiation.service';

export async function negotiationRoutes(app: FastifyInstance): Promise<void> {
  /** POST /negotiations — a provider opens a thread. Eligibility re-derived here. */
  app.post('/', async (req, reply) => {
    const { jobId, providerAgentId } = (req.body ?? {}) as Record<string, string>;
    if (!jobId || !providerAgentId) {
      return reply.status(400).send({ error: 'jobId and providerAgentId are required' });
    }
    try {
      return reply.status(201).send(await openNegotiation({ jobId, providerAgentId }));
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  /** POST /negotiations/:id/offers — append one signed offer. */
  app.post('/:id/offers', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, string>;
    if (!body.role || !body.kind) {
      return reply.status(400).send({ error: 'role and kind are required' });
    }
    try {
      return await appendOffer({
        negotiationId: id,
        role: body.role as never,
        kind: body.kind as never,
        priceBaseUnits: body.priceBaseUnits,
        note: body.note,
        ttlSeconds: body.ttlSeconds ? Number(body.ttlSeconds) : undefined,
      });
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  /**
   * POST /negotiations/:id/respond — the provider agent plays its own move.
   *
   * The autonomous path. Deterministic given the transcript and policy, so a
   * disputed negotiation can be replayed and the decision reproduced.
   */
  app.post('/:id/respond', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, string>;
    if (!body.floorBaseUnits) {
      return reply.status(400).send({ error: 'floorBaseUnits is required — a provider needs a floor' });
    }
    try {
      return await providerRespond({
        negotiationId: id,
        floorBaseUnits: body.floorBaseUnits,
        openingFraction: body.openingFraction ? Number(body.openingFraction) : undefined,
        concessionRate: body.concessionRate ? Number(body.concessionRate) : undefined,
      });
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  /** POST /negotiations/:id/agreement — both agents sign the agreed terms. */
  app.post('/:id/agreement', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await signAgreement(id);
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  /** GET /negotiations/:id — transcript plus live chain verification. */
  app.get('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const negotiation = await getNegotiation(id);
    if (!negotiation) return reply.status(404).send({ error: 'Negotiation not found' });
    return negotiation;
  });

  /** GET /negotiations?jobId=... — every thread on a job. */
  app.get('/', async (req, reply) => {
    const { jobId } = req.query as { jobId?: string };
    if (!jobId) return reply.status(400).send({ error: 'jobId is required' });
    return listForJob(jobId);
  });
}
