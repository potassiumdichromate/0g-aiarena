import { FastifyInstance } from 'fastify';
import { FinancialOrchestrator } from '../services/financial-orchestrator';

const orchestrator = new FinancialOrchestrator();

export async function transactionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/:agentId', async (req) => {
    const { agentId } = req.params as { agentId: string };
    const { page, limit } = req.query as { page?: string; limit?: string };
    return orchestrator.getTransactions(agentId, Number(page) || 1, Number(limit) || 20);
  });

  app.post('/stake', async (req, reply) => {
    const { agentId, amount } = req.body as { agentId: string; amount: number };
    const result = await orchestrator.createStake(agentId, amount);
    return reply.status(201).send({ result });
  });

  app.get('/stakes/:agentId', async (req) => {
    const { agentId } = req.params as { agentId: string };
    return orchestrator.getStakes(agentId);
  });
}
