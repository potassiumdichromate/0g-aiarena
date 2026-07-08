import { FastifyInstance } from 'fastify';
import { FinancialOrchestrator } from '../services/financial-orchestrator';
import { arenaChain, ArenaChainError } from '../services/arena-chain.client';

const orchestrator = new FinancialOrchestrator();

export async function walletRoutes(app: FastifyInstance): Promise<void> {
  // GET — auto-creates wallet on first access if agent exists
  app.get('/:agentId', async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    const wallet = await orchestrator.getWallet(agentId);
    if (!wallet) return reply.status(404).send({ error: 'Agent not found' });
    return { wallet };
  });

  // POST /wallets/ensure/:agentId — idempotent wallet creation (called by agent-service)
  app.post('/ensure/:agentId', async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    const wallet = await orchestrator.ensureWallet(agentId);
    if (!wallet) return reply.status(404).send({ error: 'Agent not found' });
    return reply.status(201).send({ wallet });
  });

  app.post('/:agentId/policy', async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    const policy = req.body as Record<string, unknown>;
    const updated = await orchestrator.updatePolicy(agentId, policy);
    return { wallet: updated };
  });

  app.post('/deposits', async (req, reply) => {
    const { agentId, amount, currency, txHash } = req.body as { agentId: string; amount: number; currency: string; txHash: string };
    const result = await orchestrator.processDeposit(agentId, amount, currency, txHash);
    return reply.status(201).send({ result });
  });

  app.post('/withdrawals', async (req, reply) => {
    const { agentId, amount, destination } = req.body as { agentId: string; amount: number; destination: string };
    const result = await orchestrator.initiateWithdrawal(agentId, amount, destination);
    return reply.status(202).send({ result });
  });

  /**
   * POST /wallets/permit — public relay for a player's signed $ARENA
   * EIP-2612 permit (see useArenaStaking.ts). The browser can't hold
   * arena-chain-service's X-Service-Key directly, so it posts the signed
   * permit here instead; this service (which already holds that key for
   * escrow create/join/settle) forwards it on. Fund safety doesn't depend on
   * this route's own auth — ArenaToken.permit() only succeeds if `v/r/s`
   * actually recovers to `owner`, so no one can authorize spending on
   * another player's behalf no matter what they send here.
   */
  app.post('/permit', async (req, reply) => {
    const { owner, spender, value, deadline, v, r, s } = req.body as {
      owner: string; spender: string; value: string; deadline: number; v: number; r: string; s: string;
    };
    try {
      const result = await arenaChain.permit({ owner, spender, value, deadline, v, r, s });
      return reply.send(result);
    } catch (err) {
      const status = err instanceof ArenaChainError ? err.status ?? 400 : 400;
      return reply.status(status).send({ error: err instanceof Error ? err.message : 'permit relay failed' });
    }
  });
}
