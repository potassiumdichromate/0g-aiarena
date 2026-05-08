import { PrismaClient, Battle, Prisma } from '@prisma/client';

export class BattleRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(data: Prisma.BattleCreateInput): Promise<Battle> {
    return this.db.battle.create({ data });
  }

  async findById(id: string): Promise<Battle | null> {
    return this.db.battle.findUnique({ where: { id } });
  }

  async findByAgent(agentId: string, page = 1, limit = 20): Promise<Battle[]> {
    return this.db.battle.findMany({
      where: { agentIds: { has: agentId } },
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
    });
  }

  async updateStatus(id: string, status: string, data?: Partial<Prisma.BattleUpdateInput>): Promise<Battle> {
    return this.db.battle.update({
      where: { id },
      data: { status: status as any, ...data },
    });
  }

  async setResult(id: string, result: Record<string, unknown>): Promise<Battle> {
    return this.db.battle.update({
      where: { id },
      data: {
        result,
        status: 'COMPLETED',
        endedAt: new Date(),
      },
    });
  }

  async list(params: { gameId?: string; status?: string; page?: number; limit?: number }) {
    const { gameId, status, page = 1, limit = 20 } = params;
    const where: Prisma.BattleWhereInput = {
      ...(gameId && { gameId }),
      ...(status && { status: status as any }),
    };
    const [battles, total] = await Promise.all([
      this.db.battle.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.db.battle.count({ where }),
    ]);
    return { battles, total };
  }
}
