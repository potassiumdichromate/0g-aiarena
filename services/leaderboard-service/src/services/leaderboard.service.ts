import { getRedisClient, CACHE_KEYS } from '@ai-arena/cache';
import { prisma } from '@ai-arena/db-client';

/** Fetch top agents directly from Postgres, sorted by ELO. */
async function fetchFromPostgres(limit: number) {
  const agents = await prisma.agent.findMany({
    where: { isRetired: false },
    orderBy: { eloRating: 'desc' },
    take: limit,
    select: {
      id: true, name: true, clan: true, archetype: true,
      eloRating: true, wins: true, losses: true, draws: true,
    },
  });

  return agents.map((a, idx) => ({
    rank:      idx + 1,
    agentId:   a.id,
    score:     a.eloRating,
    name:      a.name,
    clan:      a.clan      as string,
    archetype: a.archetype as string,
    eloRating: a.eloRating,
    wins:      a.wins,
    losses:    a.losses,
    draws:     a.draws,
  }));
}

export class LeaderboardService {
  private readonly redis = getRedisClient();

  async getLeaderboard(leaderboardId: string, limit: number) {
    // ── Try Redis first; fall back to Postgres if Redis is unavailable ────────
    let ranked: { rank: number; agentId: string; score: number }[] = [];
    let redisOk = false;

    try {
      const key = CACHE_KEYS.leaderboard(leaderboardId);
      const raw = await this.redis.zrevrange(key, 0, limit - 1, true);
      for (let i = 0; i < raw.length; i += 2) {
        ranked.push({ rank: Math.floor(i / 2) + 1, agentId: raw[i], score: parseFloat(raw[i + 1]) });
      }
      redisOk = true;
    } catch (err) {
      console.warn('[LeaderboardService] Redis unavailable, falling back to Postgres:', (err as Error).message);
    }

    // ── No Redis data (down or empty) → query Postgres directly ──────────────
    if (!redisOk || ranked.length === 0) {
      const entries = await fetchFromPostgres(limit);
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
        clan:      (a?.clan     ?? null) as string | null,
        archetype: (a?.archetype ?? null) as string | null,
        eloRating: a?.eloRating ?? r.score,
        wins:      a?.wins      ?? 0,
        losses:    a?.losses    ?? 0,
        draws:     a?.draws     ?? 0,
      };
    });

    return { leaderboardId, entries, total: entries.length };
  }

  async refreshLeaderboard(leaderboardId: string): Promise<void> {
    try {
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
    } catch (err) {
      console.warn('[LeaderboardService] Redis unavailable, refresh skipped:', (err as Error).message);
    }
  }

  async getAgentRank(leaderboardId: string, agentId: string) {
    try {
      const key = CACHE_KEYS.leaderboard(leaderboardId);
      const rank  = await this.redis.zrevrank(key, agentId);
      const score = await this.redis.zscore(key, agentId);

      // If Redis has data, return it
      if (rank !== null) {
        return { agentId, rank: rank + 1, score: score ? parseFloat(score) : null };
      }
    } catch (err) {
      console.warn('[LeaderboardService] Redis unavailable for rank lookup, using Postgres:', (err as Error).message);
    }

    // Fallback: compute rank from Postgres
    const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { eloRating: true } });
    if (!agent) return { agentId, rank: null, score: null };

    const higherCount = await prisma.agent.count({
      where: { isRetired: false, eloRating: { gt: agent.eloRating } },
    });
    return { agentId, rank: higherCount + 1, score: agent.eloRating };
  }

  async updateScore(leaderboardId: string, agentId: string, score: number): Promise<void> {
    try {
      await this.redis.zadd(CACHE_KEYS.leaderboard(leaderboardId), score, agentId);
    } catch (err) {
      console.warn('[LeaderboardService] Redis unavailable for score update:', (err as Error).message);
    }
  }
}
