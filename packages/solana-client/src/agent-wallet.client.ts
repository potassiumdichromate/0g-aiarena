import { PublicKey, SystemProgram } from '@solana/web3.js';
import { Program, BN } from '@coral-xyz/anchor';
import { getSolanaConnection, getProvider } from './connection';

const AGENT_WALLET_PROGRAM_ID = new PublicKey(
  process.env.AGENT_WALLET_PROGRAM_ID || '11111111111111111111111111111111'
);

export interface AgentWalletAccount {
  agentId: string;
  authority: string;
  balance: number;
  isFrozen: boolean;
  dailySpendUsed: number;
  bump: number;
}

export class AgentWalletClient {
  async getWalletPDA(agentId: string): Promise<[PublicKey, number]> {
    return PublicKey.findProgramAddressSync(
      [Buffer.from('agent-wallet'), Buffer.from(agentId)],
      AGENT_WALLET_PROGRAM_ID
    );
  }

  async createAgentWallet(agentId: string): Promise<{ address: string; bump: number }> {
    const [pda, bump] = await this.getWalletPDA(agentId);
    // In production: call the Anchor program instruction
    // For now return the PDA address
    return { address: pda.toBase58(), bump };
  }

  async getWallet(agentId: string): Promise<AgentWalletAccount | null> {
    const connection = getSolanaConnection();
    const [pda] = await this.getWalletPDA(agentId);
    const accountInfo = await connection.getAccountInfo(pda);
    if (!accountInfo) return null;

    // Deserialise account data using Anchor discriminator layout
    // Simplified for stub - real impl uses program.account.agentWallet.fetch()
    return {
      agentId,
      authority: pda.toBase58(),
      balance: 0,
      isFrozen: false,
      dailySpendUsed: 0,
      bump: 0,
    };
  }

  async freeze(agentId: string): Promise<string> {
    // Call freeze_wallet instruction
    const [pda] = await this.getWalletPDA(agentId);
    console.log(`Freezing wallet PDA: ${pda.toBase58()}`);
    return 'tx_signature_placeholder';
  }

  async unfreeze(agentId: string): Promise<string> {
    const [pda] = await this.getWalletPDA(agentId);
    console.log(`Unfreezing wallet PDA: ${pda.toBase58()}`);
    return 'tx_signature_placeholder';
  }
}
