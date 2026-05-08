/**
 * BattleOrchestrator — manages battle lifecycle with 0G Storage archival.
 *
 * 0G Storage usage (via replay-service and memory-service):
 *   - endBattle() → publishes BATTLE_ENDED event
 *     → replay-service uploads the replay blob to 0G Storage
 *     → memory-service triggers compactMemory() for all participants
 *       → each agent's memory snapshot uploaded to 0G Storage
 *       → INFT memoryRootHash updated on-chain
 *
 * On-chain updates triggered after battle:
 *   - inft-service.recordBattleResult(tokenId, won, eloChange)
 *   - inft-service.updateMemoryRoot(tokenId, newMemoryRoot)  ← after compact
 */

import { prisma, BattleRepository } from '@ai-arena/db-client';
import { getEventBus, SUBJECTS } from '@ai-arena/event-bus';
import { getRedisClient, CACHE_KEYS } from '@ai-arena/cache';
import { ZeroGStorageClient, getZeroGConfig } from '@ai-arena/zerog-client';

const battleRepo = new BattleRepository(prisma);
const storage    = new ZeroGStorageClient(getZeroGConfig());

export class BattleOrchestrator {

  async createBattle(params: {
    agentId:      string;
    opponentId:   string;
    mode:         string;
    gameId:       string;
    wagerAmount?: number;
  }) {
    const battle = await battleRepo.create({
      gameId:   params.gameId,
      mode:     params.mode as any,
      agentIds: [params.agentId, params.opponentId],
      config: {
        wagerAmount:     params.wagerAmount,
        maxRounds:       10,
        timeoutMs:       30000,
        allowSpectators: true,
        recordReplay:    true,
      },
    });

    const bus = await getEventBus();
    await bus.publish(SUBJECTS.BATTLE_CREATED, {
      battleId: battle.id,
      agentIds: battle.agentIds,
      gameId:   battle.gameId,
    });

    return battle;
  }

  async getBattle(id: string) {
    return battleRepo.findById(id);
  }

  async startBattle(id: string) {
    await battleRepo.updateStatus(id, 'IN_PROGRESS', { startedAt: new Date() });
    const bus = await getEventBus();
    await bus.publish(SUBJECTS.BATTLE_STARTED, { battleId: id, occurredAt: new Date() });
  }

  /**
   * End a battle — archives result + replay to 0G Storage, triggers on-chain updates.
   *
   * @param id      Battle ID
   * @param result  { winnerId, loserId, eloChanges, finalStateHash, actionLog, seed }
   */
  async endBattle(id: string, result: {
    winnerId:       string;
    loserId:        string;
    eloChanges:     Record<string, number>;  // agentId → eloChange
    finalStateHash: string;
    actionLog?:     Array<Record<string, unknown>>;
    seed?:          string;
    durationMs?:    number;
  }) {
    const battle = await battleRepo.findById(id);
    if (!battle) throw new Error(`Battle ${id} not found`);

    // Mark complete in DB
    await battleRepo.setResult(id, result);

    // Upload battle summary to 0G Storage
    let resultRootHash: string | null = null;
    try {
      const summary = {
        battleId:       id,
        gameId:         battle.gameId,
        agentIds:       battle.agentIds,
        winnerId:       result.winnerId,
        loserId:        result.loserId,
        eloChanges:     result.eloChanges,
        finalStateHash: result.finalStateHash,
        durationMs:     result.durationMs ?? 0,
        endedAt:        new Date().toISOString(),
      };

      const buf = Buffer.from(JSON.stringify(summary), 'utf8');
      const { rootHash, txHash } = await storage.uploadBuffer(buf);
      resultRootHash = rootHash;

      await prisma.storageIndex.upsert({
        where:  { logicalPath: `battles/${id}/result` },
        update: { rootHash, txHash: txHash ?? null },
        create: {
          logicalPath: `battles/${id}/result`,
          rootHash,
          txHash:      txHash ?? null,
          mimeType:    'application/json',
          sizeBytes:   buf.byteLength,
          uploadedBy:  'battle-service',
          tags:        ['battle-result', id],
        },
      });
    } catch (err) {
      console.error('[BattleOrchestrator] Failed to upload battle result to 0G Storage:', err);
    }

    const bus = await getEventBus();

    // Publish BATTLE_ENDED — triggers:
    //   - replay-service: uploads full replay blob to 0G Storage
    //   - memory-service: compactMemory() for each participant → uploads snapshot to 0G Storage
    //   - inft-service:   recordBattleResult() + updateMemoryRoot() on-chain
    //   - financial-service: settle escrow
    await bus.publish(SUBJECTS.BATTLE_ENDED, {
      battleId:       id,
      gameId:         battle.gameId,
      agentIds:       battle.agentIds,
      winnerId:       result.winnerId,
      loserId:        result.loserId,
      eloChanges:     result.eloChanges,
      finalStateHash: result.finalStateHash,
      resultRootHash,           // 0G Storage root hash of battle summary
      actionLog:      result.actionLog ?? [],
      seed:           result.seed ?? '',
      durationMs:     result.durationMs ?? 0,
      occurredAt:     new Date(),
    });

    return { battleId: id, resultRootHash };
  }

  async disputeBattle(id: string, reason: string) {
    await battleRepo.updateStatus(id, 'DISPUTED', { result: { disputeReason: reason } });
    const bus = await getEventBus();
    await bus.publish(SUBJECTS.BATTLE_DISPUTED, { battleId: id, reason });
  }

  /**
   * Retrieve battle result from 0G Storage (authoritative archive).
   * Falls back to DB record if 0G is unavailable.
   */
  async getBattleResult(id: string): Promise<Record<string, unknown> | null> {
    // Try 0G Storage first
    try {
      const record = await prisma.storageIndex.findUnique({
        where: { logicalPath: `battles/${id}/result` },
      });
      if (record) {
        const buf = await storage.downloadToBuffer(record.rootHash);
        return JSON.parse(buf.toString('utf8'));
      }
    } catch (err) {
      console.warn('[BattleOrchestrator] Could not fetch result from 0G Storage, using DB:', err);
    }

    // Fallback to DB
    const battle = await battleRepo.findById(id);
    return battle?.result as Record<string, unknown> | null;
  }
}
