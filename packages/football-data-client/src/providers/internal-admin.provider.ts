import { prisma } from '@ai-arena/db-client';
import { IFootballDataProvider, NormalizedMatchResult, ProviderMatch } from '../types';
import { getSeedFixtures } from '../seed-fixtures';

/**
 * Default provider outside production (§8.2). Schedule comes from a fixed
 * seed fixture list (kickoff times computed relative to "now"); results come
 * from `LeagueMatch.result`, which is written by the admin result-entry
 * endpoint (§8.4). A match with no `result.status` yet is treated as still
 * pending — it is simply omitted from the response so the settlement-poll
 * loop keeps waiting rather than guessing a LIVE state.
 */
export class InternalAdminProvider implements IFootballDataProvider {
  async getSchedule(seasonExternalId: string): Promise<ProviderMatch[]> {
    return getSeedFixtures(seasonExternalId);
  }

  async getLiveAndFinishedResults(externalIds: string[]): Promise<NormalizedMatchResult[]> {
    if (externalIds.length === 0) return [];

    const matches = await prisma.leagueMatch.findMany({
      where: { providerId: { in: externalIds } },
      select: { providerId: true, result: true },
    });

    const results: NormalizedMatchResult[] = [];
    for (const match of matches) {
      const result = match.result as Partial<NormalizedMatchResult> | null;
      if (!result?.status) continue;

      results.push({
        externalId: match.providerId,
        status: result.status,
        scoreHome: result.scoreHome ?? null,
        scoreAway: result.scoreAway ?? null,
        winner: result.winner ?? null,
        wentToPenalties: result.wentToPenalties,
        penaltyScore: result.penaltyScore,
        finishedAt: result.finishedAt ?? null,
      });
    }
    return results;
  }
}
