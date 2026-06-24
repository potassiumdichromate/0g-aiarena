import { FastifyInstance } from 'fastify';
import { OkxBridgeService } from '../services/okx-bridge.service';
import { okxServiceMiddleware } from '../middleware/okx.middleware';

const okxBridge = new OkxBridgeService();

export async function okxRoutes(app: FastifyInstance): Promise<void> {
  /**
   * POST /okx/create-agent  (public path: /v1/okx/create-agent via gateway)
   *
   * A2MCP "create arena agent" service for the OKX Agent Marketplace.
   * Auth: X-OKX-Service-Key header (see okxServiceMiddleware) — not the user
   * JWT, since the caller is OKX's infra on a paying customer's behalf, not
   * an AI Arena account.
   *
   * Returns fast (traits + backstory + DB row) without waiting on avatar
   * generation, which completes asynchronously via the existing pipeline.
   */
  app.post('/create-agent', { onRequest: [okxServiceMiddleware] as any }, async (req, reply) => {
    const body = req.body as {
      name?: string;
      clan?: string;
      archetype?: string;
      backstory?: string;
      idempotencyKey?: string;
    };

    if (!body?.name || !body?.clan) {
      return reply.status(400).send({ error: 'name and clan are required' });
    }
    if (!body?.idempotencyKey) {
      return reply.status(400).send({ error: 'idempotencyKey is required' });
    }

    try {
      const { agent, replay } = await okxBridge.createAgentForOkx({
        name:           body.name,
        clan:           body.clan,
        archetype:      body.archetype,
        backstory:      body.backstory,
        idempotencyKey: body.idempotencyKey,
      });

      return reply.status(replay ? 200 : 201).send({
        agentId:        (agent as any).id,
        name:           (agent as any).name,
        clan:           (agent as any).clan,
        archetype:      (agent as any).archetype,
        traits:         (agent as any).traits,
        backstory:      (agent as any).metadata?.backstory ?? '',
        inftTokenId:    (agent as any).inftTokenId ?? null,
        avatarStatus:   (agent as any).metadata?.avatarRootHash ? 'ready' : 'pending',
        avatarRootHash: (agent as any).metadata?.avatarRootHash ?? null,
      });
    } catch (err: any) {
      if (err.message?.includes('already being processed')) {
        return reply.status(409).send({ error: err.message });
      }
      app.log.error(err);
      return reply.status(500).send({ error: 'Agent creation failed' });
    }
  });
}
