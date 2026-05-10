/**
 * MemoryManager — 4-tier agent memory with 0G Storage archival.
 *
 * Tiers:
 *   1. Working     — Redis (hot, sub-ms, 1h TTL per battle tick)
 *   2. Episodic    — Postgres + Qdrant (battle episodes, RAG retrieval)
 *   3. Semantic    — Qdrant (abstracted patterns, long-term vector search)
 *   4. Procedural  — 0G Storage (full memory snapshots, model weights)
 *
 * 0G Storage usage:
 *   - compactMemory()     → serialise full memory state → upload → rootHash
 *   - storeEpisode()      → after Qdrant upsert, snapshot to 0G Storage
 *   - getMemorySnapshot() → download by rootHash for cold-start or replay
 *
 * On-chain anchoring:
 *   - After each snapshot upload, call inft-service to update INFT memoryRootHash
 *   - This makes the memory cryptographically verifiable on 0G Chain
 */

import { prisma } from '@ai-arena/db-client';
import { getQdrantClient, COLLECTIONS } from '@ai-arena/vector-db';
import { getRedisClient, CACHE_KEYS } from '@ai-arena/cache';
import { ZeroGStorageClient, getZeroGConfig } from '@ai-arena/zerog-client';

export class MemoryManager {
  private readonly qdrant  = getQdrantClient();
  private readonly redis   = getRedisClient();
  private readonly storage = new ZeroGStorageClient(getZeroGConfig());

  // ── Tier 1: Working Memory (Redis) ────────────────────────────────────────

  async updateWorkingMemory(agentId: string, state: Record<string, unknown>): Promise<void> {
    const key = CACHE_KEYS.agentWorkingMemory(agentId);
    await this.redis.setexJson(key, 3600, { ...state, agentId, updatedAt: new Date() });
  }

  async getWorkingMemory(agentId: string): Promise<Record<string, unknown> | null> {
    const key = CACHE_KEYS.agentWorkingMemory(agentId);
    return this.redis.getJson(key);
  }

  async clearWorkingMemory(agentId: string): Promise<void> {
    await this.redis.del(CACHE_KEYS.agentWorkingMemory(agentId));
  }

  // ── Tier 2: Episodic Memory (Postgres + Qdrant) ──────────────────────────

  async listMemories(agentId: string, page: number, limit: number, type?: string) {
    const memories = await prisma.agentMemory.findMany({
      where:   { agentId, ...(type && { type }) },
      skip:    (page - 1) * limit,
      take:    limit,
      orderBy: { importance: 'desc' },
    });
    const total = await prisma.agentMemory.count({ where: { agentId } });
    return { memories, total, page, limit };
  }

  async storeEpisode(agentId: string, episode: {
    battleId: string;
    outcome:  string;
    content:  string;
    vector?:  number[];
  }): Promise<{ memoryId: string; snapshotRootHash?: string }> {
    const importance = episode.outcome === 'WIN' ? 0.8 : 0.6;

    // Write to Postgres
    const memory = await prisma.agentMemory.create({
      data: {
        agentId,
        type:       'EPISODIC',
        content:    episode.content,
        importance,
        metadata:   { battleId: episode.battleId, outcome: episode.outcome },
        embedding:  episode.vector ?? [],
      },
    });

    // Upsert to Qdrant only when a real embedding vector is provided.
    // Without a vector, the episode still lives in Postgres; callers must supply
    // an embedding (e.g. from inference-service) for RAG retrieval to work.
    if (episode.vector && episode.vector.length > 0) {
      await this.qdrant.upsertVector(COLLECTIONS.AGENT_MEMORIES, {
        id:      memory.id,
        vector:  episode.vector,
        payload: {
          agentId,
          type:      'EPISODIC',
          content:   episode.content,
          battleId:  episode.battleId,
          outcome:   episode.outcome,
          importance,
        },
      });
    } else {
      console.warn(`[MemoryManager] storeEpisode: no embedding vector for memory ${memory.id} — skipping Qdrant upsert`);
    }

    // Upload episode snapshot to 0G Storage (async — don't block response)
    let snapshotRootHash: string | undefined;
    try {
      snapshotRootHash = await this._uploadEpisodeSnapshot(agentId, memory.id, episode);
    } catch (err) {
      console.warn('[MemoryManager] Episode snapshot upload to 0G Storage failed:', err);
    }

    return { memoryId: memory.id, snapshotRootHash };
  }

  async retrieveRelevant(agentId: string, queryVector: number[], limit: number) {
    return this.qdrant.search(
      COLLECTIONS.AGENT_MEMORIES,
      queryVector,
      { must: [{ key: 'agentId', match: { value: agentId } }] },
      limit,
    );
  }

  // ── Tier 4: Procedural Memory (0G Storage) ──────────────────────────────

