import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { AnchorProvider, Wallet } from '@coral-xyz/anchor';
import bs58 from 'bs58';

let connectionInstance: Connection | null = null;

export function getSolanaConnection(): Connection {
  if (!connectionInstance) {
    const rpcUrl = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
    connectionInstance = new Connection(rpcUrl, 'confirmed');
  }
  return connectionInstance;
}

export function getKeypair(): Keypair {
  const privateKeyStr = process.env.SOLANA_PRIVATE_KEY;
  if (!privateKeyStr) {
    throw new Error('SOLANA_PRIVATE_KEY environment variable not set');
  }
  const decoded = bs58.decode(privateKeyStr);
  return Keypair.fromSecretKey(decoded);
}

export function getProvider(): AnchorProvider {
  const connection = getSolanaConnection();
  const keypair = getKeypair();
  const wallet = new Wallet(keypair);
  return new AnchorProvider(connection, wallet, { commitment: 'confirmed' });
}

export function toPubkey(address: string): PublicKey {
  return new PublicKey(address);
}
