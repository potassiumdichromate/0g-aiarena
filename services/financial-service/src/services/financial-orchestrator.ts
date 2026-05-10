import { prisma, FinancialRepository } from '@ai-arena/db-client';
import { getEventBus } from '@ai-arena/event-bus';

const finRepo = new FinancialRepository(prisma);

export class FinancialOrchestrator {
  async getWallet(agentId: string) {
    return finRepo.getWallet(agentId);
  }

  async updatePolicy(agentId: string, policy: Record<string, unknown>) {
    return finRepo.createWallet({
      agent: { connect: { id: agentId } },
      solanaAddress: 'placeholder',
      policy: policy as any,
    });
  }

  async processDeposit(agentId: string, amount: number, currency: string, txHash: string) {
    const wallet = await finRepo.getWallet(agentId);
    if (!wallet) throw new Error('Wallet not found');

    await finRepo.updateBalance(agentId, currency === 'ARENA' ? amount : 0, currency === 'SOL' ? amount : 0);
    await finRepo.createLedgerEntry({
      wallet: { connect: { id: wallet.id } },
      type: 'DEPOSIT',
      amount,
      currency,
      status: 'CONFIRMED',
      txHash,
    });
    return { success: true };
  }

  async initiateWithdrawal(agentId: string, amount: number, destination: string) {
    return { status: 'PENDING', agentId, amount, destination };
  }

  async getTransactions(agentId: string, page: number, limit: number) {
    const wallet = await finRepo.getWallet(agentId);
    if (!wallet) return { transactions: [] };
    const entries = await finRepo.getLedgerEntries(wallet.id, page, limit);
    return { transactions: entries };
  }

  async createStake(agentId: string, amount: number) {
    return prisma.stakingRecord.create({
      data: { agent: { connect: { id: agentId } }, amount },
    });
  }

  async getStakes(agentId: string) {
    const stakes = await prisma.stakingRecord.findMany({ where: { agentId, isActive: true } });
    return { stakes };
  }
}
