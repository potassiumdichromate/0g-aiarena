import { FastifyInstance } from 'fastify';
import { MemoryManager } from '../services/memory-manager';

const memoryManager = new MemoryManager();

export async function memoryRoutes(app: FastifyInstance): Promise<void> {
  app.get('/:agentId/memory', async (req) => {
    const { agentId } = req.params as { agentId: string };
    const { page, limit, type } = req.query as { page?: string; limit?: string; type?: string };
    return memoryManager.listMemories(agentId, Number(page) || 1, Number(limit) || 20, type);
  });

  app.post('/:agentId/memory/working', async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    const state = req.body as Record<string, unknown>;
    await memoryManager.updateWorkingMemory(agentId, state);
    return { updated: true };
  });

  app.post('/:agentId/memory/episode', async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    const episode = req.body as { battleId: string; outcome: string; content: string };
    await memoryManager.storeEpisode(agentId, episode);
    return reply.status(201).send({ stored: true });
  });

  app.get('/:agentId/memory/retrieve', async (req) => {
    const { agentId } = req.params as { agentId: string };
    const { query, limit } = req.query as { query: string; limit?: string };
    // query may be a JSON-encoded embedding vector or a raw text string.
    // For vector search we need number[]; parse if possible, else use empty vec.
    let queryVec: number[];
    try {
      const parsed = JSON.parse(query);
      queryVec = Array.isArray(parsed) ? parsed : [];
    } catch {
      queryVec = []; // caller must supply pre-computed embedding for real results
    }
    const memories = await memoryManager.retrieveRelevant(agentId, queryVec, Number(limit) || 5);
    return { memories };
  });

  app.post('/:agentId/memory/compact', async (req, reply) => {
    const { agentId } = req.params as { agentId: string };
    await memoryManager.compactMemory(agentId);
    return reply.status(202).send({ compacting: true });
  });

  app.delete('/:agentId/memory/working', async (req) => {
    const { agentId } = req.params as { agentId: string };
    await memoryManager.clearWorkingMemory(agentId);
    return { cleared: true };
  });
}
