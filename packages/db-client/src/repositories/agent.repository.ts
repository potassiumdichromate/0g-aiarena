import { PrismaClient, Agent, Prisma } from '@prisma/client';

export class AgentRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(data: Prisma.AgentCreateInput): Promise<Agent> {
    return this.db.agent.create({ data });
  }

  async findById(id: string): Promise<Agent | null> {
    return this.db.agent.findUnique({ where: { id } });
  }

  async findByIdWithRelations(id: string) {
    return this.db.agent.findUnique({
      where: { id },
      include: {
        user: true,
        aiModels: { where: { isActive: true }, take: 1 },
        trainingJobs: { orderBy: { createdAt: 'desc' }, take: 5 },
        wallet: true,
      },
    });
  }

  async findByUserId(userId: string, page = 1, limit = 20): Promise<Agent[]> {
    return this.db.agent.findMany({
      where: { userId, isRetired: false },
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { eloRating: 'desc' },
    });
  }

  async list(params: {
    clan?: string;
    archetype?: string;
    page?: number;
    limit?: number;
    sortBy?: string;
  }): Promise<{ agents: Agent[]; total: number }> {
    const { clan, archetype, page = 1, limit = 20 } = params;
    const where: Prisma.AgentWhereInput = {
      isRetired: false,
      ...(clan && { clan: clan as any }),
      ...(archetype && { archetype: archetype as any }),
    };

    const [agents, total] = await Promise.all([
      this.db.agent.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { eloRating: 'desc' },
      }),
      this.db.agent.count({ where }),
    ]);

    return { agents, total };
  }

  async update(id: string, data: Prisma.AgentUpdateInput): Promise<Agent> {
    return this.db.agent.update({ where: { id }, data });
  }

  async retire(id: string): Promise<Agent> {
    return this.db.agent.update({ where: { id }, data: { isRetired: true } });
  }

  async updateElo(id: string, newElo: number, outcome: 'WIN' | 'LOSS' | 'DRAW'): Promise<Agent> {
    return this.db.agent.update({
      where: { id },
      data: {
        eloRating: newElo,
        wins: outcome === 'WIN' ? { increment: 1 } : undefined,
        losses: outcome === 'LOSS' ? { increment: 1 } : undefined,
        draws: outcome === 'DRAW' ? { increment: 1 } : undefined,
      },
    });
  }

  async count(where?: Prisma.AgentWhereInput): Promise<number> {
    return this.db.agent.count({ where });
  }
}
