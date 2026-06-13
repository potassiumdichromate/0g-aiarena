import { FastifyInstance } from 'fastify';
import { LeagueTribe } from '@ai-arena/db-client';
import { jwtMiddleware } from '../middleware/jwt.middleware';
import { leagueFactionService } from '../services/league-faction.service';

const joinFactionBodySchema = {
  type: 'object',
  required: ['tribe'],
  additionalProperties: false,
  properties: {
    tribe: { type: 'string', enum: ['NEXUS_01', 'SHADOW_9', 'ATHENA', 'VOIDWALKER'] },
  },
};

export async function factionRoutes(app: FastifyInstance): Promise<void> {
  // §12.1 — POST /v1/league/faction
  app.post(
    '/faction',
    {
      onRequest: [jwtMiddleware(app)],
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: { body: joinFactionBodySchema },
    },
    async (req) => {
      const { userId } = req.user as { userId: string };
      const { tribe } = req.body as { tribe: LeagueTribe };
      return leagueFactionService.joinFaction(userId, tribe);
    },
  );
}
