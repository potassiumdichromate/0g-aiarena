import { FastifyInstance } from 'fastify';
import { FinancialOrchestrator } from '../services/financial-orchestrator';

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
}
