import { prisma, FinancialRepository } from '@ai-arena/db-client';
import { AgentWalletClient } from '@ai-arena/solana-client';

const finRepo = new FinancialRepository(prisma);
const walletClient = new AgentWalletClient();

export class WalletService {
  async createWallet(agentId: string) {
    const { address, bump } = await walletClient.createAgentWallet(agentId);
    return finRepo.createWallet({
      agent: { connect: { id: agentId } },
      solanaAddress: address,
      policy: { maxSingleWager: 1000, maxDailySpend: 5000, requireApprovalAbove: 500 },
    });
  }

  async getWallet(agentId: string) {
    const dbWallet = await finRepo.getWallet(agentId);
    if (!dbWallet) return null;

    const onChain = await walletClient.getWallet(agentId);
    return { ...dbWallet, onChainState: onChain };
  }

  async freezeWallet(agentId: string) {
    await walletClient.freeze(agentId);
    return finRepo.freezeWallet(agentId, true);
  }

  async unfreezeWallet(agentId: string) {
    await walletClient.unfreeze(agentId);
    return finRepo.freezeWallet(agentId, false);
  }

  async getTransactionHistory(agentId: string) {
    const wallet = await finRepo.getWallet(agentId);
    if (!wallet) return { transactions: [] };
    const entries = await finRepo.getLedgerEntries(wallet.id);
    return { transactions: entries };
  }
}
