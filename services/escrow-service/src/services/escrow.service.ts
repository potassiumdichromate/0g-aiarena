import { prisma, FinancialRepository } from '@ai-arena/db-client';
import { EscrowClient } from '@ai-arena/solana-client';
import { getEventBus, SUBJECTS } from '@ai-arena/event-bus';

const finRepo = new FinancialRepository(prisma);
const escrowClient = new EscrowClient();

export class EscrowService {
  async createEscrow(params: {
    battleId: string;
    agentIds: string[];
    amounts: Record<string, number>;
  }) {
    const { address } = await escrowClient.createEscrowPDA(params);

    const escrow = await finRepo.createEscrow({
      battleId: params.battleId,
      agentIds: params.agentIds,
      amounts: params.amounts,
      solanaAddress: address,
    });

    return escrow;
  }

  async getEscrow(id: string) {
    return finRepo.getEscrow(id);
  }

  async settleEscrow(id: string, winnerId: string) {
    const escrow = await finRepo.getEscrow(id);
    if (!escrow) throw new Error('Escrow not found');

    const txHash = await escrowClient.settleEscrow({
      escrowAddress: escrow.solanaAddress,
      winnerId,
      battleId: escrow.battleId ?? '',
    });

    const updated = await finRepo.updateEscrowState(id, 'SETTLED', {
      winnerId,
      settledAt: new Date(),
      txHashes: { settle: txHash },
    });

    const bus = await getEventBus();
    await bus.publish(SUBJECTS.ESCROW_SETTLED, {
      escrowId: id,
      battleId: escrow.battleId,
      winnerId,
      amounts: escrow.amounts,
      txHash,
      occurredAt: new Date(),
    });

    return updated;
  }

  async cancelEscrow(id: string) {
    const escrow = await finRepo.getEscrow(id);
    if (!escrow) throw new Error('Escrow not found');

    const txHash = await escrowClient.cancelEscrow(escrow.solanaAddress);
    return finRepo.updateEscrowState(id, 'CANCELLED', { txHashes: { cancel: txHash } });
  }
}
