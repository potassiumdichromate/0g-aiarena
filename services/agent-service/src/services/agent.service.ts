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
 *   7. Direct HTTP mint via inft-service (real on-chain INFT mint)
 *   8. On mint success -> arena-chain-service grants the Agent Mint reward
 *      (100 ARENA) directly to the agent owner's 0G-chain wallet
 *      (User.walletAddress) via RewardDistributor.grantAgentMintReward.
 *      This replaces the old off-chain Postgres "starter allocation" —
 *      the reward is now conditioned on and sequenced after a successful
 *      on-chain mint, not granted unconditionally up front.
 */

import { prisma, AgentRepository } from '@ai-arena/db-client';
import { getEventBus, SUBJECTS } from '@ai-arena/event-bus';
import {
  getZeroGConfig,
  ZeroGComputeClient,
  ZeroGStorageClient,
} from '@ai-arena/zerog-client';

const agentRepo = new AgentRepository(prisma);

const COMBAT_ARCHETYPES = ['BERSERKER', 'TACTICIAN', 'SUPPORT', 'ASSASSIN', 'DEFENDER', 'HYBRID'] as const;
type CombatArchetype = (typeof COMBAT_ARCHETYPES)[number];

/** Case-insensitive match against the CombatArchetype enum; unrecognized input falls back to HYBRID. */
function normalizeArchetype(input?: string): CombatArchetype {
  const upper = (input ?? '').toUpperCase();
  return (COMBAT_ARCHETYPES as readonly string[]).includes(upper) ? (upper as CombatArchetype) : 'HYBRID';
}

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
    const normalizedArchetype = normalizeArchetype(params.archetype);
    const archetype = normalizedArchetype.toLowerCase();

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
      archetype: normalizedArchetype as any,
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

    // ── Step 7: Publish event → inft-service will mint the INFT ─────────────
    try {
      const bus = await getEventBus();
      await bus.publish(SUBJECTS.AGENT_CREATED, {
        agentId:          agent.id,
        userId,
        metadataRootHash,
        avatarRootHash,
      });
    } catch (err) {
      console.warn('[AgentService] Could not publish AGENT_CREATED event (NATS unavailable):', (err as Error).message);
    }

    // ── Step 8: Direct HTTP mint via inft-service (no NATS dependency) ───────
    // NATS events don't fire reliably on Render starter plan.
    // We call inft-service directly using an internal shared-secret header.
    let inftTokenId: string | null = null;
    const inftServiceUrl = process.env.INFT_SERVICE_URL;
    if (inftServiceUrl) {
      try {
        const mintResp = await withTimeout(
          fetch(`${inftServiceUrl}/inft/agent-mint`, {
            method:  'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Service-Key': process.env.INTERNAL_SERVICE_SECRET ?? '',
            },
            body: JSON.stringify({
              agentId:          agent.id,
              clan:             params.clan,
              archetype,
              traits,
              metadataRootHash,
            }),
          }).then(async r => {
            if (!r.ok) throw new Error(`inft-service responded ${r.status}`);
            return r.json() as Promise<{ tokenId?: string | null; txHash?: string }>;
          }),
          20_000,
          'mintINFT',
        );
        if (mintResp.tokenId) {
          inftTokenId = String(mintResp.tokenId);
          // Persist tokenId back to the agent record
          await prisma.agent.update({
            where: { id: agent.id },
            data:  { inftTokenId },
          });
          console.info(`[AgentService] INFT minted: token #${inftTokenId} for agent ${agent.id} (tx: ${mintResp.txHash})`);
        }
      } catch (err) {
        // Non-fatal — agent is created, INFT minting can be retried later
        console.warn('[AgentService] INFT mint failed (non-fatal):', (err as Error).message);
      }
    } else {
      console.info('[AgentService] INFT_SERVICE_URL not set — skipping on-chain INFT mint');
    }

    // ── Step 9: NFT Mint success → Reward Distributor → Transfer 100 ARENA ──
    // to the agent owner's real 0G-chain wallet (User.walletAddress, the
    // same Privy embedded wallet used for login). Only fires after a
    // successful mint (inftTokenId set) — this is the replacement for the
    // old unconditional off-chain "starter allocation" removed in step 6
    // above. Non-fatal like the mint call itself: agent creation must not
    // fail if the reward grant fails.
    // TODO: a retry/reconciliation job for agents whose mint succeeded but
    // whose reward grant failed would be a good follow-up — out of scope here.
    if (inftTokenId) {
      const arenaChainServiceUrl = process.env.ARENA_CHAIN_SERVICE_URL ?? 'http://localhost:8050';
      try {
        const owner = await prisma.user.findUnique({ where: { id: userId }, select: { walletAddress: true } });
        if (!owner?.walletAddress) {
          console.warn(`[AgentService] No walletAddress for user ${userId} — skipping agent-mint ARENA reward`);
        } else {
          await withTimeout(
            fetch(`${arenaChainServiceUrl}/v1/arena/rewards/agent-mint`, {
              method:  'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Service-Key': process.env.INTERNAL_SERVICE_SECRET ?? '',
              },
              body: JSON.stringify({
                playerAddress: owner.walletAddress,
                agentTokenId:  inftTokenId,
              }),
            }).then(async r => {
              if (!r.ok) throw new Error(`arena-chain-service responded ${r.status}`);
              return r.json() as Promise<{ txHash: string; amountArena: string }>;
            }),
            20_000,
            'grantAgentMintReward',
          ).then(rewardResp => {
            console.info(`[AgentService] Agent Mint reward granted: ${rewardResp.amountArena} ARENA to ${owner.walletAddress} (tx: ${rewardResp.txHash})`);
          });
        }
      } catch (err) {
        // Non-fatal — agent + INFT are created, the reward grant can be retried later
        console.warn('[AgentService] Agent Mint ARENA reward failed (non-fatal):', (err as Error).message);
      }
    }

    return { ...agent, avatarRootHash, metadataRootHash, inftTokenId };
  }

  async getAgent(id: string) {
    return agentRepo.findByIdWithRelations(id);
  }

  async listAgents(params: { clan?: string; archetype?: string; page?: number; limit?: number }) {
    return agentRepo.list(params);
  }

  async listAgentsByUser(userId: string, params: { page?: number; limit?: number }) {
    const agents = await agentRepo.findByUserId(userId, params.page ?? 1, params.limit ?? 50);
    return { agents };
  }

  async updateAgent(id: string, userId: string, data: { name?: string; metadata?: Record<string, unknown> }) {
    return agentRepo.update(id, data as any);
  }

  async retireAgent(id: string, userId: string) {
    return agentRepo.retire(id);
  }

  // ── Autonomous mode ──────────────────────────────────────────────────────────

  async getAutonomousConfig(agentId: string) {
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) throw new Error('Agent not found');
    const meta = (agent.metadata ?? {}) as Record<string, unknown>;
    return {
      agentId,
      autonomousMode:   !!(meta.autonomousMode),
      autonomousConfig: (meta.autonomousConfig as Record<string, unknown>) ?? {
        gameId:   'default',
        mode:     'RANKED',
        eloRange: 200,
        strategy: 'BALANCED',
        autoTrain: true,
      },
    };
  }

  async setAutonomousConfig(agentId: string, cfg: {
    autonomousMode: boolean;
    gameId?:        string;
    mode?:          string;
    eloRange?:      number;
    strategy?:      string;
    autoTrain?:     boolean;
  }) {
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) throw new Error('Agent not found');
    const meta = (agent.metadata ?? {}) as Record<string, unknown>;
    const updated = await prisma.agent.update({
      where: { id: agentId },
      data: {
        metadata: {
          ...meta,
          autonomousMode:   cfg.autonomousMode,
          autonomousConfig: {
            gameId:    cfg.gameId    ?? 'default',
            mode:      cfg.mode      ?? 'RANKED',
            eloRange:  cfg.eloRange  ?? 200,
            strategy:  cfg.strategy  ?? 'BALANCED',
            autoTrain: cfg.autoTrain ?? true,
          },
        },
      },
    });
    const updatedMeta = (updated.metadata ?? {}) as Record<string, unknown>;
    return {
      agentId,
      autonomousMode:   cfg.autonomousMode,
      autonomousConfig: updatedMeta.autonomousConfig,
    };
  }

  async queueTraining(agentId: string, params: { type?: string; priority?: number; config?: Record<string, unknown> }) {
    return prisma.trainingJob.create({
      data: {
        agent:    { connect: { id: agentId } },
        type:     (params.type as any) ?? 'BEHAVIOUR_CLONING',
        priority: params.priority ?? 5,
        config:   (params.config as any) ?? {},
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

  async getTrainingJobById(jobId: string) {
    return prisma.trainingJob.findUnique({ where: { id: jobId } });
  }

  async cancelTrainingJobById(jobId: string) {
    const job = await prisma.trainingJob.findUnique({ where: { id: jobId } });
    if (!job) throw new Error('Training job not found');
    if (job.status === 'COMPLETED' || job.status === 'CANCELLED') {
      return job; // already terminal — no-op
    }
    return prisma.trainingJob.update({
      where: { id: jobId },
      data:  { status: 'CANCELLED' as any },
    });
  }

  async listAllTrainingJobs(limit = 20) {
    const jobs = await prisma.trainingJob.findMany({
      orderBy: { createdAt: 'desc' },
      take:    Math.min(limit, 100),
    });
    return { jobs };
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

  /**
   * Evolve agent traits based on actual battle performance.
   *
   * Called by the React client immediately after POST /v1/battles/:id/end.
   * Stats come from Unity's per-frame tracking (ArenaBattleReporter.cs).
   *
   * Trait delta rules (capped at ±5 per battle, all traits clamped 0-100):
   *   aggression   ← shots attempted rate  (high shots = +aggression)
   *   precision    ← shot accuracy          (high hit% = +precision)
   *   resilience   ← survived hits as winner / took no hits as winner
   *   creativity   ← jumps count            (mobile fighter)
   *   adaptability ← every completed battle gives a small bump
   *   patience     ← long match             (survived full duration)
   *   deception    ← winner who took 0 hits  (untouchable)
   *   loyalty      ← small constant: stayed in the fight
   */
  async evolveTraits(agentId: string, params: {
    outcome:          'WIN' | 'LOSS';
    jumps:            number;
    shotsAttempted:   number;
    shotsConnected:   number;
    timesHit:         number;
    distanceCovered:  number;
    durationSeconds:  number;
  }) {
    const agent = await agentRepo.findById(agentId);
    if (!agent) throw new Error('Agent not found');

    const current = ((agent.traits as Record<string, unknown>) ?? {}) as Record<string, number>;

    const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(v)));
    const won   = params.outcome === 'WIN';

    // ── Compute deltas ────────────────────────────────────────────────────────
    const accuracy      = params.shotsAttempted > 0 ? params.shotsConnected / params.shotsAttempted : 0;
    const shotRate      = Math.min(params.shotsAttempted / 30, 1); // normalise over ~30 shots
    const jumpRate      = Math.min(params.jumps / 20, 1);          // normalise over ~20 jumps
    const longMatch     = params.durationSeconds > 60;             // > 1 min = patient fight
    const tookNoHits    = params.timesHit === 0;

    const delta = {
      aggression:   won ? Math.round(shotRate  * 4) : Math.round(shotRate  * 2) - 1,
      precision:    won ? Math.round(accuracy  * 5) : Math.round(accuracy  * 3) - 1,
      resilience:   won
        ? (params.timesHit > 0 ? 3 : 1)   // absorbed hits and still won
        : (params.timesHit > 3 ? -1 : 0), // took heavy damage and lost
      creativity:   Math.round(jumpRate * 3) + (won ? 1 : 0),
      adaptability: won ? 2 : 1,           // every battle = adaptability++
      patience:     longMatch ? 2 : 0,
      deception:    won && tookNoHits ? 3 : 0,
      loyalty:      1,                     // always loyal — stayed in the fight
    };

    // ── Apply deltas ──────────────────────────────────────────────────────────
    const updated: Record<string, number> = {
      aggression:   clamp((current.aggression   ?? 50) + delta.aggression),
      precision:    clamp((current.precision    ?? 50) + delta.precision),
      resilience:   clamp((current.resilience   ?? 50) + delta.resilience),
      creativity:   clamp((current.creativity   ?? 50) + delta.creativity),
      adaptability: clamp((current.adaptability ?? 50) + delta.adaptability),
      patience:     clamp((current.patience     ?? 50) + delta.patience),
      deception:    clamp((current.deception    ?? 50) + delta.deception),
      loyalty:      clamp((current.loyalty      ?? 50) + delta.loyalty),
      intelligence: current.intelligence ?? 50,  // trained by LoRA only — not changed here
    };

    // ── Persist ───────────────────────────────────────────────────────────────
    await prisma.agent.update({
      where: { id: agentId },
      data:  { traits: updated as any },
    });

    console.info(
      `[AgentService] Traits evolved for ${agentId} (${params.outcome}): ` +
      Object.entries(delta)
        .filter(([, v]) => v !== 0)
        .map(([k, v]) => `${k}${v >= 0 ? '+' : ''}${v}`)
        .join(', ')
    );

    return { agentId, traits: updated, deltas: delta };
  }
}
