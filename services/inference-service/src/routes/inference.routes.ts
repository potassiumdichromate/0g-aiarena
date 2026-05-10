import { FastifyInstance } from 'fastify';
import { InferenceGateway } from '../services/inference-gateway';

const gateway = new InferenceGateway();

export async function inferenceRoutes(app: FastifyInstance): Promise<void> {
  app.post('/combat-action', async (req, reply) => {
    const body = req.body as {
      agentId: string;
      battleId: string;
      modelVersion?: string;
      battleState: Record<string, unknown>;
      opponentProfile?: Record<string, unknown>;
      memoryContext?: string[];
      timeoutMs?: number;
    };
    const action = await gateway.inferCombatAction(body);
    return { action };
  });

  app.post('/strategy-plan', async (req, reply) => {
    const body = req.body as {
      agentId: string;
      battleContext: Record<string, unknown>;
      opponentProfile?: Record<string, unknown>;
      useMemory?: boolean;
    };
    const plan = await gateway.inferStrategyPlan(body);
    return { plan };
  });

  app.post('/personality', async (req, reply) => {
    const seed = req.body as { name: string; description: string; clan: string; hints?: Record<string, number> };
    const personality = await gateway.generatePersonality(seed);
    return { personality };
  });

  app.get('/models/:agentId', async (req) => {
    const { agentId } = req.params as { agentId: string };
    const model = await gateway.getActiveModel(agentId);
    return { model };
  });
}
