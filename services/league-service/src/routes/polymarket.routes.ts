import { FastifyInstance } from 'fastify';
import { jwtMiddleware } from '../middleware/jwt.middleware';
import { polymarketSignalService } from '../services/polymarket-signal.service';
import { findInvalidUuidParam } from '../lib/validation';
import { BadRequestError } from '../lib/errors';

const POLYMARKET_RELAYER_URL = 'https://relayer-v2.polymarket.com/submit';

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

  // POST /v1/polymarket/relayer/submit — thin, secret-holding proxy to
  // Polymarket's deposit-wallet relayer (docs.polymarket.com/trading/deposit-wallets).
  //
  // The browser builds the ENTIRE request itself (WALLET-CREATE is unsigned/
  // idempotent; a WALLET batch-execute is signed client-side by the player's
  // own wallet via EIP-712 -- see polymarketDepositWallet.ts in the frontend)
  // and just needs this hop to attach our platform's Relayer API Key, which
  // must never reach the browser: it authorizes Polymarket to sponsor gas
  // under Kult Games' account for every relayed call. This route never
  // inspects or trusts the payload's contents beyond forwarding it -- fund
  // safety comes entirely from the payload's own signature (a forged
  // WALLET batch fails Polymarket's own EIP-712 check), not from anything
  // checked here. The target URL is hardcoded (not client-supplied) so this
  // can't be turned into an open relay/SSRF proxy.
  app.post(
    '/relayer/submit',
    { onRequest: [jwtMiddleware(app)], config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const apiKey = process.env.POLYMARKET_RELAYER_API_KEY;
      const apiKeyAddress = process.env.POLYMARKET_RELAYER_API_KEY_ADDRESS;
      if (!apiKey || !apiKeyAddress) {
        return reply.status(503).send({ error: 'Polymarket relayer not configured' });
      }

      const res = await fetch(POLYMARKET_RELAYER_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          RELAYER_API_KEY: apiKey,
          RELAYER_API_KEY_ADDRESS: apiKeyAddress,
        },
        body: JSON.stringify(req.body),
      });

      const text = await res.text();
      reply.status(res.status);
      reply.header('Content-Type', res.headers.get('content-type') ?? 'application/json');
      return reply.send(text);
    },
  );
}
