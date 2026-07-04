import { FastifyInstance } from 'fastify';
import { jwtMiddleware } from '../middleware/jwt.middleware';
import { polymarketSignalService } from '../services/polymarket-signal.service';
import { findInvalidUuidParam } from '../lib/validation';
import { BadRequestError } from '../lib/errors';

const generateBodySchema = {
  type: 'object',
  required: ['question'],
  additionalProperties: false,
  properties: {
    question: { type: 'string', minLength: 1, maxLength: 500 },
    category: { type: 'string', maxLength: 100 },
  },
};

/** docs/polymarket/knowledge_polymarket.md §5 Phase 1 — /v1/polymarket/* */
export async function polymarketRoutes(app: FastifyInstance): Promise<void> {
  // GET /v1/polymarket/signals/:marketId — public, read path exists from day one
  // (not bolted on after the fact) so a signal survives page refresh.
  app.get('/signals/:marketId', async (req) => {
    const { marketId } = req.params as { marketId: string };
    return polymarketSignalService.getSignalsForMarket(marketId);
  });

  // POST /v1/polymarket/signals/:marketId/:agentId/generate — auth required, must own agentId.
  // marketId is an external Polymarket id (not a UUID) — only agentId is validated as one.
  app.post(
    '/signals/:marketId/:agentId/generate',
    {
      onRequest: [jwtMiddleware(app)],
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: { body: generateBodySchema },
    },
    async (req) => {
      const { marketId, agentId } = req.params as { marketId: string; agentId: string };
      const invalid = findInvalidUuidParam({ agentId }, ['agentId']);
      if (invalid) throw new BadRequestError(`invalid ${invalid}`);

      const { userId } = req.user as { userId: string };
      const { question, category } = req.body as { question: string; category?: string };
      return polymarketSignalService.generateSignal(userId, marketId, agentId, question, category);
    },
  );
}
