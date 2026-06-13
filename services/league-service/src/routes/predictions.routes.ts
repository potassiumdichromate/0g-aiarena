import { FastifyInstance } from 'fastify';
import { jwtMiddleware } from '../middleware/jwt.middleware';
import { leagueReadService } from '../services/league-read.service';
import { leaguePredictionService, OverrideInput } from '../services/league-prediction.service';
import { parseIntParam } from '../lib/query';
import { findInvalidUuidParam } from '../lib/validation';
import { BadRequestError } from '../lib/errors';

const overrideBodySchema = {
  type: 'object',
  required: ['winner', 'scoreHome', 'scoreAway', 'conviction'],
  additionalProperties: false,
  properties: {
    winner: { type: 'string', enum: ['HOME', 'AWAY', 'DRAW'] },
    scoreHome: { type: 'integer', minimum: 0, maximum: 20 },
    scoreAway: { type: 'integer', minimum: 0, maximum: 20 },
    conviction: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
    reasoning: { type: 'string', maxLength: 2000 },
  },
};

export async function predictionsRoutes(app: FastifyInstance): Promise<void> {
  // GET /v1/league/predictions/today?limit=10
  app.get('/predictions/today', async (req) => {
    const { limit } = req.query as { limit?: string };
    return leagueReadService.getTodayPredictions(parseIntParam(limit, 10, { min: 1, max: 50 }));
  });

  // §6.5 — PUT /v1/league/predictions/:matchId/:agentId
  app.put(
    '/predictions/:matchId/:agentId',
    {
      onRequest: [jwtMiddleware(app)],
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: { body: overrideBodySchema },
    },
    async (req) => {
      const { matchId, agentId } = req.params as { matchId: string; agentId: string };
      const invalid = findInvalidUuidParam({ matchId, agentId }, ['matchId', 'agentId']);
      if (invalid) throw new BadRequestError(`invalid ${invalid}`);

      const { userId } = req.user as { userId: string };
      return leaguePredictionService.overridePrediction(userId, matchId, agentId, req.body as OverrideInput);
    },
  );

  // §6.2 — POST /v1/league/predictions/:matchId/:agentId/generate
  app.post(
    '/predictions/:matchId/:agentId/generate',
    {
      onRequest: [jwtMiddleware(app)],
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (req) => {
      const { matchId, agentId } = req.params as { matchId: string; agentId: string };
      const invalid = findInvalidUuidParam({ matchId, agentId }, ['matchId', 'agentId']);
      if (invalid) throw new BadRequestError(`invalid ${invalid}`);

      const { userId } = req.user as { userId: string };
      return leaguePredictionService.generatePrediction(userId, matchId, agentId);
    },
  );
}
