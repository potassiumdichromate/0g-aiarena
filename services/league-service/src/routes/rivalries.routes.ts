import { FastifyInstance } from 'fastify';
import { optionalJwt } from '../middleware/jwt.middleware';
import { leagueReadService } from '../services/league-read.service';

export async function rivalriesRoutes(app: FastifyInstance): Promise<void> {
  // §15.4 — GET /v1/league/rivalries/featured
  app.get('/rivalries/featured', { onRequest: [optionalJwt(app)] }, async (req, reply) => {
    const user = req.user as { userId: string } | undefined;
    const rivalry = await leagueReadService.getFeaturedRivalry(user?.userId);
    if (!rivalry) return reply.status(404).send({ error: 'no featured rivalry available' });
    return rivalry;
  });
}
