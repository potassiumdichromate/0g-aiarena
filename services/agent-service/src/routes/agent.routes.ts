import { FastifyInstance } from 'fastify';
import { AgentService } from '../services/agent.service';
import { jwtMiddleware } from '../middleware/jwt.middleware';

const agentService = new AgentService();

// ── Optional JWT: reads req.user if token present, doesn't reject if absent ──
function optionalJwt(app: FastifyInstance) {
  return async (req: any, _reply: any) => {
    try { await req.jwtVerify(); } catch { /* unauthenticated — ok for reads */ }
  };
}

export async function agentRoutes(app: FastifyInstance): Promise<void> {

  // ── Public reads ────────────────────────────────────────────────────────────
  app.get('/', { onRequest: [optionalJwt(app)] as any }, async (req) => {
    const { clan, archetype, page, pageSize, limit } = req.query as Record<string, string>;
    return agentService.listAgents({
      clan,
      archetype,
      page:  Number(page  || 1),
      limit: Number(limit || pageSize || 20),
    });
  });

  app.get('/:id', { onRequest: [optionalJwt(app)] as any }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const agent = await agentService.getAgent(id);
    if (!agent) return reply.status(404).send({ error: 'Agent not found' });
    return { agent };
  });

  app.get('/:id/training', { onRequest: [optionalJwt(app)] as any }, async (req) => {
    const { id } = req.params as { id: string };
    return agentService.getTrainingStatus(id);
  });

  app.get('/:id/memory', { onRequest: [optionalJwt(app)] as any }, async (req) => {
    const { id } = req.params as { id: string };
    return agentService.getMemorySummary(id);
  });

  app.get('/:id/evolution', { onRequest: [optionalJwt(app)] as any }, async (req) => {
    const { id } = req.params as { id: string };
    return agentService.getEvolutionStatus(id);
  });

  // ── Protected writes (require JWT) ─────────────────────────────────────────
  app.post('/', { onRequest: [jwtMiddleware(app)] as any }, async (req, reply) => {
    const { userId } = req.user as { userId: string };
    const body = req.body as { name: string; clan: string; archetype?: string; backstory?: string };
    const agent = await agentService.createAgent(userId, body);
    return reply.status(201).send({ agent });
  });

  app.put('/:id', { onRequest: [jwtMiddleware(app)] as any }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { userId } = req.user as { userId: string };
    const body = req.body as { name?: string; metadata?: Record<string, unknown> };
    const agent = await agentService.updateAgent(id, userId, body);
    return { agent };
  });

  app.delete('/:id', { onRequest: [jwtMiddleware(app)] as any }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { userId } = req.user as { userId: string };
    await agentService.retireAgent(id, userId);
    return { success: true };
  });

  app.post('/:id/train', { onRequest: [jwtMiddleware(app)] as any }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { type?: string; priority?: number };
    const job = await agentService.queueTraining(id, body);
    return reply.status(202).send({ job });
  });

  app.post('/:id/clone', { onRequest: [jwtMiddleware(app)] as any }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { userId } = req.user as { userId: string };
    const clone = await agentService.cloneAgent(id, userId);
    return reply.status(201).send({ agent: clone });
  });
}
