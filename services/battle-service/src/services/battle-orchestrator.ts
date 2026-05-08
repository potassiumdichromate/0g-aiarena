import { prisma, BattleRepository } from '@ai-arena/db-client';
import { getEventBus, SUBJECTS } from '@ai-arena/event-bus';
import { getRedisClient, CACHE_KEYS } from '@ai-arena/cache';

const battleRepo = new BattleRepository(prisma);

export class BattleOrchestrator {
  async createBattle(params: {
    agentId: string;
    opponentId: string;
    mode: string;
    gameId: string;
    wagerAmount?: number;
  }) {
    const battle = await battleRepo.create({
      gameId: params.gameId,
      mode: params.mode as any,
      agentIds: [params.agentId, params.opponentId],
      config: {
        wagerAmount: params.wagerAmount,
        maxRounds: 10,
        timeoutMs: 30000,
        allowSpectators: true,
        recordReplay: true,
      },
    });

    const bus = await getEventBus();
    await bus.publish(SUBJECTS.BATTLE_CREATED, {
      battleId: battle.id,
      agentIds: battle.agentIds,
      gameId: battle.gameId,
    });

    return battle;
  }

  async getBattle(id: string) {
    return battleRepo.findById(id);
  }

  async disputeBattle(id: string, reason: string) {
    await battleRepo.updateStatus(id, 'DISPUTED', { result: { disputeReason: reason } });
    const bus = await getEventBus();
    await bus.publish(SUBJECTS.BATTLE_DISPUTED, { battleId: id, reason });
  }

  async startBattle(id: string) {
    await battleRepo.updateStatus(id, 'IN_PROGRESS', { startedAt: new Date() });
    const bus = await getEventBus();
    await bus.publish(SUBJECTS.BATTLE_STARTED, { battleId: id, occurredAt: new Date() });
  }

  async endBattle(id: string, result: Record<string, unknown>) {
    await battleRepo.setResult(id, result);
    const bus = await getEventBus();
    await bus.publish(SUBJECTS.BATTLE_ENDED, { battleId: id, result, occurredAt: new Date() });
  }
}
