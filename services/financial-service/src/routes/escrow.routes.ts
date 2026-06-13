import { FastifyInstance } from 'fastify';
import { EscrowService } from '../services/escrow.service';

const escrow = new EscrowService();

export async function escrowRoutes(app: FastifyInstance): Promise<void> {

  /**
   * POST /escrow/lock
   * Called by battle-service when a WAGER battle is created.
   * Locks stakeAmount from both agents.
   */
  app.post('/lock', async (req, reply) => {
    const { agentId1, agentId2, stakeAmount, battleId } = req.body as {
      agentId1:    string;
      agentId2:    string;
      stakeAmount: number;
      battleId:    string;
    };
    try {
      const result = await escrow.lockEscrow(agentId1, agentId2, stakeAmount, battleId);
      return reply.status(201).send({ ok: true, data: result });
    } catch (err: any) {
      return reply.status(400).send({ ok: false, error: err.message });
    }
  });

  /**
   * POST /escrow/settle
   * Called by battle-service when a battle ends.
   * Pays winner 90%, keeps 10% as platform commission.
   */
  app.post('/settle', async (req, reply) => {
    const { battleId, winnerId } = req.body as { battleId: string; winnerId: string };
    try {
      const result = await escrow.settleEscrow(battleId, winnerId);
      return reply.status(200).send({ ok: true, data: result });
    } catch (err: any) {
      return reply.status(400).send({ ok: false, error: err.message });
    }
  });

  /**
   * POST /escrow/league/lock
   * Called by league-service when a battle challenge is accepted (§9.2).
   * Locks `stakeArena` from both the challenger and opponent wallets and
   * transitions the battle PENDING -> LOCKED within this call.
   * Body: { battleId }
   */
  app.post('/league/lock', async (req, reply) => {
    const { battleId } = req.body as { battleId: string };
    try {
      const result = await escrow.lockLeagueEscrow(battleId);
      return reply.status(200).send({ ok: true, data: result });
    } catch (err: any) {
      return reply.status(400).send({ ok: false, error: err.message });
    }
  });

  /**
   * POST /escrow/league/credit
   * Called by league-worker when a settled League prediction earns
   * `arenaAwarded > 0` (§5.6/§10.2 step 4). Idempotent per predictionId.
   * Body: { agentId, predictionId, amount, metadata }
   */
  app.post('/league/credit', async (req, reply) => {
    const { agentId, predictionId, amount, metadata } = req.body as {
      agentId:      string;
      predictionId: string;
      amount:       number;
      metadata?:    Record<string, unknown>;
    };
    try {
      await escrow.creditLeaguePrediction(agentId, predictionId, amount, metadata ?? {});
      return reply.status(200).send({ ok: true });
    } catch (err: any) {
      return reply.status(400).send({ ok: false, error: err.message });
    }
  });

  /**
   * POST /escrow/league/battles/settle
   * Called by league-worker once both predictions on a LOCKED League Battle
   * have settled (§9.3), or when a match is cancelled (§9.4, winnerId null).
   * Body: { battleId, winnerId }
   */
  app.post('/league/battles/settle', async (req, reply) => {
    const { battleId, winnerId } = req.body as { battleId: string; winnerId: string | null };
    try {
      await escrow.settleLeagueBattle(battleId, winnerId);
      return reply.status(200).send({ ok: true });
    } catch (err: any) {
      return reply.status(400).send({ ok: false, error: err.message });
    }
  });

  /**
   * POST /escrow/x402/pay
   * Initiate an x402 payment from the agent's custodial ARENA wallet.
   *
   * Called by the frontend x402 interceptor when it receives a 402 response.
   * Deducts the ARENA amount up-front from the agent's on-platform balance
   * and returns a synthetic txHash that the client sends back as the payment proof.
   *
   * Body: { agentId, amount, purpose }
   * Response: { ok, txHash, agentId }
   */
  app.post('/x402/pay', async (req, reply) => {
    const { agentId, amount, purpose } = req.body as {
      agentId: string;
      amount:  number;
      purpose: string;
    };
    if (!agentId || !amount || !purpose) {
      return reply.status(400).send({ ok: false, error: 'agentId, amount, and purpose are required' });
    }
    try {
      const result = await escrow.initiateX402Payment(agentId, amount, purpose);
      return reply.status(200).send({ ok: true, txHash: result.txHash, agentId });
    } catch (err: any) {
      return reply.status(400).send({ ok: false, error: err.message });
    }
  });

  /**
   * POST /escrow/x402/verify
   * Verify an x402 payment proof.
   * Called by the API Gateway x402 middleware.
   *
   * x402 flow:
   *   1. Agent hits a paid endpoint (e.g. POST /v1/matchmaking with mode=WAGER)
   *   2. Gateway returns 402 + payment requirements
   *   3. Agent pays and retries with X-Payment-Tx-Hash header
   *   4. Gateway calls this endpoint to verify
   *   5. On success, gateway lets the request through
   */
  app.post('/x402/verify', async (req, reply) => {
    const { txHash, agentId, amount, purpose } = req.body as {
      txHash:  string;
      agentId: string;
      amount:  number;
      purpose: string;
    };
    try {
      const result = await escrow.verifyX402Payment(txHash, agentId, amount);
      if (!result.valid) {
        return reply.status(402).send({ ok: false, error: result.reason });
      }
      // Charge the payment
      await escrow.chargeX402(txHash, agentId, amount, purpose);
      return reply.status(200).send({ ok: true });
    } catch (err: any) {
      return reply.status(400).send({ ok: false, error: err.message });
    }
  });

  /**
   * GET /escrow/x402/requirements
   * Returns payment requirements for a given action.
   * Used by the 402 response body.
   */
  app.get('/x402/requirements', async (req) => {
    const { action } = req.query as { action?: string };

    const FEES: Record<string, { amount: number; description: string }> = {
      'wager_battle':  { amount: 5,    description: 'Wager battle entry stake (5 $ARENA per agent)' },
      'train_agent':   { amount: 2,    description: 'Training compute fee (2 $ARENA)' },
      'clone_agent':   { amount: 10,   description: 'Agent clone fee (10 $ARENA)' },
      'inference':     { amount: 0.01, description: 'Per-inference compute fee (0.01 $ARENA)' },
    };

    const fee = FEES[action ?? ''] ?? FEES['wager_battle'];

    return {
      version:     'x402/1.0',
      currency:    'ARENA',
      network:     'solana-devnet',
      ...fee,
      payTo:       process.env.PLATFORM_WALLET_ADDRESS ?? 'PLATFORM_ESCROW_ADDRESS',
      instructions: [
        '1. Transfer the required $ARENA from your agent wallet',
        '2. Retry the original request with header: X-Payment-Tx-Hash: <your_tx_hash>',
        '3. Also include: X-Payment-Agent-Id: <your_agent_id>',
      ],
    };
  });
}
