import { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { jwtMiddleware } from '../middleware/jwt.middleware';
import { polymarketSignalService } from '../services/polymarket-signal.service';
import { findInvalidUuidParam } from '../lib/validation';
import { BadRequestError } from '../lib/errors';

const POLYMARKET_RELAYER_HOST = 'https://relayer-v2.polymarket.com';
const SUBMIT_PATH = '/submit';

/**
 * Polymarket's Builder API Key HMAC scheme (POLY_BUILDER_*), ported by hand
 * from @polymarket/builder-signing-sdk@0.0.8 (dist/signing/hmac.js +
 * dist/signer.js). NOT the "Relayer API Key" (RELAYER_API_KEY/_ADDRESS)
 * scheme this route used at first -- that one turned out to be scoped to a
 * single self-service address ("from X does not match auth Y" from
 * Polymarket's own relayer when we tried submitting on behalf of a player's
 * address). Builder API Keys are the ones actually meant for a platform
 * relaying transactions on behalf of many different user addresses -- also
 * the only auth path Polymarket's own RelayClient class implements for
 * these calls, confirmed from its source.
 */
function buildBuilderHeaders(secret: string, key: string, passphrase: string, method: string, path: string, body: string): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000);
  const message = `${timestamp}${method}${path}${body}`;
  const sig = crypto.createHmac('sha256', Buffer.from(secret, 'base64')).update(message).digest('base64');
  const sigUrlSafe = sig.replace(/\+/g, '-').replace(/\//g, '_');
  return {
    POLY_BUILDER_API_KEY: key,
    POLY_BUILDER_PASSPHRASE: passphrase,
    POLY_BUILDER_SIGNATURE: sigUrlSafe,
    POLY_BUILDER_TIMESTAMP: String(timestamp),
  };
}

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
  // and just needs this hop to attach our platform's Builder API Key
  // (POLY_BUILDER_* HMAC headers), which must never reach the browser: it
  // authorizes Polymarket to sponsor gas under Kult Games' account for
  // every relayed call, for ANY player address (unlike a Relayer API Key,
  // which is scoped to one address only). This route never inspects or
  // trusts the payload's contents beyond forwarding it -- fund safety comes
  // entirely from the payload's own signature (a forged WALLET batch fails
  // Polymarket's own EIP-712 check), not from anything checked here. The
  // target URL is hardcoded (not client-supplied) so this can't be turned
  // into an open relay/SSRF proxy.
  app.post(
    '/relayer/submit',
    { onRequest: [jwtMiddleware(app)], config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const key = process.env.POLYMARKET_BUILDER_API_KEY;
      const secret = process.env.POLYMARKET_BUILDER_API_SECRET;
      const passphrase = process.env.POLYMARKET_BUILDER_API_PASSPHRASE;
      if (!key || !secret || !passphrase) {
        return reply.status(503).send({ error: 'Polymarket builder credentials not configured' });
      }

      const body = JSON.stringify(req.body);
      const headers = buildBuilderHeaders(secret, key, passphrase, 'POST', SUBMIT_PATH, body);

      const res = await fetch(`${POLYMARKET_RELAYER_HOST}${SUBMIT_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
      });

      const text = await res.text();
      reply.status(res.status);
      reply.header('Content-Type', res.headers.get('content-type') ?? 'application/json');
      return reply.send(text);
    },
  );
}
