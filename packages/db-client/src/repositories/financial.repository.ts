import { PrismaClient, AgentWallet, EscrowRecord, LedgerEntry, Prisma } from '@prisma/client';

export class FinancialRepository {
  constructor(private readonly db: PrismaClient) {}

  async createWallet(data: Prisma.AgentWalletCreateInput): Promise<AgentWallet> {
    return this.db.agentWallet.create({ data });
  }

  async getWallet(agentId: string): Promise<AgentWallet | null> {
    return this.db.agentWallet.findUnique({ where: { agentId } });
  }

  async updateBalance(agentId: string, deltaArena: number, deltaSol: number): Promise<AgentWallet> {
    return this.db.agentWallet.update({
      where: { agentId },
      data: {
        balanceArena: { increment: deltaArena },
        balanceSol: { increment: deltaSol },
      },
    });
  }

  async freezeWallet(agentId: string, frozen: boolean): Promise<AgentWallet> {
    return this.db.agentWallet.update({
      where: { agentId },
      data: { isFrozen: frozen },
    });
  }

  async createEscrow(data: Prisma.EscrowRecordCreateInput): Promise<EscrowRecord> {
    return this.db.escrowRecord.create({ data });
  }

  async getEscrow(id: string): Promise<EscrowRecord | null> {
    return this.db.escrowRecord.findUnique({ where: { id } });
  }

  async updateEscrowState(id: string, state: string, data?: Partial<Prisma.EscrowRecordUpdateInput>): Promise<EscrowRecord> {
    return this.db.escrowRecord.update({
      where: { id },
      data: { state: state as any, ...data },
    });
  }

  async createLedgerEntry(data: Prisma.LedgerEntryCreateInput): Promise<LedgerEntry> {
    return this.db.ledgerEntry.create({ data });
  }

  async getLedgerEntries(walletId: string, page = 1, limit = 20): Promise<LedgerEntry[]> {
    return this.db.ledgerEntry.findMany({
      where: { walletId },
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: 'desc' },
    });
  }
}
