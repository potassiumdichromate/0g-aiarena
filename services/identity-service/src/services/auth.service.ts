import { SiweMessage } from 'siwe';
import { getRedisClient, CACHE_KEYS, TTL } from '@ai-arena/cache';
import { prisma } from '@ai-arena/db-client';
import { generateNonce } from '@ai-arena/shared-utils';

export class AuthService {
  async getNonce(address: string): Promise<string> {
    const redis = getRedisClient();
    const nonce = generateNonce(16);
    await redis.setex(CACHE_KEYS.nonce(address), TTL.NONCE, nonce);
    return nonce;
  }

  async login(
    message: string,
    signature: string,
    walletAddress: string
  ): Promise<{ userId: string }> {
    const redis = getRedisClient();
    const siweMessage = new SiweMessage(message);
    const result = await siweMessage.verify({ signature });

    if (!result.success) {
      throw new Error('Invalid SIWE signature');
    }

    const storedNonce = await redis.get(CACHE_KEYS.nonce(walletAddress));
    if (!storedNonce || storedNonce !== siweMessage.nonce) {
      throw new Error('Invalid or expired nonce');
    }

    await redis.del(CACHE_KEYS.nonce(walletAddress));

    // Upsert user
    const user = await prisma.user.upsert({
      where: { walletAddress: walletAddress.toLowerCase() },
      create: { walletAddress: walletAddress.toLowerCase() },
      update: { updatedAt: new Date() },
    });

    return { userId: user.id };
  }
}
