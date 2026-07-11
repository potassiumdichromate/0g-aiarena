import { FastifyInstance } from 'fastify';
import { prisma } from '@ai-arena/db-client';
import { AgentService } from '../services/agent.service';
import { AchievementService } from '../services/achievement.service';
import { jwtMiddleware } from '../middleware/jwt.middleware';

const agentService = new AgentService();
const achievementService = new AchievementService();

/**
 * One agent per wallet (User.walletAddress is unique per User row, so this
 * is effectively 1-agent-per-wallet). Counts ALL agents including retired
 * ones -- otherwise retiring and re-minting would let a wallet farm the 100
 * ARENA agent-mint reward repeatedly. Not enforced inside
 * AgentService.createAgent itself because the OKX Agent Marketplace bridge
 * creates every one of its agents under one shared system wallet by design
 * (see okx-bridge.service.ts) and must stay unaffected by this cap.
 */
async function assertWalletCanMint(userId: string, reply: any): Promise<boolean> {
  const existingCount = await prisma.agent.count({ where: { userId } });
  if (existingCount > 0) {
    reply.status(409).send({ error: 'This wallet has already minted an agent — only one agent is allowed per wallet.' });
    return false;
  }
  return true;
}

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

  // ── Autonomous mode config ───────────────────────────────────────────────────
  app.get('/:id/autonomous', { onRequest: [optionalJwt(app)] as any }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await agentService.getAutonomousConfig(id);
    } catch (err: any) {
      return reply.status(404).send({ error: err.message });
    }
  });

  app.post('/:id/autonomous', { onRequest: [jwtMiddleware(app)] as any }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as {
      autonomousMode: boolean;
      gameId?:        string;
      mode?:          string;
      eloRange?:      number;
      strategy?:      string;
      autoTrain?:     boolean;
    };
    try {
      return await agentService.setAutonomousConfig(id, body);
    } catch (err: any) {
      return reply.status(404).send({ error: err.message });
    }
  });

  // GET /agents/:id/achievements — computed achievement data for this agent
  app.get('/:id/achievements', { onRequest: [optionalJwt(app)] as any }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const result = await achievementService.computeForAgent(id);
    if (!result) return reply.status(404).send({ error: 'Agent not found' });
    return result;
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

    if (!(await assertWalletCanMint(userId, reply))) return;

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

    if (!(await assertWalletCanMint(userId, reply))) return;

    const clone = await agentService.cloneAgent(id, userId);
    return reply.status(201).send({ agent: clone });
  });

  /**
   * POST /v1/agents/:id/evolve-traits
   *
   * Update this agent's traits based on their actual battle performance.
   * Called by the React client immediately after POST /v1/battles/:id/end.
   * Accepts the raw playerStats Unity recorded during the match.
   *
   * No JWT guard — the React client calls this right after endBattle.
   * (Add jwtMiddleware if you want server-side ownership enforcement.)
   */
  app.post('/:id/evolve-traits', { onRequest: [optionalJwt(app)] as any }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as {
      outcome:         'WIN' | 'LOSS';
      jumps:           number;
      shotsAttempted:  number;
      shotsConnected:  number;
      timesHit:        number;
      distanceCovered: number;
      durationSeconds: number;
    };

    if (!body?.outcome || !['WIN', 'LOSS'].includes(body.outcome)) {
      return reply.status(400).send({ error: 'outcome must be WIN or LOSS' });
    }

    try {
      const result = await agentService.evolveTraits(id, {
        outcome:         body.outcome,
        jumps:           Number(body.jumps ?? 0),
        shotsAttempted:  Number(body.shotsAttempted ?? 0),
        shotsConnected:  Number(body.shotsConnected ?? 0),
        timesHit:        Number(body.timesHit ?? 0),
        distanceCovered: Number(body.distanceCovered ?? 0),
        durationSeconds: Number(body.durationSeconds ?? 0),
      });
      return reply.status(200).send(result);
    } catch (err: any) {
      return reply.status(404).send({ error: err.message });
    }
  });
}
