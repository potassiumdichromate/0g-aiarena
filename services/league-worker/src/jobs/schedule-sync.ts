import { createFootballDataProvider, mapProviderStage } from '@ai-arena/football-data-client';
import { leagueRepo, requireActiveSeason, NoActiveSeasonError } from '../lib/season';

const provider = createFootballDataProvider();

/**
 * §8.3 — daily: pull the full season schedule from the football data
 * provider and upsert every fixture into `LeagueMatch`, keyed on
 * `(seasonId, providerId)`. Refreshes stage/teams/kickoff/venue/matchday for
 * existing rows so a provider reschedule is picked up automatically.
 */
export async function runScheduleSync(): Promise<void> {
  let season;
  try {
    season = await requireActiveSeason();
  } catch (err) {
    if (err instanceof NoActiveSeasonError) return;
    throw err;
  }

  if (!season.providerId) {
    console.warn('[league-worker] schedule-sync: active season has no providerId — skipping');
    return;
  }

  const fixtures = await provider.getSchedule(season.providerId);
  console.log(`[league-worker] schedule-sync: ${fixtures.length} fixture(s) from provider`);

  for (const fixture of fixtures) {
    const stage = mapProviderStage(fixture.stage);
    const kickoffAt = new Date(fixture.kickoffAt);

    const fields = {
      stage,
      homeTeam: fixture.homeTeam,
      awayTeam: fixture.awayTeam,
      kickoffAt,
      ...(fixture.venue !== undefined && { venue: fixture.venue }),
      ...(fixture.matchday !== undefined && { matchday: fixture.matchday }),
    };

    await leagueRepo.upsertMatch(season.id, fixture.externalId, fields, fields);
  }
}
