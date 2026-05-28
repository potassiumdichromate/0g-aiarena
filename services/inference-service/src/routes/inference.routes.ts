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

  /**
   * POST /v1/inference/battle-commentary
   *
   * Generate a dramatic battle commentary paragraph via 0G Compute.
   * Called by the React frontend after the Unity match ends.
   * The output should be stored as an agent memory episode.
   */
  app.post('/battle-commentary', async (req, reply) => {
    const body = req.body as {
      battleId:        string;
      winnerName:      string;
      winnerArchetype: string;
      winnerClan:      string;
      winnerElo:       number;
      winnerHpPercent: number;
      loserName:       string;
      loserArchetype:  string;
      loserClan:       string;
      loserElo:        number;
      loserHpPercent:  number;
      durationSeconds: number;
      endReason:       string;
      playerStats?:    Record<string, {
        jumps: number;
        shotsAttempted: number;
        shotsConnected: number;
        timesHit:       number;
        distanceCovered: number;
      }>;
    };

    if (!body?.battleId || !body?.winnerName || !body?.loserName) {
      return reply.status(400).send({ error: 'battleId, winnerName, and loserName are required' });
    }

    const result = await gateway.generateBattleCommentary(body);
    return { commentary: result.commentary, teeVerified: result.teeVerified };
  });
}
