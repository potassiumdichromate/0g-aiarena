import { getRedisClient, CACHE_KEYS } from '@ai-arena/cache';
import { getEventBus, SUBJECTS } from '@ai-arena/event-bus';
import { prisma } from '@ai-arena/db-client';
import { calculateElo } from '@ai-arena/shared-utils';

export class Matchmaker {
  private readonly redis = getRedisClient();

  async joinQueue(agentId: string, gameId: string, mode: string, eloRange: number): Promise<void> {
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) throw new Error('Agent not found');

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

  async directChallenge(agentId: string, opponentId: string, gameId: string, mode: string) {
    return { agentId, opponentId, gameId, mode, status: 'PENDING_ACCEPTANCE' };
  }
}
