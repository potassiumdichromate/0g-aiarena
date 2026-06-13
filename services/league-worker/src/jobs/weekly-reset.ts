import { getRedisClient, LEAGUE_CACHE_KEYS } from '@ai-arena/cache';
import { LeagueTribe } from '@ai-arena/db-client';
import { startOfPreviousWeekUTC, addDays } from '@ai-arena/shared-utils';
import { createMoment, MOMENT_TEMPLATES } from '../lib/moments';
import { leagueRepo, requireActiveSeason, NoActiveSeasonError } from '../lib/season';

const TRIBES: LeagueTribe[] = ['NEXUS_01', 'SHADOW_9', 'ATHENA', 'VOIDWALKER'];

/**
 * §14.3 — runs Sunday 00:00 UTC. Freezes the week that just ended into
 * `LeagueWeeklySnapshot` rows (global KP, per-faction reputation, and an
 * overall faction-vs-faction standing used to detect lead changes), then
 * resets every user's `kpWeekly` for the new week and clears the now-stale
 * weekly Redis leaderboard keys.
 */
export async function runWeeklyReset(): Promise<void> {
  let season;
  try {
    season = await requireActiveSeason();
  } catch (err) {
    if (err instanceof NoActiveSeasonError) return;
    throw err;
  }

  const now = new Date();
  const weekStartAt = startOfPreviousWeekUTC(now); // the week being archived
  const newWeekStartAt = addDays(weekStartAt, 7); // the week starting now

  const kpLeaderboard = await leagueRepo.getKpLeaderboard({ scope: 'weekly', limit: 100 });
  await leagueRepo.createWeeklySnapshot({
    season: { connect: { id: season.id } },
    weekStartAt,
    scope: 'global',
    rankings: kpLeaderboard.map((profile, index) => ({ subjectId: profile.userId, rank: index + 1, score: profile.kpWeekly })),
  });

  const factionTotals: { tribe: LeagueTribe; reputation: number }[] = [];
  for (const tribe of TRIBES) {
    const repLeaderboard = await leagueRepo.getLeaderboard(season.id, { tribe, limit: 1000 });
    await leagueRepo.createWeeklySnapshot({
      season: { connect: { id: season.id } },
      weekStartAt,
      scope: `faction:${tribe}`,
      rankings: repLeaderboard.map((stats, index) => ({ subjectId: stats.agentId, rank: index + 1, score: stats.reputation })),
    });
    factionTotals.push({ tribe, reputation: repLeaderboard.reduce((sum, stats) => sum + stats.reputation, 0) });
  }

  await checkFactionLeadChange(season.id, weekStartAt, factionTotals);

  const resetCount = await leagueRepo.resetWeeklyKp(newWeekStartAt);
  console.log(`[league-worker] weekly-reset: archived week ${weekStartAt.toISOString()}, reset kpWeekly for ${resetCount} user(s)`);

  const redis = getRedisClient();
  const cleared = await redis.delPattern(LEAGUE_CACHE_KEYS.leaderboardWeekly(season.id, '*'));
  if (cleared > 0) console.log(`[league-worker] weekly-reset: cleared ${cleared} stale weekly leaderboard key(s)`);
}

/** §13 FACTION moment — fires when the tribe with the highest aggregate reputation changes week over week. */
async function checkFactionLeadChange(
  seasonId: string,
  weekStartAt: Date,
  factionTotals: { tribe: LeagueTribe; reputation: number }[],
): Promise<void> {
  const ranked = [...factionTotals].sort((a, b) => b.reputation - a.reputation);
  const leader = ranked[0];
  if (!leader) return;

  const previous = await leagueRepo.getLatestWeeklySnapshot(seasonId, 'faction-overall');
  const previousRankings = previous?.rankings as { subjectId: string; rank: number; score: number }[] | undefined;
  const previousLeader = previousRankings?.find((r) => r.rank === 1)?.subjectId;

  await leagueRepo.createWeeklySnapshot({
    season: { connect: { id: seasonId } },
    weekStartAt,
    scope: 'faction-overall',
    rankings: ranked.map((entry, index) => ({ subjectId: entry.tribe, rank: index + 1, score: entry.reputation })),
  });

  if (previousLeader && previousLeader === leader.tribe) return;

  await createMoment({
    seasonId,
    type: 'FACTION',
    text: MOMENT_TEMPLATES.FACTION({ tribe: leader.tribe }),
    payload: { tribe: leader.tribe, reputation: leader.reputation },
    idempotencyKey: `FACTION:${seasonId}:${weekStartAt.toISOString()}`,
  });
}
