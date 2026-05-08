import { PrismaClient } from '@prisma/client';

// Singleton Prisma client
declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

export const prisma: PrismaClient =
  global.__prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  global.__prisma = prisma;
}

export { PrismaClient };
export * from '@prisma/client';

export { AgentRepository } from './repositories/agent.repository';
export { BattleRepository } from './repositories/battle.repository';
export { FinancialRepository } from './repositories/financial.repository';
export { TrainingRepository } from './repositories/training.repository';
