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

  // GET /agents/mine — agents belonging to the authenticated user
  app.get('/mine', { onRequest: [jwtMiddleware(app)] as any }, async (req) => {
    const { userId } = req.user as { userId: string };
    const { page, pageSize, limit } = req.query as Record<string, string>;
    return agentService.listAgentsByUser(userId, {
      page:  Number(page  || 1),
      limit: Number(limit || pageSize || 50),
    });
  });

  // GET /agents/training-job/:jobId — fetch a training job by its own ID
  // (Must appear before /:id to avoid being shadowed by the agent-by-id route)
  app.get('/training-job/:jobId', { onRequest: [optionalJwt(app)] as any }, async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    const job = await agentService.getTrainingJobById(jobId);
    if (!job) return reply.status(404).send({ error: 'Training job not found' });
    return { job };
  });

  // DELETE /agents/training-job/:jobId — cancel a training job by its own ID
  app.delete('/training-job/:jobId', { onRequest: [jwtMiddleware(app)] as any }, async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    try {
      const job = await agentService.cancelTrainingJobById(jobId);
      return { job, cancelled: true };
    } catch (err: any) {
      return reply.status(404).send({ error: err.message });
    }
  });

  // GET /agents/all-training — list recent training jobs across all agents
  app.get('/all-training', { onRequest: [optionalJwt(app)] as any }, async (req) => {
    const { limit } = req.query as { limit?: string };
    return agentService.listAllTrainingJobs(Number(limit) || 20);
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

  // GET /agents/:id/eligibility — training eligibility (alias for evolution status)
  // Also reachable via gateway as GET /v1/training/agents/:id/eligibility
  app.get('/:id/eligibility', { onRequest: [optionalJwt(app)] as any }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const evolution = await agentService.getEvolutionStatus(id);
    const jobs      = await agentService.getTrainingStatus(id);
    const running   = jobs.some((j: any) => j.status === 'QUEUED' || j.status === 'RUNNING');
    return {
      agentId:           id,
      eligibleToTrain:   !running,
      reason:            running ? 'Training job already in progress' : 'Ready to train',
      currentStage:      evolution.currentStage,
      eloRating:         evolution.eloRating,
      totalBattles:      evolution.totalBattles,
      activeJobCount:    jobs.filter((j: any) => j.status === 'RUNNING').length,
      queuedJobCount:    jobs.filter((j: any) => j.status === 'QUEUED').length,
    };
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
    const body = req.body as { type?: string; priority?: number; config?: Record<string, unknown> };
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
