/**
 * Agent identity, proxied for browser callers.
 *
 * base-chain-service holds the relayer key, so every write there is gated
 * behind X-Service-Key — an internal secret a browser cannot hold and must
 * never be given. Registration is nonetheless a user-initiated action, so it
 * needs a user-facing entry point.
 *
 * This service is that entry point: it authenticates the user, confirms they
 * own the agent, and only then calls base-chain-service with the internal
 * secret. The trust boundary is preserved — the browser proves who it is, and
 * the key stays server-side.
 */

import { FastifyInstance } from 'fastify';
import { requireAuth, assertOwnsAgent } from '../middleware/auth';

const BASE_CHAIN_SERVICE_URL = process.env.BASE_CHAIN_SERVICE_URL ?? 'http://localhost:8051';

export async function identityRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /agents/:agentId/register-identity
   *
   * Mint the agent an ERC-8004 identity on Base. Idempotent upstream, so a
   * double submit returns the existing identity rather than minting twice.
   */
  app.post('/:agentId/register-identity', { onRequest: [requireAuth(app)] as never }, async (req, reply) => {
    const { agentId } = req.params as { agentId: string };

    const agent = await assertOwnsAgent(req, reply, agentId);
    if (!agent) return;

    try {
      const response = await fetch(`${BASE_CHAIN_SERVICE_URL}/identity/agents/${agentId}/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Service-Key': process.env.INTERNAL_SERVICE_SECRET ?? '',
        },
      });

      const body = await response.json();
      if (!response.ok) {
        // Surface the upstream reason rather than a generic failure — these
        // messages are written to be shown to users.
        return reply.status(response.status === 401 ? 502 : response.status).send(body);
      }

      return reply.status(201).send(body);
    } catch (err) {
      return reply.status(502).send({ error: `Registration service unreachable: ${(err as Error).message}` });
    }
  });

  /**
   * GET /agents/:agentId/identity
   *
   * Read-only passthrough. Open, like every other read here: an agent's
   * on-chain identity is public information.
   */
  app.get('/:agentId/identity', async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    try {
      const response = await fetch(`${BASE_CHAIN_SERVICE_URL}/identity/agents/${agentId}`);
      if (!response.ok) return reply.status(response.status).send(await response.json());
      return response.json();
    } catch (err) {
      return reply.status(502).send({ error: (err as Error).message });
    }
  });
}
