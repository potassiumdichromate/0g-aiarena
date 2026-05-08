import { FastifyInstance } from 'fastify';
import { LeaderboardService } from '../services/leaderboard.service';

const svc = new LeaderboardService();

export async function leaderboardRoutes(app: FastifyInstance): Promise<void> {
  app.get('/:id', async (req) => {
    const { id } = req.params as { id: string };
    const { limit } = req.query as { limit?: string };
    return svc.getLeaderboard(id, Number(limit) || 100);
  });

  app.post('/:id/refresh', async (req, reply) => {
    const { id } = req.params as { id: string };
    await svc.refreshLeaderboard(id);
    return reply.status(202).send({ refreshing: true });
  });

  app.get('/:id/rank/:agentId', async (req) => {
    const { id, agentId } = req.params as { id: string; agentId: string };
    return svc.getAgentRank(id, agentId);
  });
}
