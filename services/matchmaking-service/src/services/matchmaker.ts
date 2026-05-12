import { getRedisClient, CACHE_KEYS } from '@ai-arena/cache';
import { getEventBus, SUBJECTS } from '@ai-arena/event-bus';
import { prisma } from '@ai-arena/db-client';

const FINANCIAL_URL  = process.env.FINANCIAL_SERVICE_URL ?? 'http://localhost:8005';
const WAGER_AMOUNT   = parseFloat(process.env.WAGER_STAKE_AMOUNT ?? '5'); // $ARENA per agent

export class Matchmaker {
  private readonly redis = getRedisClient();

  async joinQueue(agentId: string, gameId: string, mode: string, eloRange: number): Promise<void> {
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) throw new Error('Agent not found');

    // ── Wager balance check via x402 ─────────────────────────────────────────
    if (mode === 'WAGER') {
      try {
        const res = await fetch(`${FINANCIAL_URL}/wallets/${agentId}`, { method: 'GET' });
        if (res.ok) {
          const data = await res.json() as { wallet?: { balanceArena?: number } };
          const balance = data.wallet?.balanceArena ?? 0;
          if (balance < WAGER_AMOUNT) {
            throw new Error(
              `Insufficient $ARENA balance for wager battle. ` +
              `Need ${WAGER_AMOUNT} ARENA, have ${balance}. ` +
              `Deposit more ARENA to your agent wallet.`
            );
          }
        }
      } catch (err: any) {
        if (err.message.includes('Insufficient')) throw err;
        // Financial service unreachable — allow queue join (fail open)
        console.warn('[Matchmaker] Could not verify wager balance:', err.message);
      }
    }

    const entry = { agentId, gameId, mode, eloRating: agent.eloRating, eloRange, joinedAt: Date.now() };
    const queueKey = CACHE_KEYS.matchQueue(gameId, mode);

    await this.redis.zadd(queueKey, agent.eloRating, agentId);
    await this.redis.setexJson(CACHE_KEYS.queueEntry(agentId), 300, entry);

    // Try to find a match
    await this.tryMatch(agentId, gameId, mode, agent.eloRating, eloRange);
  }

  private async tryMatch(agentId: string, gameId: string, mode: string, elo: number, eloRange: number): Promise<void> {
    const queueKey = CACHE_KEYS.matchQueue(gameId, mode);
    const candidates = await this.redis.zrevrange(queueKey, 0, -1, true);

    for (let i = 0; i < candidates.length - 1; i += 2) {
      const candidateId = candidates[i];
      const candidateElo = parseFloat(candidates[i + 1]);

      if (candidateId === agentId) continue;
      if (Math.abs(candidateElo - elo) <= eloRange) {
        // Match found! Remove only the two matched agents from the sorted set.
        await this.redis.zrem(queueKey, agentId, candidateId);
        await this.redis.del(CACHE_KEYS.queueEntry(agentId));
        await this.redis.del(CACHE_KEYS.queueEntry(candidateId));
        const bus = await getEventBus();
        await bus.publish(SUBJECTS.MATCH_FOUND, {
          matchId: `${agentId}-${candidateId}-${Date.now()}`,
          agentIds: [agentId, candidateId],
          eloRatings: { [agentId]: elo, [candidateId]: candidateElo },
          occurredAt: new Date(),
        });
        return;
      }
    }
  }

  async leaveQueue(agentId: string): Promise<void> {
    const entry = await this.redis.getJson<{ gameId: string; mode: string }>(CACHE_KEYS.queueEntry(agentId));
    if (entry) {
      await this.redis.zrem(CACHE_KEYS.matchQueue(entry.gameId, entry.mode), agentId);
      await this.redis.del(CACHE_KEYS.queueEntry(agentId));
    }
  }

  async getQueueStatus(agentId: string) {
    const entry = await this.redis.getJson<{ gameId: string; mode: string; joinedAt: number }>(
      CACHE_KEYS.queueEntry(agentId)
    );
    if (!entry) return { inQueue: false };
    return { inQueue: true, waitTimeMs: Date.now() - entry.joinedAt, ...entry };
  }

  /**
   * Direct challenge — skips matchmaking queue and creates a battle immediately.
   * Both agents must exist. Publishes MATCH_FOUND + BATTLE_CREATED events.
   */
  async directChallenge(agentId: string, opponentId: string, gameId: string, mode: string) {
    const [agent, opponent] = await Promise.all([
      prisma.agent.findUnique({ where: { id: agentId } }),
      prisma.agent.findUnique({ where: { id: opponentId } }),
    ]);
    if (!agent)    throw new Error(`Agent ${agentId} not found`);
    if (!opponent) throw new Error(`Opponent ${opponentId} not found`);

    // Create battle record directly
    const battle = await prisma.battle.create({
      data: {
        gameId,
        mode:     mode as any,
        status:   'PENDING',
        agentIds: [agentId, opponentId],
        config:   { directChallenge: true, maxRounds: 10, timeoutMs: 30000, recordReplay: true },
      },
    });

    // Publish events so battle-service picks up and starts the fight
    try {
      const bus = await getEventBus();
      await bus.publish(SUBJECTS.MATCH_FOUND, {
        matchId:    battle.id,
        agentIds:   [agentId, opponentId],
        eloRatings: { [agentId]: agent.eloRating, [opponentId]: opponent.eloRating },
        occurredAt: new Date(),
      });
      await bus.publish(SUBJECTS.BATTLE_CREATED, {
        battleId: battle.id,
        agentIds: [agentId, opponentId],
        gameId,
      });
    } catch (err) {
      console.warn('[Matchmaker] NATS unavailable for directChallenge events:', err);
    }

    return {
      battleId:   battle.id,
      agentIds:   [agentId, opponentId],
      gameId,
      mode,
      status:     'PENDING',
    };
  }
}
