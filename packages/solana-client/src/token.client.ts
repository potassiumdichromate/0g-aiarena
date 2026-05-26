/**
 * TokenClient — ARENA SPL token balance queries.
 *
 * NOTE: ARENA is currently tracked as an off-chain balance in Postgres.
 * There is no deployed SPL token mint yet. These methods return stub values
 * until the SPL mint is deployed on mainnet.
 *
 * When the mint is live set ARENA_TOKEN_MINT env var and re-enable the
 * @solana/spl-token import (use a dynamic `await import(...)` to keep the
 * package CJS-compatible).
 */

import { PublicKey } from '@solana/web3.js';
import { getSolanaConnection } from './connection';

const ARENA_TOKEN_MINT_RAW = process.env.ARENA_TOKEN_MINT ?? '';

// Standard Solana program IDs — no spl-token package needed
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM_ID   = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bm');

export class TokenClient {
  getArenaMint(): string {
    return ARENA_TOKEN_MINT_RAW || '11111111111111111111111111111111';
  }

  /**
   * Returns the ARENA SPL token balance for a wallet.
   * Returns 0 until a real mint is configured — balances are tracked in Postgres.
   */
  async getArenaBalance(walletAddress: string): Promise<number> {
    if (!ARENA_TOKEN_MINT_RAW) return 0;

    try {
      const connection = getSolanaConnection();
      const owner = new PublicKey(walletAddress);
      const mint  = new PublicKey(ARENA_TOKEN_MINT_RAW);

      const [ata] = PublicKey.findProgramAddressSync(
        [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
        ATA_PROGRAM_ID,
      );

      const info = await connection.getTokenAccountBalance(ata);
      return Number(info.value.uiAmount ?? 0);
    } catch {
      return 0;
    }
  }

  /**
   * Returns the associated token account address for a wallet.
   * Returns null until a real mint is configured.
   */
  async getArenaTokenAccount(walletAddress: string): Promise<string | null> {
    if (!ARENA_TOKEN_MINT_RAW) return null;

    try {
      const owner = new PublicKey(walletAddress);
      const mint  = new PublicKey(ARENA_TOKEN_MINT_RAW);

      const [ata] = PublicKey.findProgramAddressSync(
        [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
        ATA_PROGRAM_ID,
      );

      return ata.toBase58();
    } catch {
      return null;
    }
  }
}
