import { ProviderMatch } from './types';

interface SeedFixtureTemplate extends Omit<ProviderMatch, 'kickoffAt'> {
  seasonExternalId: string;
  kickoffOffsetHours: number; // hours from "now" at schedule-sync time
}

/**
 * Fixed fixture list for `InternalAdminProvider.getSchedule` — the default
 * provider in non-production environments (§8.2). Kickoff times are computed
 * relative to "now" so the prediction/lock/settlement pipeline is always
 * testable end-to-end without external API keys, regardless of when the
 * environment is started.
 */
const SEED_FIXTURE_TEMPLATES: SeedFixtureTemplate[] = [
  { seasonExternalId: 'kultai-world-cup-2026', externalId: 'seed-m1', homeTeam: 'FRA', awayTeam: 'GER', stage: 'Group Stage', matchday: 2, kickoffOffsetHours: 6 },
  { seasonExternalId: 'kultai-world-cup-2026', externalId: 'seed-m2', homeTeam: 'ENG', awayTeam: 'POR', stage: 'Group Stage', matchday: 2, kickoffOffsetHours: 9 },
  { seasonExternalId: 'kultai-world-cup-2026', externalId: 'seed-m3', homeTeam: 'ESP', awayTeam: 'NLD', stage: 'Group Stage', matchday: 2, kickoffOffsetHours: 27 },
  { seasonExternalId: 'kultai-world-cup-2026', externalId: 'seed-m4', homeTeam: 'ITA', awayTeam: 'NLD', stage: 'Group Stage', matchday: 2, kickoffOffsetHours: 30 },
  { seasonExternalId: 'kultai-world-cup-2026', externalId: 'seed-m5', homeTeam: 'BRA', awayTeam: 'ARG', stage: 'Group Stage', matchday: 2, kickoffOffsetHours: 49 },
  { seasonExternalId: 'kultai-world-cup-2026', externalId: 'seed-m6', homeTeam: 'GER', awayTeam: 'ITA', stage: 'Group Stage', matchday: 2, kickoffOffsetHours: 53 },
];

export function getSeedFixtures(seasonExternalId: string, now: Date = new Date()): ProviderMatch[] {
  return SEED_FIXTURE_TEMPLATES.filter((f) => f.seasonExternalId === seasonExternalId).map((f) => {
    const { seasonExternalId: _omit, kickoffOffsetHours, ...rest } = f;
    return { ...rest, kickoffAt: new Date(now.getTime() + kickoffOffsetHours * 3_600_000).toISOString() };
  });
}
