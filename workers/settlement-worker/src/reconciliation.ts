import { prisma } from '@ai-arena/db-client';
import { getSolanaConnection } from '@ai-arena/solana-client';

/**
 * Reconciles off-chain escrow state with on-chain Solana state.
 * Runs periodically to catch missed settlement events.
 */
export class Reconciliation {
  async run(): Promise<void> {
    console.log('[reconciliation] Starting reconciliation pass...');

    const pendingEscrows = await prisma.escrowRecord.findMany({
      where: { state: { in: ['FUNDED', 'LOCKED'] } },
      take: 100,
    });

    for (const escrow of pendingEscrows) {
      try {
        await this.checkEscrow(escrow);
      } catch (err) {
        console.error(`[reconciliation] Failed to check escrow ${escrow.id}:`, err);
      }
    }

    console.log(`[reconciliation] Checked ${pendingEscrows.length} escrows`);
  }

  private async checkEscrow(escrow: any): Promise<void> {
    const connection = getSolanaConnection();
    // In production: deserialise on-chain escrow account and compare state
    // For now: log unresolved escrows
    const age = Date.now() - new Date(escrow.createdAt).getTime();
    const ageHours = age / 1000 / 3600;

    if (ageHours > 24) {
      console.warn(`[reconciliation] Escrow ${escrow.id} has been pending for ${ageHours.toFixed(1)} hours`);
    }
  }
}
