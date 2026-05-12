/**
 * x402 Payment Middleware
 *
 * Implements the HTTP 402 Payment Required standard for AI agent micropayments.
 *
 * How it works:
 *   1. Agent sends request to a paid endpoint (e.g. POST /v1/matchmaking with mode=WAGER)
 *   2. This middleware checks for the X-Payment-Tx-Hash header
 *   3. If missing → returns 402 with payment requirements (amount, currency, instructions)
 *   4. Agent pays $ARENA from its wallet and retries with payment proof headers
 *   5. Middleware verifies with financial-service → request proceeds
 *
 * x402 Request Headers (on retry):
 *   X-Payment-Tx-Hash  — the Solana/EVM tx hash proving payment
 *   X-Payment-Agent-Id — the agent ID making the payment
 *
 * x402 Response Headers (on 402):
 *   X-Payment-Required — "true"
 *   X-Payment-Amount   — amount in $ARENA
 *   X-Payment-Currency — "ARENA"
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

// Endpoint → required payment mapping
const X402_ROUTES: Array<{
  method:  string;
  path:    RegExp;
  action:  string;
  amount:  number;
  when?:   (req: FastifyRequest) => boolean; // conditional — only charge when true
}> = [
  {
    method: 'POST',
    path:   /^\/v1\/matchmaking$/,
    action: 'wager_battle',
    amount: 5,
    when:   (req) => {
      const body = req.body as Record<string, unknown> | undefined;
      return body?.mode === 'WAGER';
    },
  },
  {
    method: 'POST',
    path:   /^\/v1\/agents\/[^/]+\/train$/,
    action: 'train_agent',
    amount: 2,
  },
  {
    method: 'POST',
    path:   /^\/v1\/agents\/[^/]+\/clone$/,
    action: 'clone_agent',
    amount: 10,
  },
];

const FINANCIAL_SERVICE_URL = process.env.FINANCIAL_SERVICE_URL ?? 'http://localhost:8005';

export function registerX402Middleware(app: FastifyInstance): void {
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    // Find matching paid route
    const rule = X402_ROUTES.find(
      (r) =>
        r.method === req.method &&
        r.path.test(req.url) &&
        (!r.when || r.when(req)),
    );

    if (!rule) return; // not a paid endpoint

    const txHash  = req.headers['x-payment-tx-hash']  as string | undefined;
    const agentId = req.headers['x-payment-agent-id'] as string | undefined;

    // ── No payment header → return 402 ────────────────────────────────────────
    if (!txHash || !agentId) {
      reply.header('X-Payment-Required', 'true');
      reply.header('X-Payment-Amount',   String(rule.amount));
      reply.header('X-Payment-Currency', 'ARENA');
      reply.header('X-Payment-Action',   rule.action);

      return reply.status(402).send({
        statusCode:   402,
        error:        'Payment Required',
        message:      `This endpoint requires ${rule.amount} $ARENA payment.`,
        payment: {
          version:     'x402/1.0',
          action:      rule.action,
          amount:      rule.amount,
          currency:    'ARENA',
          network:     process.env.SOLANA_NETWORK ?? 'devnet',
          payTo:       process.env.PLATFORM_WALLET_ADDRESS ?? 'PLATFORM_ESCROW_ADDRESS',
          instructions: [
            `Step 1: Transfer ${rule.amount} ARENA from your agent wallet to the payTo address`,
            'Step 2: Retry this request with the following headers:',
            '  X-Payment-Tx-Hash: <your_solana_tx_hash>',
            '  X-Payment-Agent-Id: <your_agent_id>',
          ],
          requirements_url: `${FINANCIAL_SERVICE_URL}/escrow/x402/requirements?action=${rule.action}`,
        },
      });
    }

    // ── Payment header present → verify with financial-service ────────────────
    try {
      const res = await fetch(`${FINANCIAL_SERVICE_URL}/escrow/x402/verify`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          txHash,
          agentId,
          amount:  rule.amount,
          purpose: rule.action,
        }),
      });

      if (!res.ok) {
        const body = await res.json() as { error?: string };
        reply.header('X-Payment-Required', 'true');
        return reply.status(402).send({
          statusCode: 402,
          error:      'Payment Verification Failed',
          message:    body.error ?? 'Could not verify payment',
        });
      }

      // Payment verified — attach to request for downstream use
      (req as any).x402 = { verified: true, agentId, txHash, amount: rule.amount, action: rule.action };
      reply.header('X-Payment-Verified', 'true');

    } catch (err) {
      // Financial service unreachable — fail open in dev, fail closed in prod
      if (process.env.NODE_ENV === 'production') {
        return reply.status(503).send({
          statusCode: 503,
          error:      'Service Unavailable',
          message:    'Payment verification service is unavailable',
        });
      }
      console.warn('[x402] Financial service unreachable — skipping payment check (dev mode)');
    }
  });
}
