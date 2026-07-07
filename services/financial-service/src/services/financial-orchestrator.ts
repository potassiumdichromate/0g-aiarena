import { prisma, FinancialRepository } from '@ai-arena/db-client';
import { getEventBus, SUBJECTS } from '@ai-arena/event-bus';

const finRepo = new FinancialRepository(prisma);

/** New-agent off-chain $ARENA starter grant (KULT V1 Economy Spec §7). */
export const STARTER_ARENA_ALLOCATION = 100;

export class FinancialOrchestrator {
  /**
   * Returns existing wallet or creates one on first access.
   * Wallet creation used to depend on NATS AGENT_CREATED event — this makes it
   * resilient when NATS is unavailable.
   */
  async getWallet(agentId: string) {
    return this.ensureWallet(agentId);
  }

  async ensureWallet(agentId: string) {
    const existing = await finRepo.getWallet(agentId);
    if (existing) return existing;

    // Verify agent exists before creating wallet
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) return null;

    // The old Solana vault-share stack (agent_wallet Anchor program PDAs) has
    // been archived — see archive/solana-vault-stack/. Agents no longer have
    // their own on-chain wallet in the $ARENA 0G Chain economy; rewards and
    // stakes target the owning player's User.walletAddress instead (see
    // arena-chain-service). This `solanaAddress` column is legacy/off-chain
    // bookkeeping only — kept populated with a stable placeholder so existing
    // AgentWallet rows and queries keep working without a schema migration.
    const solanaAddress = `legacy_${agentId.replace(/-/g, '')}`;

    const wallet = await finRepo.createWallet({
      agent:         { connect: { id: agentId } },
      solanaAddress,
      balanceArena:  STARTER_ARENA_ALLOCATION,
      balanceSol:    0,
    });

    // Off-chain points ledger entry for the starter grant — keeps balanceArena
    // fully reconstructable from LedgerEntry rows (sum of entries == balance).
    await finRepo.createLedgerEntry({
      wallet:   { connect: { id: wallet.id } },
      type:     'STARTER_ALLOCATION',
      amount:   STARTER_ARENA_ALLOCATION,
      currency: 'ARENA',
      status:   'CONFIRMED',
      metadata: { reason: 'new_agent_starter_grant' } as any,
    });

    return wallet;
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
    const wallet = await this.ensureWallet(agentId);
    if (!wallet) throw new Error('Agent not found — create the agent before depositing');

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
    const wallet = await this.ensureWallet(agentId);
    if (!wallet) throw new Error('Agent not found');
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
    const wallet = await this.ensureWallet(agentId);
    if (!wallet) throw new Error('Agent not found');
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
