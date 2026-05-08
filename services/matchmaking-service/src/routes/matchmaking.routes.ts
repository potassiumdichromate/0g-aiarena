import { FastifyInstance } from 'fastify';
import { Matchmaker } from '../services/matchmaker';

const matchmaker = new Matchmaker();

export async function matchmakingRoutes(app: FastifyInstance): Promise<void> {
  app.post('/', async (req, reply) => {
    const { agentId, gameId, mode, eloRange } = req.body as {
      agentId: string; gameId: string; mode: string; eloRange?: number;
    };
    await matchmaker.joinQueue(agentId, gameId, mode, eloRange ?? 200);
    return reply.status(202).send({ queued: true, agentId });
  });

  app.delete('/:agentId', async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    await matchmaker.leaveQueue(agentId);
    return { left: true };
  });

  app.get('/status/:agentId', async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    const status = await matchmaker.getQueueStatus(agentId);
    return { status };
  });

  app.post('/match/direct', async (req, reply) => {
    const { agentId, opponentId, gameId, mode } = req.body as {
      agentId: string; opponentId: string; gameId: string; mode: string;
    };
    const match = await matchmaker.directChallenge(agentId, opponentId, gameId, mode);
    return reply.status(201).send({ match });
  });
}
