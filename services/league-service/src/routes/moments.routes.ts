import { FastifyInstance } from 'fastify';
import { leagueReadService } from '../services/league-read.service';
import { parseIntParam } from '../lib/query';
import { isUuid } from '../lib/validation';
import { BadRequestError } from '../lib/errors';

export async function momentsRoutes(app: FastifyInstance): Promise<void> {
  // §15.8 — GET /v1/league/moments?limit=10&agentId=
  app.get('/moments', async (req) => {
    const { limit, agentId } = req.query as { limit?: string; agentId?: string };

    if (agentId !== undefined && !isUuid(agentId)) {
      throw new BadRequestError('invalid agentId');
    }

    return leagueReadService.getMoments(parseIntParam(limit, 10, { min: 1, max: 50 }), agentId);
  });
}
