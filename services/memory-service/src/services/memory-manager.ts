import { prisma } from '@ai-arena/db-client';
import { getQdrantClient, COLLECTIONS } from '@ai-arena/vector-db';
import { getRedisClient, CACHE_KEYS } from '@ai-arena/cache';

export class MemoryManager {
  private readonly qdrant = getQdrantClient();
  private readonly redis = getRedisClient();

  async listMemories(agentId: string, page: number, limit: number, type?: string) {
    const memories = await prisma.agentMemory.findMany({
      where: { agentId, ...(type && { type }) },
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { importance: 'desc' },
    });
    const total = await prisma.agentMemory.count({ where: { agentId } });
    return { memories, total, page, limit };
  }

  async updateWorkingMemory(agentId: string, state: Record<string, unknown>): Promise<void> {
    const key = CACHE_KEYS.agentWorkingMemory(agentId);
    await this.redis.setexJson(key, 3600, { ...state, agentId, updatedAt: new Date() });
  }

  async clearWorkingMemory(agentId: string): Promise<void> {
    await this.redis.del(CACHE_KEYS.agentWorkingMemory(agentId));
  }

  async storeEpisode(agentId: string, episode: { battleId: string; outcome: string; content: string }): Promise<void> {
    const memory = await prisma.agentMemory.create({
      data: {
        agentId,
        type: 'EPISODIC',
        content: episode.content,
        importance: episode.outcome === 'WIN' ? 0.8 : 0.6,
        metadata: { battleId: episode.battleId, outcome: episode.outcome },
      },
    });

    // Upsert to Qdrant for RAG retrieval
    // In production, embedding would be generated via embedding-service
    // Using a placeholder vector here
    const placeholderVector = new Array(1024).fill(0).map(() => Math.random() - 0.5);
    await this.qdrant.upsertVector(COLLECTIONS.AGENT_MEMORIES, {
      id: memory.id,
      vector: placeholderVector,
      payload: { agentId, type: 'EPISODIC', content: episode.content, battleId: episode.battleId },
    });
  }

  async retrieveRelevant(agentId: string, query: string, limit: number) {
    // In production, query would be embedded via embedding-service
    const queryVector = new Array(1024).fill(0).map(() => Math.random() - 0.5);
    const results = await this.qdrant.search(
      COLLECTIONS.AGENT_MEMORIES,
      queryVector,
      { must: [{ key: 'agentId', match: { value: agentId } }] },
      limit
    );
    return results;
  }

  async compactMemory(agentId: string): Promise<void> {
    // Archive old low-importance memories
    const old = await prisma.agentMemory.findMany({
      where: { agentId, importance: { lt: 0.3 }, type: 'EPISODIC' },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });

    // Delete expired memories
    await prisma.agentMemory.deleteMany({
      where: { agentId, expiresAt: { lt: new Date() } },
    });
  }
}
