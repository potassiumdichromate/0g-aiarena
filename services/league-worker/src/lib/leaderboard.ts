import { getRedisClient, LEAGUE_CACHE_KEYS } from '@ai-arena/cache';
import { LeagueTribe } from '@ai-arena/db-client';
import { leagueRepo } from './season';
import { resolveAgentOwner } from './resolve';

/**
 * §14.2 — keeps the global, per-faction, and per-user-aggregate reputation
 * ZSETs in sync after a single agent's `LeagueAgentSeasonStats` changes.
 * Best-effort: a Redis failure here must never fail settlement, since
 * Postgres remains the source of truth and `rebuildLeaderboards` can repair it.
 */
export async function updateLeaderboards(
  seasonId: string,
  agentId: string,
  tribe: LeagueTribe,
  reputation: number,
  reputationDelta: number,
): Promise<void> {
  try {
    const redis = getRedisClient();
    await redis.zadd(LEAGUE_CACHE_KEYS.leaderboardGlobal(seasonId), reputation, agentId);
    await redis.zadd(LEAGUE_CACHE_KEYS.leaderboardFaction(seasonId, tribe), reputation, agentId);

    if (reputationDelta !== 0) {
      const ownerId = await resolveAgentOwner(agentId);
      await redis.zincrby(LEAGUE_CACHE_KEYS.leaderboardUsers(seasonId), reputationDelta, ownerId);
    }
  } catch (err) {
    console.warn(`[league-worker] leaderboard update failed for agent ${agentId}:`, (err as Error).message);
  }
}

/**
 * §14.4 — full rebuild of the Redis leaderboard ZSETs from
 * `LeagueAgentSeasonStats` (Postgres source of truth). Run once at startup
 * so a flushed/cold Redis instance doesn't serve an empty leaderboard.
 */
export async function rebuildLeaderboards(seasonId: string): Promise<void> {
  const redis = getRedisClient();
  const stats = await leagueRepo.getLeaderboard(seasonId, { limit: 10000 });

  const ownerTotals = new Map<string, number>();
  for (const row of stats) {
    await redis.zadd(LEAGUE_CACHE_KEYS.leaderboardGlobal(seasonId), row.reputation, row.agentId);
    await redis.zadd(LEAGUE_CACHE_KEYS.leaderboardFaction(seasonId, row.tribe), row.reputation, row.agentId);

    const ownerId = await resolveAgentOwner(row.agentId);
    ownerTotals.set(ownerId, (ownerTotals.get(ownerId) ?? 0) + row.reputation);
  }

  await redis.del(LEAGUE_CACHE_KEYS.leaderboardUsers(seasonId));
  for (const [ownerId, total] of ownerTotals) {
    await redis.zadd(LEAGUE_CACHE_KEYS.leaderboardUsers(seasonId), total, ownerId);
  }
}
