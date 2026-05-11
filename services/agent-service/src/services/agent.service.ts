/**
 * AgentService — agent lifecycle with full 0G integration.
 *
 * 0G Storage usage:
 *   - Avatar PNG → upload → rootHash stored in agent metadata + storage_index
 *   - Encrypted metadata blob → upload → rootHash used for INFT minting
 *
 * 0G Compute usage:
 *   - generatePersonality({ name, description, clan, hints }) — structured traits
 *   - generateAvatar({ agentId, name, combatArchetype, clan, ... }) — b64_json PNG
 *
 * Flow on createAgent:
 *   1. Generate personality traits via 0G Compute
 *   2. Generate avatar PNG via 0G Compute (z-image)
 *   3. Upload avatar to 0G Storage → get avatarRootHash
 *   4. Build metadata blob → upload to 0G Storage → get metadataRootHash
 *   5. Persist agent to Postgres with rootHashes
 *   6. Emit AGENT_CREATED event (inft-service mints the INFT)
 */

import { prisma, AgentRepository } from '@ai-arena/db-client';
import { getEventBus, SUBJECTS } from '@ai-arena/event-bus';
import {
  getZeroGConfig,
  ZeroGComputeClient,
  ZeroGStorageClient,
} from '@ai-arena/zerog-client';

const agentRepo = new AgentRepository(prisma);

