import { FastifyInstance } from 'fastify';
import { BattleOrchestrator } from '../services/battle-orchestrator';

const orchestrator = new BattleOrchestrator();

export async function battleRoutes(app: FastifyInstance): Promise<void> {
  app.post('/', async (req, reply) => {
    const body = req.body as { agentId: string; opponentId: string; mode: string; gameId: string; wagerAmount?: number };
    const battle = await orchestrator.createBattle(body);
    return reply.status(201).send({ battle });
  });

  app.get('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const battle = await orchestrator.getBattle(id);
    if (!battle) return reply.status(404).send({ error: 'Battle not found' });
    return { battle };
  });

  app.post('/:id/dispute', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { reason } = req.body as { reason: string };
    await orchestrator.disputeBattle(id, reason);
    return { success: true };
  });

  // WebSocket battle stream
  app.get('/ws/battle/:id', { websocket: true }, (connection, req) => {
    const { id } = req.params as { id: string };
    connection.socket.on('message', (msg) => {
      // Broadcast state updates to battle participants
      connection.socket.send(JSON.stringify({ type: 'STATE_UPDATE', battleId: id }));
    });
    connection.socket.on('close', () => {
      console.log(`WebSocket closed for battle ${id}`);
    });
  });
}
