import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { getSolanaConnection } from './connection';

const ARENA_TOKEN_MINT = new PublicKey(
  process.env.ARENA_TOKEN_MINT ?? '11111111111111111111111111111111'
);

export class TokenClient {
  private readonly connection: Connection;

  constructor() {
    this.connection = getSolanaConnection();
  }

  async getArenaBalance(walletAddress: string): Promise<number> {
    try {
      const owner = new PublicKey(walletAddress);
      const ata = await getAssociatedTokenAddress(ARENA_TOKEN_MINT, owner);
      const account = await getAccount(this.connection, ata);
      return Number(account.amount) / 1e9; // Assuming 9 decimals
    } catch {
      return 0;
    }
  }

  async getArenaTokenAccount(walletAddress: string): Promise<string | null> {
    try {
      const owner = new PublicKey(walletAddress);
      const ata = await getAssociatedTokenAddress(ARENA_TOKEN_MINT, owner);
      return ata.toBase58();
    } catch {
      return null;
    }
  }

  getArenaMint(): string {
    return ARENA_TOKEN_MINT.toBase58();
  }
}