/** Run a promise with a timeout — rejects with TimeoutError if it takes too long. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout: ${label} took longer than ${ms}ms`)), ms),
    ),
  ]);
}

export class AgentService {
  private readonly compute = new ZeroGComputeClient(getZeroGConfig());
  private readonly storage = new ZeroGStorageClient(getZeroGConfig());

  async createAgent(userId: string, params: {
    name: string;
    clan: string;
    archetype?: string;
    backstory?: string;
  }) {
    const archetype = (params.archetype ?? 'hybrid').toLowerCase();

    // ── Step 1: Generate personality traits via 0G Compute ───────────────────
    let traits: Record<string, unknown> = {
      aggression: 50, patience: 50, adaptability: 50,
      resilience: 50, creativity: 50, loyalty: 50, deception: 50, precision: 50,
    };

    try {
      traits = await withTimeout(
        this.compute.generatePersonality({
          name:        params.name,
          description: params.backstory ?? `A ${archetype} agent from the ${params.clan} clan`,
          clan:        params.clan,
          hints:       { aggression: 50, intelligence: 50 },
        }),
        10_000, // 10-second timeout
        'generatePersonality',
      );
    } catch (err) {
      console.warn('[AgentService] 0G Compute unavailable for personality generation, using defaults:', err);
    }

    // ── Step 2: Generate avatar image via 0G Compute ─────────────────────────
    // Skipped unless ENABLE_AVATAR_GEN=true (image gen is slow — skip in local dev)
    let avatarRootHash: string | null = null;
    let avatarBase64: string | null = null;

    if (process.env.ENABLE_AVATAR_GEN === 'true') {
      try {
        const tempId = `temp-${Date.now()}`;
        const avatarResult = await withTimeout(
          this.compute.generateAvatar({
            agentId:         tempId,
            name:            params.name,
            combatArchetype: archetype,
            clan:            params.clan,
            aggressionScore: (traits.aggression as number) ?? 50,
            evolutionStage:  1,
          }),
          20_000,
          'generateAvatar',
        );

        avatarBase64 = avatarResult.base64;

        // ── Step 3: Upload avatar PNG to 0G Storage ─────────────────────────
        const avatarBuf = Buffer.from(avatarResult.base64, 'base64');
        const uploadResult = await this.storage.uploadBuffer(avatarBuf);
        avatarRootHash = uploadResult.rootHash;
        const avatarTxHash = [uploadResult.txHash].flat()[0] ?? null;

        await prisma.storageIndex.upsert({
          where:  { logicalPath: `agents/avatar-pending` },
          update: { rootHash: avatarRootHash, txHash: avatarTxHash, mimeType: 'image/png', sizeBytes: avatarBuf.byteLength },
          create: { logicalPath: `agents/avatar-pending`, rootHash: avatarRootHash, txHash: avatarTxHash, mimeType: 'image/png', sizeBytes: avatarBuf.byteLength },
        });
      } catch (err) {
        console.warn('[AgentService] Avatar generation/upload failed, continuing without avatar:', err);
      }
    } else {
      console.info('[AgentService] Avatar generation skipped (set ENABLE_AVATAR_GEN=true to enable)');
    }

    // ── Step 4: Build + upload metadata blob to 0G Storage ───────────────────
    let metadataRootHash: string | null = null;

    try {
      const metadataBlob = {
        name:          params.name,
        clan:          params.clan,
        archetype,
        backstory:     params.backstory ?? '',
        traits,
        evolutionStage: 1,
        createdAt:     new Date().toISOString(),
        avatarRootHash,
      };

      const metaBuf = Buffer.from(JSON.stringify(metadataBlob), 'utf8');
      const metaUpload = await withTimeout(
        this.storage.uploadBuffer(metaBuf),
        10_000,
        'uploadMetadata',
      );
      metadataRootHash = metaUpload.rootHash;
    } catch (err) {
      console.warn('[AgentService] Metadata upload to 0G Storage failed:', err);
    }

    // ── Step 5: Persist agent to Postgres ────────────────────────────────────
    const agent = await agentRepo.create({
      user:      { connect: { id: userId } },
      name:      params.name,
      clan:      params.clan as any,
      archetype: (params.archetype as any) ?? 'HYBRID',
      traits:    traits as any,
      metadata: {
        backstory:        params.backstory ?? '',
        avatarRootHash,   // 0G Storage root hash for avatar PNG
        metadataRootHash, // 0G Storage root hash for metadata blob
        avatarBase64:     avatarBase64 ? avatarBase64.slice(0, 64) + '...' : null, // truncated for DB
      } as any,
    });

    // Update storage_index with real agentId path now that we have it
    if (avatarRootHash) {
      await prisma.storageIndex.upsert({
        where:  { logicalPath: `agents/${agent.id}/avatar/v1` },
        update: { rootHash: avatarRootHash },
        create: { logicalPath: `agents/${agent.id}/avatar/v1`, rootHash: avatarRootHash, mimeType: 'image/png', uploadedBy: 'agent-service', tags: ['avatar', agent.id] },
      });
      // Clean up temp entry
      await prisma.storageIndex.deleteMany({ where: { logicalPath: 'agents/avatar-pending' } });
    }

    if (metadataRootHash) {
      await prisma.storageIndex.upsert({
        where:  { logicalPath: `agents/${agent.id}/metadata/v1` },
        update: { rootHash: metadataRootHash },
        create: { logicalPath: `agents/${agent.id}/metadata/v1`, rootHash: metadataRootHash, mimeType: 'application/json', uploadedBy: 'agent-service', tags: ['metadata', agent.id] },
      });
    }

    // ── Step 6: Publish event → inft-service will mint the INFT ─────────────
    const bus = await getEventBus();
    await bus.publish(SUBJECTS.AGENT_CREATED, {
      agentId:          agent.id,
      userId,
      metadataRootHash, // inft-service uses this for encryptedMetadataHash
      avatarRootHash,
    });

    return { ...agent, avatarRootHash, metadataRootHash };
  }

  async getAgent(id: string) {
    return agentRepo.findByIdWithRelations(id);
  }

  async listAgents(params: { clan?: string; archetype?: string; page?: number; limit?: number }) {
    return agentRepo.list(params);
  }

  async updateAgent(id: string, userId: string, data: { name?: string; metadata?: Record<string, unknown> }) {
    return agentRepo.update(id, data as any);
  }

  async retireAgent(id: string, userId: string) {
    return agentRepo.retire(id);
  }

  async queueTraining(agentId: string, params: { type?: string; priority?: number }) {
    return prisma.trainingJob.create({
      data: {
        agent:    { connect: { id: agentId } },
        type:     (params.type as any) ?? 'BEHAVIOUR_CLONING',
        priority: params.priority ?? 5,
        config:   {},
      },
    });
  }

  async getTrainingStatus(agentId: string) {
    return prisma.trainingJob.findMany({
      where:   { agentId },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
  }

  async getMemorySummary(agentId: string) {
    const count  = await prisma.agentMemory.count({ where: { agentId } });
    const recent = await prisma.agentMemory.findMany({
      where:   { agentId },
      orderBy: { lastAccessed: 'desc' },
      take: 5,
    });
    return { totalMemories: count, recentMemories: recent };
  }

  /**
   * Fetch avatar from 0G Storage by agent's stored rootHash.
   * Returns base64 PNG.
   */
  async getAvatar(agentId: string): Promise<{ base64: string; rootHash: string } | null> {
    const record = await prisma.storageIndex.findUnique({
      where: { logicalPath: `agents/${agentId}/avatar/v1` },
    });
    if (!record) return null;

    const buf = await this.storage.downloadToBuffer(record.rootHash);
    return { base64: buf.toString('base64'), rootHash: record.rootHash };
  }

  /**
   * Fetch full metadata blob from 0G Storage.
   */
  async getMetadata(agentId: string): Promise<Record<string, unknown> | null> {
    const record = await prisma.storageIndex.findUnique({
      where: { logicalPath: `agents/${agentId}/metadata/v1` },
    });
    if (!record) return null;

    const buf = await this.storage.downloadToBuffer(record.rootHash);
    return JSON.parse(buf.toString('utf8'));
  }

  async cloneAgent(sourceId: string, userId: string) {
    const source = await agentRepo.findById(sourceId);
    if (!source) throw new Error('Source agent not found');
    return this.createAgent(userId, {
      name:      `${source.name} (Clone)`,
      clan:      source.clan,
      archetype: source.archetype,
    });
  }

  async getEvolutionStatus(agentId: string) {
    const agent = await agentRepo.findById(agentId);
    if (!agent) throw new Error('Agent not found');
    return {
      currentStage:         agent.evolutionStage,
      totalBattles:         agent.wins + agent.losses + agent.draws,
      eloRating:            agent.eloRating,
      eligibleForEvolution: agent.wins >= 10 && agent.eloRating >= 1200,
    };
  }
}
