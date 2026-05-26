import { getRedisClient, CACHE_KEYS } from '@ai-arena/cache';
import { prisma } from '@ai-arena/db-client';

export class LeaderboardService {
  private readonly redis = getRedisClient();

  async getLeaderboard(leaderboardId: string, limit: number) {
    const key = CACHE_KEYS.leaderboard(leaderboardId);
    const raw = await this.redis.zrevrange(key, 0, limit - 1, true);

    // ── Build ranked list from Redis ─────────────────────────────────────────
    let ranked: { rank: number; agentId: string; score: number }[] = [];
    for (let i = 0; i < raw.length; i += 2) {
      ranked.push({ rank: Math.floor(i / 2) + 1, agentId: raw[i], score: parseFloat(raw[i + 1]) });
    }

    // ── Fallback to Postgres when Redis is empty (not yet seeded) ─────────────
    if (ranked.length === 0) {
      const agents = await prisma.agent.findMany({
        where: { isRetired: false },
        orderBy: { eloRating: 'desc' },
        take: limit,
        select: {
          id: true, name: true, clan: true, archetype: true,
          eloRating: true, wins: true, losses: true, draws: true,
        },
      });

      const entries = agents.map((a, idx) => ({
        rank:      idx + 1,
        agentId:   a.id,
        score:     a.eloRating,
        name:      a.name,
        clan:      a.clan,
        archetype: a.archetype,
        eloRating: a.eloRating,
        wins:      a.wins,
        losses:    a.losses,
        draws:     a.draws,
      }));

      return { leaderboardId, entries, total: entries.length };
    }

    // ── Enrich Redis entries with agent details (single batch query) ──────────
    const agentIds = ranked.map((r) => r.agentId);
    const agents = await prisma.agent.findMany({
      where: { id: { in: agentIds }, isRetired: false },
      select: {
        id: true, name: true, clan: true, archetype: true,
        eloRating: true, wins: true, losses: true, draws: true,
      },
    });
    const agentMap = new Map(agents.map((a) => [a.id, a]));

    const entries = ranked.map((r) => {
      const a = agentMap.get(r.agentId);
      return {
        rank:      r.rank,
        agentId:   r.agentId,
        score:     r.score,
        name:      a?.name      ?? null,
        clan:      a?.clan      ?? null,
        archetype: a?.archetype ?? null,
        eloRating: a?.eloRating ?? r.score,
        wins:      a?.wins      ?? 0,
        losses:    a?.losses    ?? 0,
        draws:     a?.draws     ?? 0,
      };
    });

    return { leaderboardId, entries, total: entries.length };
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
    await this.redis.expire(key, 300); // 5-minute TTL
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
