import { FastifyInstance } from 'fastify';
import { jwtMiddleware } from '../middleware/jwt.middleware';
import { leagueReadService } from '../services/league-read.service';
import { leagueBattleService, CreateBattleInput } from '../services/league-battle.service';
import { parseIntParam } from '../lib/query';
import { findInvalidUuidParam } from '../lib/validation';
import { BadRequestError } from '../lib/errors';

const createBattleBodySchema = {
  type: 'object',
  required: ['matchId', 'challengerAgentId', 'opponentAgentId', 'stakeArena'],
  additionalProperties: false,
  properties: {
    matchId: { type: 'string' },
    challengerAgentId: { type: 'string' },
    opponentAgentId: { type: 'string' },
    stakeArena: { type: 'number', exclusiveMinimum: 0 },
  },
};

export async function battlesRoutes(app: FastifyInstance): Promise<void> {
  // §15.6 — GET /v1/league/battles/open?limit=10
  app.get('/battles/open', async (req) => {
    const { limit } = req.query as { limit?: string };
    return leagueReadService.getOpenBattles(parseIntParam(limit, 10, { min: 1, max: 50 }));
  });

  // §9.1 step 1 — POST /v1/league/battles
  app.post(
    '/battles',
    {
      onRequest: [jwtMiddleware(app)],
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: { body: createBattleBodySchema },
    },
    async (req, reply) => {
      const { userId } = req.user as { userId: string };
      const battle = await leagueBattleService.createBattle(userId, req.body as CreateBattleInput);
      return reply.status(201).send(battle);
    },
  );

  // §9.1 step 2 — POST /v1/league/battles/:id/accept
  app.post(
    '/battles/:id/accept',
    {
      onRequest: [jwtMiddleware(app)],
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const invalid = findInvalidUuidParam({ id }, ['id']);
      if (invalid) throw new BadRequestError(`invalid ${invalid}`);

      const { userId } = req.user as { userId: string };
      return leagueBattleService.acceptBattle(userId, id);
    },
  );
}
