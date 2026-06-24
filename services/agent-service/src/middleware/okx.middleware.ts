import { FastifyRequest, FastifyReply } from 'fastify';

/**
 * Auth guard for the OKX Agent Marketplace bridge.
 *
 * This is a separate trust boundary from both jwtMiddleware (logged-in AI Arena
 * users) and the internal X-Service-Key (service-to-service calls between our
 * own microservices). OKX is an external, billed caller — it gets its own key
 * so it can be rotated/revoked independently of either of those.
 */
export async function okxServiceMiddleware(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const provided = req.headers['x-okx-service-key'];
  const expected = process.env.OKX_SERVICE_KEY;

  if (!expected) {
    reply.status(503).send({ error: 'OKX bridge not configured' });
    return;
  }

  if (provided !== expected) {
    reply.status(401).send({ error: 'Unauthorized' });
  }
}
