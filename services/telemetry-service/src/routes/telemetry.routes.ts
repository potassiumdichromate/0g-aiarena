import { FastifyInstance } from 'fastify';
import { IngestionService } from '../services/ingestion.service';
import { validateBatch } from '@ai-arena/telemetry-protocol';

const ingestionService = new IngestionService();

export async function telemetryRoutes(app: FastifyInstance): Promise<void> {
  app.post('/start', async (req, reply) => {
    const { agentId, gameId, battleId } = req.body as { agentId: string; gameId: string; battleId?: string };
    const session = await ingestionService.startSession(agentId, gameId, battleId);
    return reply.status(201).send({ session });
  });

  app.post('/:id/end', async (req, reply) => {
    const { id } = req.params as { id: string };
    await ingestionService.endSession(id);
    return { success: true };
  });

  app.post('/:id/batch', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body;
    const { valid, errors, batch } = validateBatch(body);
    if (!valid) return reply.status(400).send({ errors });
    await ingestionService.processBatch(id, batch!);
    return { received: batch!.events.length };
  });

  // WebSocket streaming
  app.get('/ws/stream', { websocket: true }, (connection, req) => {
    connection.socket.on('message', async (msg) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data.type === 'BATCH') {
          const { valid, batch } = validateBatch(data.payload);
          if (valid && batch) {
            await ingestionService.processBatch(batch.sessionId, batch);
            connection.socket.send(JSON.stringify({ type: 'ACK', batchId: batch.batchId }));
          }
        }
      } catch (err) {
        connection.socket.send(JSON.stringify({ type: 'ERROR', message: 'Invalid payload' }));
      }
    });
  });
}
