import { FastifyInstance } from 'fastify';
import { jwtMiddleware } from '../middleware/jwt.middleware';
import { leagueReadService } from '../services/league-read.service';
import { parseIntParam } from '../lib/query';

export async function meRoutes(app: FastifyInstance): Promise<void> {
  // §15.2 — GET /v1/league/me/summary
  app.get('/me/summary', { onRequest: [jwtMiddleware(app)] }, async (req) => {
    const { userId } = req.user as { userId: string };
    return leagueReadService.getMeSummary(userId);
  });

  // §15.5 — GET /v1/league/me/agents
  app.get('/me/agents', { onRequest: [jwtMiddleware(app)] }, async (req) => {
    const { userId } = req.user as { userId: string };
    return leagueReadService.getMyAgents(userId);
  });

  // GET /v1/league/me/predictions?limit=10
  app.get('/me/predictions', { onRequest: [jwtMiddleware(app)] }, async (req) => {
    const { userId } = req.user as { userId: string };
    const { limit } = req.query as { limit?: string };
    return leagueReadService.getMyRecentPicks(userId, parseIntParam(limit, 10, { min: 1, max: 50 }));
  });
}
