/**
 * AgentWalletClient — TypeScript client for the agent_wallet Anchor program.
 *
 * Program ID (devnet + mainnet): 39W71ucMvVTxGMegur7XhfPUJU9m8Bqmh4qvRgykHMzk
 *
 * Every method tries the on-chain call first. If the program is not yet deployed
 * (account not found, provider error) it falls back gracefully so the rest of the
 * platform keeps running. Once `anchor deploy` is run the on-chain path activates
 * automatically.
 *
 * PDA seed: ["agent-wallet", agentId]  ← deterministic, same on devnet + mainnet.
 * The PDA address is always returned even when the on-chain call fails — so the DB
 * stores a real Solana address you can look up on explorer.solana.com.
 */

import { PublicKey, SystemProgram } from '@solana/web3.js';
import { Program, BN, type Idl } from '@coral-xyz/anchor';
import { getProvider, getSolanaConnection } from './connection';
import idl from './idl/agent-wallet.idl.json';

// Default to the program ID declared in Anchor.toml / lib.rs
const AGENT_WALLET_PROGRAM_ID = new PublicKey(
  process.env.AGENT_WALLET_PROGRAM_ID ?? '39W71ucMvVTxGMegur7XhfPUJU9m8Bqmh4qvRgykHMzk'
);

export interface AgentWalletAccount {
  agentId:        string;
  authority:      string;
  balance:        number;
  isFrozen:       boolean;
  dailySpendUsed: number;
  bump:           number;
}

function getProgram(): Program {
  // Anchor 0.29 API: new Program(idl, programId, provider)
  return new Program(idl as Idl, AGENT_WALLET_PROGRAM_ID, getProvider());
}

export class AgentWalletClient {

  // ── PDA derivation ─────────────────────────────────────────────────────────

  async getWalletPDA(agentId: string): Promise<[PublicKey, number]> {
    return PublicKey.findProgramAddressSync(
      [Buffer.from('agent-wallet'), Buffer.from(agentId)],
      AGENT_WALLET_PROGRAM_ID,
    );
  }

  // ── createAgentWallet ──────────────────────────────────────────────────────
  /**
   * Derives the PDA for the agent, then tries to call createWallet on-chain.
   * Always returns the real PDA address so the DB has a valid Solana address.
   * Falls back silently if the program is not yet deployed.
   */
  async createAgentWallet(agentId: string): Promise<{ address: string; bump: number; txSignature?: string }> {
    const [pda, bump] = await this.getWalletPDA(agentId);
    const address = pda.toBase58();

    try {
      const connection = getSolanaConnection();

      // Idempotent — skip if account already initialised
      const existing = await connection.getAccountInfo(pda);
      if (existing) {
        console.info(`[AgentWalletClient] Wallet PDA already exists for ${agentId}: ${address}`);
        return { address, bump };
      }

      const program = getProgram();
      const tx = await program.methods
        .createWallet(agentId, bump)
        .accounts({
          wallet:        pda,
          authority:     program.provider.publicKey!,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      console.info(`[AgentWalletClient] Created on-chain wallet for agent ${agentId}: ${address} (tx: ${tx})`);
      return { address, bump, txSignature: tx };

    } catch (err) {
      // Program not deployed yet — return PDA anyway so DB has a real Solana address
      console.warn(`[AgentWalletClient] createWallet on-chain skipped (deploy pending): ${(err as Error).message}`);
      return { address, bump };
    }
  }

  // ── getWallet ──────────────────────────────────────────────────────────────
  /**
   * Fetches and deserialises the on-chain AgentWallet account.
   * Returns null if account not initialised yet.
   */
  async getWallet(agentId: string): Promise<AgentWalletAccount | null> {
    const [pda] = await this.getWalletPDA(agentId);

    try {
      const program = getProgram();
      const account = await (program.account as any).agentWallet.fetch(pda);
      return {
        agentId:        account.agentId,
        authority:      account.authority.toBase58(),
        balance:        account.balance instanceof BN ? account.balance.toNumber() : Number(account.balance),
        isFrozen:       account.isFrozen,
        dailySpendUsed: account.dailySpendUsed instanceof BN ? account.dailySpendUsed.toNumber() : Number(account.dailySpendUsed),
        bump:           account.bump,
      };
    } catch {
      // Account not initialised — not an error
      return null;
    }
  }

  // ── creditWallet ───────────────────────────────────────────────────────────
  /**
   * Credits $ARENA to an agent wallet on-chain.
   * Used for: battle rewards, demo seeding.
   * Returns the tx signature, or null if program not deployed.
   */
  async creditWallet(agentId: string, amount: number): Promise<string | null> {
    const [pda] = await this.getWalletPDA(agentId);

    try {
      const program = getProgram();
      const tx = await program.methods
        .credit(new BN(amount))
        .accounts({
          wallet:    pda,
          authority: program.provider.publicKey!,
        })
        .rpc();

      console.info(`[AgentWalletClient] Credited ${amount} ARENA to agent ${agentId} on-chain (tx: ${tx})`);
      return tx;
    } catch (err) {
      console.warn(`[AgentWalletClient] credit on-chain skipped: ${(err as Error).message}`);
      return null;
    }
  }

  // ── debitWallet ────────────────────────────────────────────────────────────
  /**
   * Debits $ARENA from an agent wallet on-chain (escrow lock).
   * Returns the tx signature, or null if program not deployed.
   */
  async debitWallet(agentId: string, amount: number): Promise<string | null> {
    const [pda] = await this.getWalletPDA(agentId);

    try {
      const program = getProgram();
      const tx = await program.methods
        .debit(new BN(amount))
        .accounts({
          wallet:    pda,
          authority: program.provider.publicKey!,
        })
        .rpc();

      console.info(`[AgentWalletClient] Debited ${amount} ARENA from agent ${agentId} on-chain (tx: ${tx})`);
      return tx;
    } catch (err) {
      console.warn(`[AgentWalletClient] debit on-chain skipped: ${(err as Error).message}`);
      return null;
    }
  }

  // ── freeze / unfreeze ──────────────────────────────────────────────────────

  async freeze(agentId: string): Promise<string> {
    const [pda] = await this.getWalletPDA(agentId);
    try {
      const program = getProgram();
      return await program.methods
        .freezeWallet()
        .accounts({ wallet: pda, authority: program.provider.publicKey! })
        .rpc();
    } catch (err) {
      console.warn(`[AgentWalletClient] freeze skipped: ${(err as Error).message}`);
      return 'freeze_skipped';
    }
  }

  async unfreeze(agentId: string): Promise<string> {
    const [pda] = await this.getWalletPDA(agentId);
    try {
      const program = getProgram();
      return await program.methods
        .unfreezeWallet()
        .accounts({ wallet: pda, authority: program.provider.publicKey! })
        .rpc();
    } catch (err) {
      console.warn(`[AgentWalletClient] unfreeze skipped: ${(err as Error).message}`);
      return 'unfreeze_skipped';
    }
  }
}
