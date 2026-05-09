/**
 * AuthService
 *
 * Auth flow:
 *   1. Frontend connects wallet via Privy (MetaMask / WalletConnect on 0G chain)
 *   2. Privy gives frontend an access token
 *   3. Frontend sends that token to POST /auth/privy
 *   4. We verify with Privy server SDK → get user's EVM wallet address
 *   5. Upsert user in DB; create custodial Solana wallet if first login
 *   6. Return our own JWT (access + refresh) — all subsequent requests use this
 *
 * Custodial Solana wallet:
 *   - Created once per user on first login
 *   - Private key AES-256 encrypted with CUSTODIAL_WALLET_ENCRYPTION_KEY
 *   - Stored in DB — use AWS KMS in production instead
 *   - This wallet holds the user's $ARENA balance (like Stake.com's internal wallet)
 */

import { PrivyClient } from '@privy-io/server-auth';
import { Keypair } from '@solana/web3.js';
import * as crypto from 'crypto';
import { getRedisClient, CACHE_KEYS, TTL } from '@ai-arena/cache';
import { prisma } from '@ai-arena/db-client';

const privy = new PrivyClient(
  process.env.PRIVY_APP_ID     ?? '',
  process.env.PRIVY_APP_SECRET ?? '',
);

const ENCRYPTION_KEY = process.env.CUSTODIAL_WALLET_ENCRYPTION_KEY ?? 'dev-key-change-in-prod-32bytesXX';
// Key must be exactly 32 bytes for AES-256
const ENC_KEY_BUF = Buffer.from(ENCRYPTION_KEY.padEnd(32, '0').slice(0, 32));

// ── Custodial wallet crypto ───────────────────────────────────────────────────

function encryptPrivateKey(privateKeyBase64: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', ENC_KEY_BUF, iv);
  const encrypted = Buffer.concat([
    cipher.update(privateKeyBase64, 'utf8'),
    cipher.final(),
  ]);
  return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptPrivateKey(encrypted: string): string {
  const [ivHex, encHex] = encrypted.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', ENC_KEY_BUF, iv);
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encHex, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

export function getDecryptedCustodialKey(encryptedKey: string): Keypair {
  const privateKeyBase64 = decryptPrivateKey(encryptedKey);
  return Keypair.fromSecretKey(Buffer.from(privateKeyBase64, 'base64'));
}

// ── AuthService ───────────────────────────────────────────────────────────────

export class AuthService {
  /**
   * Verify a Privy access token and upsert the user.
   * Returns userId + whether this was a new user (for first-time UX).
   */
  async loginWithPrivy(privyAccessToken: string): Promise<{
    userId:        string;
    walletAddress: string;
    isNewUser:     boolean;
    custodialSolanaAddress: string;
  }> {
    // 1. Verify Privy token
    let privyClaims: Awaited<ReturnType<typeof privy.verifyAuthToken>>;
    try {
      privyClaims = await privy.verifyAuthToken(privyAccessToken);
    } catch {
      throw new Error('Invalid Privy access token');
    }

    // 2. Get EVM wallet address from Privy user
    const privyUser = await privy.getUser(privyClaims.userId);
    const evmWallet = privyUser.linkedAccounts.find(
      (a) => a.type === 'wallet' && a.walletClientType !== 'privy',
    ) ?? privyUser.linkedAccounts.find((a) => a.type === 'wallet');

    if (!evmWallet || evmWallet.type !== 'wallet') {
      throw new Error('No EVM wallet linked to this Privy account');
    }
    const walletAddress = evmWallet.address.toLowerCase();

    // 3. Check if user exists
    const existing = await prisma.user.findFirst({
      where: {
        OR: [
          { privyUserId: privyClaims.userId },
          { walletAddress },
        ],
      },
    });

    const isNewUser = !existing;

    // 4. Create custodial Solana wallet for new users
    let custodialSolanaAddress: string;
    let custodialSolanaKeyEnc: string | undefined;

    if (isNewUser || !existing?.custodialSolanaAddress) {
      const keypair = Keypair.generate();
      custodialSolanaAddress = keypair.publicKey.toBase58();
      custodialSolanaKeyEnc  = encryptPrivateKey(
        Buffer.from(keypair.secretKey).toString('base64'),
      );
    } else {
      custodialSolanaAddress = existing.custodialSolanaAddress;
    }

    // 5. Upsert user
    const user = await prisma.user.upsert({
      where:  { walletAddress },
      create: {
        walletAddress,
        privyUserId:           privyClaims.userId,
        custodialSolanaAddress,
        custodialSolanaKeyEnc,
      },
      update: {
        privyUserId: privyClaims.userId,
        // Only set custodial wallet if not already set
        ...(existing?.custodialSolanaAddress ? {} : {
          custodialSolanaAddress,
          custodialSolanaKeyEnc,
        }),
      },
    });

    return {
      userId:                 user.id,
      walletAddress,
      isNewUser,
      custodialSolanaAddress: user.custodialSolanaAddress!,
    };
  }

  // ── Legacy SIWE (kept for backward compat with non-Privy clients) ────────────
  async getNonce(address: string): Promise<string> {
    const redis = getRedisClient();
    const nonce = crypto.randomBytes(8).toString('hex');
    await redis.setex(CACHE_KEYS.nonce(address), TTL.NONCE, nonce);
    return nonce;
  }
}
