import { prisma, FinancialRepository } from '@ai-arena/db-client';
import { getEventBus, SUBJECTS } from '@ai-arena/event-bus';

const finRepo = new FinancialRepository(prisma);

export class FinancialOrchestrator {
  async getWallet(agentId: string) {
    return finRepo.getWallet(agentId);
  }

  // Fix: update the wallet policy in-place instead of creating a duplicate wallet
  async updatePolicy(agentId: string, policy: Record<string, unknown>) {
    const existing = await finRepo.getWallet(agentId);
    if (!existing) throw new Error('Wallet not found for agent ' + agentId);
    return prisma.agentWallet.update({
      where: { agentId },
      data: { policy: policy as any },
    });
  }

  async processDeposit(agentId: string, amount: number, currency: string, txHash: string) {
    const wallet = await finRepo.getWallet(agentId);
    if (!wallet) throw new Error('Wallet not found');

    if (wallet.isFrozen) throw new Error('Wallet is frozen');

    await finRepo.updateBalance(
      agentId,
      currency === 'ARENA' ? amount : 0,
      currency === 'SOL'   ? amount : 0,
    );
    await finRepo.createLedgerEntry({
      wallet:   { connect: { id: wallet.id } },
      type:     'DEPOSIT',
      amount,
      currency,
      status:   'CONFIRMED',
      txHash,
    });
    return { success: true, newBalance: wallet.balanceArena + (currency === 'ARENA' ? amount : 0) };
  }

  /**
   * Initiates a withdrawal from the agent's custodial wallet.
   *
   * Flow:
   *   1. Validate balance & freeze status
   *   2. Debit balance immediately (reserve funds)
   *   3. Write PENDING ledger entry
   *   4. Publish WITHDRAWAL_REQUESTED event — financial-processor picks it up,
   *      executes the Solana transfer, and marks the ledger entry CONFIRMED
   *
   * The Solana tx itself is async — poll GET /v1/transactions/:agentId
   * to confirm when status becomes CONFIRMED.
   */
  async initiateWithdrawal(agentId: string, amount: number, destination: string) {
    const wallet = await finRepo.getWallet(agentId);
    if (!wallet) throw new Error('Wallet not found');
    if (wallet.isFrozen) throw new Error('Wallet is frozen');
    if (wallet.balanceArena < amount) throw new Error('Insufficient ARENA balance');

    // Debit balance immediately to reserve funds
    await finRepo.updateBalance(agentId, -amount, 0);

    // Create PENDING ledger entry — processor will set to CONFIRMED once tx lands
    const entry = await finRepo.createLedgerEntry({
      wallet:   { connect: { id: wallet.id } },
      type:     'WITHDRAWAL',
      amount,
      currency: 'ARENA',
      status:   'PENDING',
      metadata: { destination } as any,
    });

    // Publish event for async Solana execution
    try {
      const bus = await getEventBus();
      await bus.publish('financial.withdrawal.requested', {
        ledgerEntryId: entry.id,
        agentId,
        amount,
        destination,
        occurredAt: new Date(),
      });
    } catch (err) {
      console.warn('[FinancialOrchestrator] NATS unavailable, withdrawal queued in DB only:', err);
    }

    return {
      withdrawalId:    entry.id,
      status:          'PENDING',
      agentId,
      amount,
      destination,
      note:            'Solana transfer is processing. Poll GET /v1/transactions/:agentId for confirmation.',
    };
  }

  async getTransactions(agentId: string, page: number, limit: number) {
    const wallet = await finRepo.getWallet(agentId);
    if (!wallet) return { transactions: [], total: 0 };
    const entries = await finRepo.getLedgerEntries(wallet.id, page, limit);
    return { transactions: entries };
  }

  async createStake(agentId: string, amount: number) {
    const wallet = await finRepo.getWallet(agentId);
    if (!wallet) throw new Error('Wallet not found');
    if (wallet.balanceArena < amount) throw new Error('Insufficient ARENA balance');

    await finRepo.updateBalance(agentId, -amount, 0);
    return prisma.stakingRecord.create({
      data: { agent: { connect: { id: agentId } }, amount },
    });
  }

  async getStakes(agentId: string) {
    const stakes = await prisma.stakingRecord.findMany({ where: { agentId, isActive: true } });
    return { stakes };
  }
}
