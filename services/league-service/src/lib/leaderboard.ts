import { getRedisClient, LEAGUE_CACHE_KEYS } from '@ai-arena/cache';
import { prisma, LeagueTribe } from '@ai-arena/db-client';
import { leagueRepo } from './season';
import { predictionRecord } from './dto';

export interface ReputationLeaderboardRow {
  rank: number;
  agentId: string;
  agentName: string;
  reputation: number;
  record: string;
  streak: number;
}

/**
 * §14.1/§14.4 — Redis-first, Postgres-fallback (mirrors leaderboard-service's
 * `getLeaderboard`). `scope=global` omits `tribe`; `scope=faction` requires it.
 */
export async function getReputationLeaderboard(
  seasonId: string,
  opts: { tribe?: LeagueTribe; limit?: number } = {},
): Promise<ReputationLeaderboardRow[]> {
  const { tribe, limit = 50 } = opts;
  const redis = getRedisClient();

  let ranked: { agentId: string; score: number }[] = [];
  try {
    const key = tribe
      ? LEAGUE_CACHE_KEYS.leaderboardFaction(seasonId, tribe)
      : LEAGUE_CACHE_KEYS.leaderboardGlobal(seasonId);
    const raw = await redis.zrevrange(key, 0, limit - 1, true);
    for (let i = 0; i < raw.length; i += 2) {
      ranked.push({ agentId: raw[i], score: parseFloat(raw[i + 1]) });
    }
  } catch (err) {
    console.warn('[league-service] Redis unavailable for leaderboard, falling back to Postgres:', (err as Error).message);
  }

  if (ranked.length === 0) {
    const stats = await leagueRepo.getLeaderboard(seasonId, { tribe, limit });
    ranked = stats.map((s) => ({ agentId: s.agentId, score: s.reputation }));
  }

  if (ranked.length === 0) return [];

  const agentIds = ranked.map((r) => r.agentId);
  const [agents, statsRows] = await Promise.all([
    prisma.agent.findMany({ where: { id: { in: agentIds } }, select: { id: true, name: true } }),
    prisma.leagueAgentSeasonStats.findMany({ where: { seasonId, agentId: { in: agentIds } } }),
  ]);
  const agentMap = new Map(agents.map((a) => [a.id, a.name]));
  const statsMap = new Map(statsRows.map((s) => [s.agentId, s]));

  return ranked.map((r, idx) => {
    const stats = statsMap.get(r.agentId);
    return {
      rank: idx + 1,
      agentId: r.agentId,
      agentName: agentMap.get(r.agentId) ?? 'Unknown',
      reputation: Math.round(r.score),
      record: stats ? predictionRecord(stats) : '0-0',
      streak: stats?.currentStreak ?? 0,
    };
  });
}

/** §15.2.1 — user-scoped global rank via the parallel `league:leaderboard:users:{seasonId}` ZSET. */
export async function getUserGlobalRank(seasonId: string, userId: string): Promise<number | null> {
  try {
    const redis = getRedisClient();
    const rank = await redis.zrevrank(LEAGUE_CACHE_KEYS.leaderboardUsers(seasonId), userId);
    return rank === null ? null : rank + 1;
  } catch (err) {
    console.warn('[league-service] Redis unavailable for global rank:', (err as Error).message);
    return null;
  }
}
