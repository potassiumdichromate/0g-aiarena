import { getRedisClient, CACHE_KEYS } from '@ai-arena/cache';
import { prisma } from '@ai-arena/db-client';

export class LeaderboardService {
  private readonly redis = getRedisClient();

  async getLeaderboard(leaderboardId: string, limit: number) {
    const key = CACHE_KEYS.leaderboard(leaderboardId);
    const entries = await this.redis.zrevrange(key, 0, limit - 1, true);
    const leaderboard = [];

    for (let i = 0; i < entries.length; i += 2) {
      const agentId = entries[i];
      const score = parseFloat(entries[i + 1]);
      leaderboard.push({ rank: Math.floor(i / 2) + 1, agentId, score });
    }

    return { leaderboardId, entries: leaderboard, total: leaderboard.length };
  }

  async refreshLeaderboard(leaderboardId: string): Promise<void> {
    const agents = await prisma.agent.findMany({
      where: { isRetired: false },
      orderBy: { eloRating: 'desc' },
      take: 1000,
    });

    const key = CACHE_KEYS.leaderboard(leaderboardId);
    for (const agent of agents) {
      await this.redis.zadd(key, agent.eloRating, agent.id);
    }
    await this.redis.expire(key, 60);
  }

  async getAgentRank(leaderboardId: string, agentId: string) {
    const key = CACHE_KEYS.leaderboard(leaderboardId);
    const rank = await this.redis.zrevrank(key, agentId);
    const score = await this.redis.zscore(key, agentId);
    return { agentId, rank: rank !== null ? rank + 1 : null, score: score ? parseFloat(score) : null };
  }

  async updateScore(leaderboardId: string, agentId: string, score: number): Promise<void> {
    await this.redis.zadd(CACHE_KEYS.leaderboard(leaderboardId), score, agentId);
  }
}
