import { prisma, LeagueRepository, LeagueSeason } from '@ai-arena/db-client';
import { resolveLeagueConfig, LeagueConfig } from '@ai-arena/shared-utils';

export const leagueRepo = new LeagueRepository(prisma);

/** Thrown when no `LeagueSeason` has `isActive = true` — maps to 503 at the route layer. */
export class NoActiveSeasonError extends Error {
  constructor() {
    super('no active league season');
    this.name = 'NoActiveSeasonError';
  }
}

export async function requireActiveSeason(): Promise<LeagueSeason> {
  const season = await leagueRepo.getActiveSeason();
  if (!season) throw new NoActiveSeasonError();
  return season;
}

export function configFor(season: LeagueSeason): LeagueConfig {
  return resolveLeagueConfig(season.config);
}
