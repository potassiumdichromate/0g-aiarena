import { FastifyInstance } from 'fastify';
import { LeagueMatchStatus, LeagueStage } from '@ai-arena/db-client';
import { optionalJwt } from '../middleware/jwt.middleware';
import { leagueReadService } from '../services/league-read.service';
import { parseIntParam } from '../lib/query';
import { findInvalidUuidParam } from '../lib/validation';
import { BadRequestError } from '../lib/errors';

const MATCH_STATUSES = new Set<LeagueMatchStatus>(['SCHEDULED', 'LIVE', 'FINISHED', 'POSTPONED', 'CANCELLED']);
const LEAGUE_STAGES = new Set<LeagueStage>(['GROUP', 'ROUND_OF_32', 'ROUND_OF_16', 'QUARTER_FINAL', 'SEMI_FINAL', 'THIRD_PLACE', 'FINAL']);

export async function matchesRoutes(app: FastifyInstance): Promise<void> {
  // §15.1 — GET /v1/league/matches
  app.get('/matches', async (req) => {
    const { status, stage, page, limit } = req.query as { status?: string; stage?: string; page?: string; limit?: string };

    if (status !== undefined && !MATCH_STATUSES.has(status as LeagueMatchStatus)) {
      throw new BadRequestError(`invalid status '${status}'`);
    }
    if (stage !== undefined && !LEAGUE_STAGES.has(stage as LeagueStage)) {
      throw new BadRequestError(`invalid stage '${stage}'`);
    }

    return leagueReadService.listMatches({
      status: status as LeagueMatchStatus | undefined,
      stage: stage as LeagueStage | undefined,
      page: parseIntParam(page, 1, { min: 1 }),
      limit: parseIntParam(limit, 20, { min: 1, max: 100 }),
    });
  });

  // §15.3 — GET /v1/league/matches/featured (must be registered before /:matchId)
  app.get('/matches/featured', { onRequest: [optionalJwt(app)] }, async (req, reply) => {
    const user = req.user as { userId: string } | undefined;
    const match = await leagueReadService.getFeaturedMatch(user?.userId);
    if (!match) return reply.status(404).send({ error: 'no featured match available' });
    return match;
  });

  // §15.7 — GET /v1/league/matches/:matchId
  app.get('/matches/:matchId', { onRequest: [optionalJwt(app)] }, async (req) => {
    const { matchId } = req.params as { matchId: string };
    const invalid = findInvalidUuidParam({ matchId }, ['matchId']);
    if (invalid) throw new BadRequestError(`invalid ${invalid}`);

    const user = req.user as { userId: string } | undefined;
    return leagueReadService.getMatchDetail(matchId, user?.userId);
  });
}
