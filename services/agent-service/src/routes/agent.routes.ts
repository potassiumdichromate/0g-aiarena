import { FastifyInstance } from 'fastify';
import { AgentService } from '../services/agent.service';
import { jwtMiddleware } from '../middleware/jwt.middleware';

const agentService = new AgentService();

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', jwtMiddleware(app));

  app.post('/', async (req, reply) => {
    const { userId } = req.user as { userId: string };
    const body = req.body as { name: string; clan: string; archetype?: string; backstory?: string };
    const agent = await agentService.createAgent(userId, body);
    return reply.status(201).send({ agent });
  });

  app.get('/', async (req) => {
    const { clan, archetype, page, limit } = req.query as Record<string, string>;
    return agentService.listAgents({ clan, archetype, page: Number(page), limit: Number(limit) });
  });

  app.get('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const agent = await agentService.getAgent(id);
    if (!agent) return reply.status(404).send({ error: 'Agent not found' });
    return { agent };
  });

  app.put('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { userId } = req.user as { userId: string };
    const body = req.body as { name?: string; metadata?: Record<string, unknown> };
    const agent = await agentService.updateAgent(id, userId, body);
    return { agent };
  });

  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { userId } = req.user as { userId: string };
    await agentService.retireAgent(id, userId);
    return { success: true };
  });

  app.post('/:id/train', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { type?: string; priority?: number };
    const job = await agentService.queueTraining(id, body);
    return reply.status(202).send({ job });
  });

  app.get('/:id/training', async (req) => {
    const { id } = req.params as { id: string };
    return agentService.getTrainingStatus(id);
  });

  app.get('/:id/memory', async (req) => {
    const { id } = req.params as { id: string };
    return agentService.getMemorySummary(id);
  });

  app.post('/:id/clone', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { userId } = req.user as { userId: string };
    const clone = await agentService.cloneAgent(id, userId);
    return reply.status(201).send({ agent: clone });
  });

  app.get('/:id/evolution', async (req) => {
    const { id } = req.params as { id: string };
    return agentService.getEvolutionStatus(id);
  });
}
