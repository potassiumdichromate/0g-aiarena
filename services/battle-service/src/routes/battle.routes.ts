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

  /**
   * POST /battles/:id/start — called by matchmaking-service via direct HTTP
   * (NATS-free path, same pattern as INFT mint).
   * Transitions the battle from PENDING → IN_PROGRESS.
   */
  app.post('/:id/start', async (req, reply) => {
    const { id } = req.params as { id: string };
    const serviceKey = req.headers['x-service-key'] as string | undefined;
    const expected   = process.env.INTERNAL_SERVICE_SECRET;
    if (expected && serviceKey !== expected) {
      return reply.status(403).send({ error: 'Forbidden' });
    }
    const battle = await orchestrator.getBattle(id);
    if (!battle) return reply.status(404).send({ error: 'Battle not found' });
    if (battle.status !== 'PENDING') {
      // Already started or finished — idempotent OK
      return { started: false, status: battle.status, battleId: id };
    }
    await orchestrator.startBattle(id);
    return { started: true, battleId: id };
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
