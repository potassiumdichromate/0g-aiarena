/**
 * evaluation-service — the verifier.
 *
 * Holds VERIFIER_ROLE and nothing else. Separate service and separate key from
 * base-chain-service's relayer by design: one drives a job's state, the other
 * judges its outcome (threat T3).
 *
 * Verdicts are never based on a number the provider supplied. The Python
 * evaluation worker independently re-runs the seeded harness against the
 * delivered checkpoint under a fresh seed root; this service settles on that.
 */

import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { pendingVerdicts, roleCheck, verifierAddress, verifyAndSettle } from './verifier.service';

const PORT = parseInt(process.env.PORT ?? '8081', 10);
const SERVICE_NAME = 'evaluation-service';

async function bootstrap(): Promise<void> {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: true });
  await app.register(helmet);

  // Everything except /health moves real money or reveals the verifier key's
  // address; internal callers only.
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.url.startsWith('/health')) return;
    const provided = req.headers['x-service-key'];
    const expected = process.env.INTERNAL_SERVICE_SECRET;
    if (!expected || provided !== expected) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }
  });

  /**
   * Reports whether this key actually holds VERIFIER_ROLE. A misconfigured
   * verifier looks healthy right up until the first verdict reverts, so the
   * role check is part of the health signal rather than a separate endpoint.
   */
  app.get('/health', async () => {
    let role: unknown = null;
    try {
      role = await roleCheck();
    } catch (err) {
      role = { error: (err as Error).message };
    }
    return { status: 'ok', service: SERVICE_NAME, role };
  });

  app.get('/pending', async (req) => {
    const { limit } = req.query as { limit?: string };
    return { pending: await pendingVerdicts(limit ? Number(limit) : undefined) };
  });

  app.post('/jobs/:jobId/verify', async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    try {
      return await verifyAndSettle(jobId);
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }
  });

  await app.listen({ port: PORT, host: '0.0.0.0' });
  app.log.info(`${SERVICE_NAME} listening on :${PORT} as verifier ${safeAddress()}`);
}

function safeAddress(): string {
  try { return verifierAddress(); } catch { return '(A2A_VERIFIER_PRIVATE_KEY not set)'; }
}

bootstrap().catch((err) => {
  console.error(`[${SERVICE_NAME}] Failed to start:`, err);
  process.exit(1);
});
