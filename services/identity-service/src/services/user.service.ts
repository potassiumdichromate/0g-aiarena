import { prisma } from '@ai-arena/db-client';

export class UserService {
  async getById(id: string) {
    return prisma.user.findUnique({ where: { id } });
  }

  async update(id: string, data: { username?: string; email?: string; avatarUrl?: string }) {
    return prisma.user.update({
      where: { id },
      data: { ...data, updatedAt: new Date() },
    });
  }

  async linkWallet(userId: string, walletAddress: string): Promise<void> {
    // In production, verify signature before linking
    await prisma.user.update({
      where: { id: userId },
      data: { walletAddress: walletAddress.toLowerCase() },
    });
  }
}
