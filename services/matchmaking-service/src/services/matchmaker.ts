import { getRedisClient, CACHE_KEYS } from '@ai-arena/cache';
import { getEventBus, SUBJECTS } from '@ai-arena/event-bus';
import { prisma } from '@ai-arena/db-client';

const FINANCIAL_URL  = process.env.FINANCIAL_SERVICE_URL ?? 'http://localhost:8005';
const BATTLE_URL     = process.env.BATTLE_SERVICE_URL    ?? 'http://localhost:8021';
const WAGER_AMOUNT   = parseFloat(process.env.WAGER_STAKE_AMOUNT ?? '5'); // $ARENA per agent

/** TTL (seconds) for match-found Redis entries — long enough for both UIs to poll. */
const MATCH_FOUND_TTL = 300;

/** Redis key used to notify an agent that a match has been found for them. */
const matchFoundKey = (agentId: string) => `match:found:${agentId}`;

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
        // ── Match found ───────────────────────────────────────────────────────

        // 1. Remove both agents from the queue immediately
        await this.redis.zrem(queueKey, agentId, candidateId);
        await this.redis.del(CACHE_KEYS.queueEntry(agentId));
        await this.redis.del(CACHE_KEYS.queueEntry(candidateId));

        // 2. Create a real Battle record in the DB (same as directChallenge)
        //    Status starts as PENDING so both frontends can show the 60-second
        //    countdown overlay before the game iframe opens.
        const battle = await prisma.battle.create({
          data: {
            gameId,
            mode:     mode as any,
            status:   'PENDING',
            agentIds: [agentId, candidateId],
            config:   { maxRounds: 10, timeoutMs: 30_000, recordReplay: true },
          },
        });

        // 3. Write match:found Redis entries for BOTH agents.
        //    getQueueStatus() reads these keys and returns { inQueue:true, matchId }
        //    so the frontend ArenaMatchStatusModal enters the "matched" phase and
        //    navigates to /arena/game/:battleId.
        const payloadForAgent     = { battleId: battle.id, opponentId: candidateId, gameId, mode };
        const payloadForCandidate = { battleId: battle.id, opponentId: agentId,     gameId, mode };
        try {
          await Promise.all([
            this.redis.setexJson(matchFoundKey(agentId),    MATCH_FOUND_TTL, payloadForAgent),
            this.redis.setexJson(matchFoundKey(candidateId), MATCH_FOUND_TTL, payloadForCandidate),
          ]);
        } catch (err) {
          console.warn('[Matchmaker] Could not write match-found Redis entries:', err);
        }

        // 4. Transition the battle to IN_PROGRESS via direct HTTP.
        //    This is intentionally called after writing the Redis keys so both
        //    frontends have time to poll, receive matchId, and navigate to the
        //    game page before the battle is marked live.
        try {
          const res = await fetch(`${BATTLE_URL}/battles/${battle.id}/start`, {
            method:  'POST',
            headers: {
              'Content-Type':  'application/json',
              'X-Service-Key': process.env.INTERNAL_SERVICE_SECRET ?? '',
            },
          });
          if (res.ok) {
            console.info(`[Matchmaker] Battle ${battle.id} started via direct HTTP (queue match)`);
          } else {
            const text = await res.text().catch(() => '');
            console.warn(`[Matchmaker] battle-service start returned ${res.status}: ${text}`);
          }
        } catch (err) {
          console.warn('[Matchmaker] Could not start battle via HTTP (will rely on NATS):', (err as Error).message);
        }

        // 5. Best-effort NATS publish for any downstream subscribers
        try {
          const bus = await getEventBus();
          await bus.publish(SUBJECTS.MATCH_FOUND, {
            matchId:    battle.id,
            agentIds:   [agentId, candidateId],
            eloRatings: { [agentId]: elo, [candidateId]: candidateElo },
            occurredAt: new Date(),
          });
          await bus.publish(SUBJECTS.BATTLE_CREATED, {
            battleId: battle.id,
            agentIds: [agentId, candidateId],
            gameId,
          });
        } catch (err) {
          console.warn('[Matchmaker] NATS unavailable (non-fatal):', err);
        }

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
    // ── Check match-found first (set by directChallenge) ────────────────────
    try {
      const match = await this.redis.getJson<{
        battleId: string; opponentId: string; gameId: string; mode: string;
      }>(matchFoundKey(agentId));
      if (match) {
        // Return inQueue:true so the frontend status modal enters "matched" phase
        return {
          inQueue:     true,
          matchId:     match.battleId,
          gameId:      match.gameId,
          mode:        match.mode,
          waitTimeMs:  0,
        };
      }
    } catch {
      // Redis blip — fall through to queue entry check
    }

    // ── Fall back to normal queue entry ─────────────────────────────────────
    const entry = await this.redis.getJson<{ gameId: string; mode: string; joinedAt: number }>(
      CACHE_KEYS.queueEntry(agentId)
    );
    if (!entry) return { inQueue: false };
    return { inQueue: true, waitTimeMs: Date.now() - entry.joinedAt, ...entry };
  }

  /**
   * Direct challenge — skips matchmaking queue and creates a battle immediately.
   *
   * Flow (NATS-free, mirrors the INFT-mint direct-HTTP pattern):
   *   1. Validate both agents exist
   *   2. Remove both from any open queue slots (idempotent)
   *   3. Create Battle record with PENDING status
   *   4. Write match:found Redis entries for both agents (polled by getQueueStatus)
   *   5. Call battle-service HTTP POST /battles/:id/start to transition to IN_PROGRESS
   *   6. Try NATS publish as best-effort fallback
   */
  async directChallenge(agentId: string, opponentId: string, gameId: string, mode: string) {
    const [agent, opponent] = await Promise.all([
      prisma.agent.findUnique({ where: { id: agentId } }),
      prisma.agent.findUnique({ where: { id: opponentId } }),
    ]);
    if (!agent)    throw new Error(`Agent ${agentId} not found`);
    if (!opponent) throw new Error(`Opponent ${opponentId} not found`);

    // ── Step 1: Remove both agents from any open queue slots ─────────────────
    try {
      const [agentEntry, opponentEntry] = await Promise.all([
        this.redis.getJson<{ gameId: string; mode: string }>(CACHE_KEYS.queueEntry(agentId)),
        this.redis.getJson<{ gameId: string; mode: string }>(CACHE_KEYS.queueEntry(opponentId)),
      ]);
      if (agentEntry) {
        await this.redis.zrem(CACHE_KEYS.matchQueue(agentEntry.gameId, agentEntry.mode), agentId);
        await this.redis.del(CACHE_KEYS.queueEntry(agentId));
      }
      if (opponentEntry) {
        await this.redis.zrem(CACHE_KEYS.matchQueue(opponentEntry.gameId, opponentEntry.mode), opponentId);
        await this.redis.del(CACHE_KEYS.queueEntry(opponentId));
      }
    } catch (err) {
      console.warn('[Matchmaker] Could not clean up queue entries for directChallenge:', err);
    }

    // ── Step 2: Create battle record ─────────────────────────────────────────
    const battle = await prisma.battle.create({
      data: {
        gameId,
        mode:     mode as any,
        status:   'PENDING',
        agentIds: [agentId, opponentId],
        config:   { directChallenge: true, maxRounds: 10, timeoutMs: 30000, recordReplay: true },
      },
    });

    // ── Step 3: Write match-found entries so both agents discover via polling ─
    // getQueueStatus checks these keys and returns matchId → frontend transitions
    const matchPayloadForAgent    = { battleId: battle.id, opponentId,  gameId, mode };
    const matchPayloadForOpponent = { battleId: battle.id, opponentId: agentId, gameId, mode };
    try {
      await Promise.all([
        this.redis.setexJson(matchFoundKey(agentId),    MATCH_FOUND_TTL, matchPayloadForAgent),
        this.redis.setexJson(matchFoundKey(opponentId), MATCH_FOUND_TTL, matchPayloadForOpponent),
      ]);
    } catch (err) {
      console.warn('[Matchmaker] Could not write match-found Redis entries:', err);
    }

    // ── Step 4: Start battle via direct HTTP (NATS-free) ─────────────────────
    // Same pattern used for INFT minting in agent-service.
    let battleStarted = false;
    try {
      const res = await fetch(`${BATTLE_URL}/battles/${battle.id}/start`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'X-Service-Key': process.env.INTERNAL_SERVICE_SECRET ?? '',
        },
      });
      if (res.ok) {
        battleStarted = true;
        console.info(`[Matchmaker] Battle ${battle.id} started via direct HTTP`);
      } else {
        const text = await res.text().catch(() => '');
        console.warn(`[Matchmaker] Battle-service start returned ${res.status}: ${text}`);
      }
    } catch (err) {
      console.warn('[Matchmaker] Could not start battle via HTTP (will rely on NATS):', (err as Error).message);
    }

    // ── Step 5: Best-effort NATS publish ─────────────────────────────────────
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
      console.warn('[Matchmaker] NATS unavailable for directChallenge events (non-fatal):', err);
    }

    return {
      battleId:      battle.id,
      agentIds:      [agentId, opponentId],
      gameId,
      mode,
      status:        battleStarted ? 'IN_PROGRESS' : 'PENDING',
    };
  }
}
