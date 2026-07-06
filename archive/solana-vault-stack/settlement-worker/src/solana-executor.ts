import { EscrowClient } from '@ai-arena/solana-client';
import { prisma } from '@ai-arena/db-client';

export interface SettlementResult {
  txHash: string;
  success: boolean;
}

export class SolanaExecutor {
  private readonly escrowClient = new EscrowClient();

  async settleEscrow(
    escrowId: string,
    winnerId: string,
    amounts: Record<string, number>
  ): Promise<SettlementResult> {
    const escrow = await prisma.escrowRecord.findUnique({ where: { id: escrowId } });
    if (!escrow) throw new Error(`Escrow ${escrowId} not found`);

    const txHash = await this.escrowClient.settleEscrow({
      escrowAddress: escrow.solanaAddress,
      winnerId,
      battleId: escrow.battleId ?? escrowId,
    });

    // Update escrow state in DB
    await prisma.escrowRecord.update({
      where: { id: escrowId },
      data: {
        state: 'SETTLED',
        winnerId,
        settledAt: new Date(),
        txHashes: { settle: txHash },
      },
    });

    return { txHash, success: true };
  }

  async cancelEscrow(escrowId: string): Promise<SettlementResult> {
    const escrow = await prisma.escrowRecord.findUnique({ where: { id: escrowId } });
    if (!escrow) throw new Error(`Escrow ${escrowId} not found`);

    const txHash = await this.escrowClient.cancelEscrow(escrow.solanaAddress);

    await prisma.escrowRecord.update({
      where: { id: escrowId },
      data: { state: 'CANCELLED', txHashes: { cancel: txHash } },
    });

    return { txHash, success: true };
  }
}
