import { prisma, TrainingRepository } from '@ai-arena/db-client';
import { getEventBus, SUBJECTS } from '@ai-arena/event-bus';

const trainingRepo = new TrainingRepository(prisma);

export class TrainingQueueService {
  async createJob(params: { agentId: string; type?: string; priority?: number; config?: Record<string, unknown> }) {
    const job = await trainingRepo.create({
      agent: { connect: { id: params.agentId } },
      type: (params.type as any) ?? 'BEHAVIOUR_CLONING',
      priority: params.priority ?? 5,
      config: params.config ?? {},
    });

    const bus = await getEventBus();
    await bus.publish(SUBJECTS.TRAINING_QUEUED, {
      jobId: job.id,
      agentId: params.agentId,
      priority: job.priority,
      occurredAt: new Date(),
    });

    return job;
  }

  async getJob(jobId: string) {
    return trainingRepo.findById(jobId);
  }

  async listJobs(agentId?: string, status?: string) {
    const where: Record<string, unknown> = {};
    if (agentId) where.agentId = agentId;
    if (status) where.status = status;
    const jobs = await prisma.trainingJob.findMany({ where: where as any, orderBy: { createdAt: 'desc' }, take: 50 });
    return { jobs };
  }

  async cancelJob(jobId: string) {
    return trainingRepo.cancel(jobId);
  }

  async checkEligibility(agentId: string) {
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) throw new Error('Agent not found');

    const runningJobs = await prisma.trainingJob.count({ where: { agentId, status: 'RUNNING' } });
    const totalBattles = agent.wins + agent.losses + agent.draws;

    return {
      eligible: runningJobs === 0 && totalBattles >= 5,
      reasons: {
        hasRunningJobs: runningJobs > 0,
        insufficientBattles: totalBattles < 5,
        totalBattles,
        runningJobs,
      },
    };
  }
}
