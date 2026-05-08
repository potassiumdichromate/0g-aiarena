import { PrismaClient, TrainingJob, Prisma } from '@prisma/client';

export class TrainingRepository {
  constructor(private readonly db: PrismaClient) {}

  async create(data: Prisma.TrainingJobCreateInput): Promise<TrainingJob> {
    return this.db.trainingJob.create({ data });
  }

  async findById(id: string): Promise<TrainingJob | null> {
    return this.db.trainingJob.findUnique({ where: { id } });
  }

  async findByAgent(agentId: string, page = 1, limit = 10): Promise<TrainingJob[]> {
    return this.db.trainingJob.findMany({
      where: { agentId },
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
    });
  }

  async getNextQueued(): Promise<TrainingJob | null> {
    return this.db.trainingJob.findFirst({
      where: { status: 'QUEUED' },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    });
  }

  async updateStatus(id: string, status: string, data?: Partial<Prisma.TrainingJobUpdateInput>): Promise<TrainingJob> {
    return this.db.trainingJob.update({
      where: { id },
      data: {
        status: status as any,
        ...(status === 'RUNNING' && { startedAt: new Date() }),
        ...((['COMPLETED', 'FAILED', 'CANCELLED'].includes(status)) && { completedAt: new Date() }),
        ...data,
      },
    });
  }

  async cancel(id: string): Promise<TrainingJob> {
    return this.updateStatus(id, 'CANCELLED');
  }
}