  /**
   * Compact + snapshot the agent's full memory state to 0G Storage.
   * Returns the rootHash — call inft-service to anchor this on-chain.
   *
   * Called:
   *   - After a battle ends (by battle-service via NATS event)
   *   - Periodically by a cron job
   *   - Before model fine-tuning (to freeze the memory state)
   */
  async compactMemory(agentId: string): Promise<{ rootHash: string; archivedCount: number }> {
    // Purge expired memories
    await prisma.agentMemory.deleteMany({
      where: { agentId, expiresAt: { lt: new Date() } },
    });

    // Load all current memories
    const allMemories = await prisma.agentMemory.findMany({
      where:   { agentId },
      orderBy: { importance: 'desc' },
      take:    500,
    });

    const workingMemory = await this.getWorkingMemory(agentId);

    // Build the full memory snapshot
    const snapshot = {
      agentId,
      snapshotAt:    new Date().toISOString(),
      episodicCount: allMemories.length,
      memories:      allMemories.map(m => ({
        id:          m.id,
        type:        m.type,
        content:     m.content,
        importance:  m.importance,
        accessCount: m.accessCount,
        metadata:    m.metadata,
        createdAt:   m.createdAt,
      })),
      workingMemory: workingMemory ?? {},
    };

    const buf = Buffer.from(JSON.stringify(snapshot), 'utf8');

    // Upload to 0G Storage
    const { rootHash, txHash } = await this.storage.uploadBuffer(buf);

    // Index under logical path
    const logicalPath = `agents/${agentId}/memory/snapshot-latest`;
    await prisma.storageIndex.upsert({
      where:  { logicalPath },
      update: { rootHash, txHash: [txHash].flat()[0] ?? null, sizeBytes: buf.byteLength },
      create: {
        logicalPath,
        rootHash,
        txHash:     [txHash].flat()[0] ?? null,
        mimeType:   'application/json',
        sizeBytes:  buf.byteLength,
        uploadedBy: 'memory-service',
        tags:       ['memory-snapshot', agentId],
      },
    });

    // Also keep a versioned copy
    const versionPath = `agents/${agentId}/memory/snapshot-${Date.now()}`;
    await prisma.storageIndex.create({
      data: {
        logicalPath: versionPath,
        rootHash,
        txHash:     [txHash].flat()[0] ?? null,
        mimeType:   'application/json',
        sizeBytes:  buf.byteLength,
        uploadedBy: 'memory-service',
        tags:       ['memory-snapshot', 'versioned', agentId],
      },
    });

    // Archive old low-importance episodes from Postgres (they're now in 0G Storage)
    const toArchive = allMemories
      .filter(m => m.importance < 0.3 && m.type === 'EPISODIC')
      .slice(0, 100)
      .map(m => m.id);

    if (toArchive.length > 0) {
      await prisma.agentMemory.deleteMany({ where: { id: { in: toArchive } } });
    }

    return { rootHash, archivedCount: toArchive.length };
  }

  /**
   * Download a memory snapshot from 0G Storage.
   * Used for cold-start (agent rejoining), replay, or fine-tuning dataset prep.
   */
  async getMemorySnapshot(agentId: string, rootHash?: string): Promise<Record<string, unknown>> {
    let hash = rootHash;

    if (!hash) {
      const record = await prisma.storageIndex.findUnique({
        where: { logicalPath: `agents/${agentId}/memory/snapshot-latest` },
      });
      if (!record) throw new Error(`No memory snapshot found for agent ${agentId}`);
      hash = record.rootHash;
    }

    const buf = await this.storage.downloadToBuffer(hash);
    return JSON.parse(buf.toString('utf8'));
  }

  /**
   * List all memory snapshot versions stored for an agent on 0G Storage.
   */
  async listSnapshots(agentId: string) {
    return prisma.storageIndex.findMany({
      where:   { logicalPath: { startsWith: `agents/${agentId}/memory/` } },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private async _uploadEpisodeSnapshot(
    agentId: string,
    memoryId: string,
    episode: { battleId: string; outcome: string; content: string },
  ): Promise<string> {
    const data = {
      memoryId,
      agentId,
      battleId:   episode.battleId,
      outcome:    episode.outcome,
      content:    episode.content,
      uploadedAt: new Date().toISOString(),
    };

    const buf = Buffer.from(JSON.stringify(data), 'utf8');
    const { rootHash, txHash } = await this.storage.uploadBuffer(buf);

    await prisma.storageIndex.create({
      data: {
        logicalPath: `agents/${agentId}/memory/episodes/${memoryId}`,
        rootHash,
        txHash:     [txHash].flat()[0] ?? null,
        mimeType:   'application/json',
        sizeBytes:  buf.byteLength,
        uploadedBy: 'memory-service',
        tags:       ['episode', agentId, episode.battleId],
      },
    });

    return rootHash;
  }
}
