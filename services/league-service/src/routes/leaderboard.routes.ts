import { FastifyInstance } from 'fastify';
import { LeagueTribe } from '@ai-arena/db-client';
import { leagueReadService } from '../services/league-read.service';
import { parseIntParam } from '../lib/query';
import { BadRequestError } from '../lib/errors';

const SCOPES = new Set(['global', 'faction', 'weekly']);
const TRIBES = new Set<LeagueTribe>(['NEXUS_01', 'SHADOW_9', 'ATHENA', 'VOIDWALKER']);

export async function leaderboardRoutes(app: FastifyInstance): Promise<void> {
  // GET /v1/league/leaderboard?scope=global|faction|weekly&tribe=...&limit=50
  app.get('/leaderboard', async (req) => {
    const { scope = 'global', tribe, limit } = req.query as { scope?: string; tribe?: string; limit?: string };

    if (!SCOPES.has(scope)) throw new BadRequestError(`invalid scope '${scope}'`);

    const parsedLimit = parseIntParam(limit, 50, { min: 1, max: 100 });

    if (scope === 'weekly') {
      return leagueReadService.getKpLeaderboard(parsedLimit);
    }

    if (scope === 'faction') {
      if (!tribe || !TRIBES.has(tribe as LeagueTribe)) {
        throw new BadRequestError("scope 'faction' requires a valid 'tribe' query param");
      }
      return leagueReadService.getReputationLeaderboard(tribe as LeagueTribe, parsedLimit);
    }

    return leagueReadService.getReputationLeaderboard(undefined, parsedLimit);
  });
}
