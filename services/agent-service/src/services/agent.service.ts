import { prisma, AgentRepository } from '@ai-arena/db-client';
import { getEventBus, SUBJECTS } from '@ai-arena/event-bus';
import { getZeroGConfig, ZeroGComputeClient } from '@ai-arena/zerog-client';

const agentRepo = new AgentRepository(prisma);

export class AgentService {
  private readonly computeClient = new ZeroGComputeClient(getZeroGConfig());

  async createAgent(userId: string, params: {
    name: string;
    clan: string;
    archetype?: string;
    backstory?: string;
  }) {
    // Generate personality via 0G Compute
    let traits: Record<string, unknown> = {
      aggression: 50, patience: 50, adaptability: 50,
      riskTolerance: 50, teamwork: 50, creativity: 50, endurance: 50, precision: 50,
    };

    if (process.env.USE_0G_COMPUTE === 'true') {
      try {
        traits = await this.computeClient.generatePersonality(`${params.name}-${params.clan}`);
      } catch (err) {
        console.warn('0G Compute unavailable, using default traits');
      }
    }

    const agent = await agentRepo.create({
      user: { connect: { id: userId } },
      name: params.name,
      clan: params.clan as any,
      archetype: (params.archetype as any) ?? 'HYBRID',
      traits,
      metadata: { backstory: params.backstory ?? '' },
    });

    const bus = await getEventBus();
    await bus.publish(SUBJECTS.AGENT_CREATED, { agentId: agent.id, userId });

    return agent;
  }

  async getAgent(id: string) {
    return agentRepo.findByIdWithRelations(id);
  }

  async listAgents(params: { clan?: string; archetype?: string; page?: number; limit?: number }) {
    return agentRepo.list(params);
  }

  async updateAgent(id: string, userId: string, data: { name?: string; metadata?: Record<string, unknown> }) {
    return agentRepo.update(id, data);
  }

  async retireAgent(id: string, userId: string) {
    return agentRepo.retire(id);
  }

  async queueTraining(agentId: string, params: { type?: string; priority?: number }) {
    return prisma.trainingJob.create({
      data: {
        agent: { connect: { id: agentId } },
        type: (params.type as any) ?? 'BEHAVIOUR_CLONING',
        priority: params.priority ?? 5,
        config: {},
      },
    });
  }

  async getTrainingStatus(agentId: string) {
    const jobs = await prisma.trainingJob.findMany({
      where: { agentId },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
    return { jobs };
  }

  async getMemorySummary(agentId: string) {
    const count = await prisma.agentMemory.count({ where: { agentId } });
    const recent = await prisma.agentMemory.findMany({
      where: { agentId },
      orderBy: { lastAccessed: 'desc' },
      take: 5,
    });
    return { totalMemories: count, recentMemories: recent };
  }

  async cloneAgent(sourceId: string, userId: string) {
    const source = await agentRepo.findById(sourceId);
    if (!source) throw new Error('Source agent not found');
    return agentRepo.create({
      user: { connect: { id: userId } },
      name: `${source.name} (Clone)`,
      clan: source.clan,
      archetype: source.archetype,
      traits: source.traits as any,
      metadata: source.metadata as any,
    });
  }

  async getEvolutionStatus(agentId: string) {
    const agent = await agentRepo.findById(agentId);
    if (!agent) throw new Error('Agent not found');
    return {
      currentStage: agent.evolutionStage,
      totalBattles: agent.wins + agent.losses + agent.draws,
      eloRating: agent.eloRating,
      eligibleForEvolution: agent.wins >= 10 && agent.eloRating >= 1200,
    };
  }
}
