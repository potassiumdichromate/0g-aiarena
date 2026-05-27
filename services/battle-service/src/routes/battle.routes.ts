import { FastifyInstance } from 'fastify';
import { prisma, AgentRepository } from '@ai-arena/db-client';
import { getRedisClient, CACHE_KEYS } from '@ai-arena/cache';
import { BattleOrchestrator } from '../services/battle-orchestrator';

const orchestrator  = new BattleOrchestrator();
const agentRepo     = new AgentRepository(prisma);

// ── Standard Elo formula ──────────────────────────────────────────────────────
// K-factor 32 (same as FIDE for players below 2400).
// Returns the delta (positive for winner, negative for loser).
function computeEloDelta(winnerElo: number, loserElo: number, kFactor = 32): number {
  const expected = 1 / (1 + Math.pow(10, (loserElo - winnerElo) / 400));
  return Math.round(kFactor * (1 - expected));
}

export async function battleRoutes(app: FastifyInstance): Promise<void> {
  app.post('/', async (req, reply) => {
    const body = req.body as { agentId: string; opponentId: string; mode: string; gameId: string; wagerAmount?: number };
    const battle = await orchestrator.createBattle(body);
    return reply.status(201).send({ battle });
  });

  app.get('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const battle = await orchestrator.getBattle(id);
    if (!battle) return reply.status(404).send({ error: 'Battle not found' });
    return { battle };
  });

  /**
   * POST /battles/:id/start — called by matchmaking-service via direct HTTP
   * (NATS-free path, same pattern as INFT mint).
   * Transitions the battle from PENDING → IN_PROGRESS.
   */
  app.post('/:id/start', async (req, reply) => {
    const { id } = req.params as { id: string };
    const serviceKey = req.headers['x-service-key'] as string | undefined;
    const expected   = process.env.INTERNAL_SERVICE_SECRET;
    if (expected && serviceKey !== expected) {
      return reply.status(403).send({ error: 'Forbidden' });
    }
    const battle = await orchestrator.getBattle(id);
    if (!battle) return reply.status(404).send({ error: 'Battle not found' });
    if (battle.status !== 'PENDING') {
      // Already started or finished — idempotent OK
      return { started: false, status: battle.status, battleId: id };
    }
    await orchestrator.startBattle(id);
    return { started: true, battleId: id };
  });

  /**
   * POST /battles/:id/end — report battle result from game client (Unity).
   *
   * Called by the frontend after receiving arena_battle_end from the Unity iframe.
   * Performs the full end-of-battle pipeline:
   *   1. Validates battle is in a terminal-eligible state (IN_PROGRESS or PENDING)
   *   2. Verifies winnerId / loserId belong to this battle
   *   3. Computes ELO deltas server-side (K=32 standard Elo, ignoring client value)
   *   4. Updates agent eloRating + wins/losses in Postgres
   *   5. Updates Redis global leaderboard sorted set
   *   6. Calls BattleOrchestrator.endBattle() → 0G archival + BATTLE_ENDED event
   *      (downstream: replay-service, memory-service, inft-service, escrow settle)
   *
   * Production advice:
   *   • Add JWT/session auth so only participants can call this.
   *   • Rate-limit per battleId to prevent double-end.
   *   • Validate finalStateHash matches the cryptographic commitment from both clients.
   *   • Consider a consensus mechanism (both agents must agree on winner) for RANKED.
   */
  app.post('/:id/end', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as {
      winnerId:       string;
      loserId:        string;
      rounds?:        number;
      log?:           Array<string | Record<string, unknown>>;
      finalStateHash?: string;
      seed?:          string;
      durationMs?:    number;
    };

    // ── 1. Validate required fields ─────────────────────────────────────────
    if (!body?.winnerId || !body?.loserId) {
      return reply.status(400).send({ error: 'winnerId and loserId are required' });
    }
    if (body.winnerId === body.loserId) {
      return reply.status(400).send({ error: 'winnerId and loserId must be different agents' });
    }

    // ── 2. Fetch battle & validate state ────────────────────────────────────
    const battle = await orchestrator.getBattle(id);
    if (!battle) {
      return reply.status(404).send({ error: 'Battle not found' });
    }

    if (battle.status === 'COMPLETED' || battle.status === 'CANCELLED' || battle.status === 'DISPUTED') {
      // Idempotent — return current state without re-processing
      return reply.status(409).send({
        error:    `Battle is already in terminal state: ${battle.status}`,
        battle,
      });
    }

    // ── 3. Validate agents belong to this battle ────────────────────────────
    const agentIds: string[] = Array.isArray(battle.agentIds) ? battle.agentIds : [];
    if (!agentIds.includes(body.winnerId) || !agentIds.includes(body.loserId)) {
      return reply.status(400).send({
        error:    'winnerId and loserId must be agents registered in this battle',
        agentIds,
      });
    }

    // ── 4. Fetch agents & compute ELO delta (server-side, client value ignored) ──
    const [winner, loser] = await Promise.all([
      agentRepo.findById(body.winnerId),
      agentRepo.findById(body.loserId),
    ]);

    if (!winner || !loser) {
      return reply.status(404).send({ error: 'One or both agents not found' });
    }

    const eloDelta    = computeEloDelta(winner.eloRating, loser.eloRating);
    const newWinnerElo = Math.max(0, winner.eloRating + eloDelta);
    const newLoserElo  = Math.max(0, loser.eloRating  - eloDelta);

    const eloChanges: Record<string, number> = {
      [body.winnerId]: eloDelta,
      [body.loserId]:  -eloDelta,
    };

    // ── 5. Update agent ELO + win/loss in Postgres ──────────────────────────
    await Promise.all([
      agentRepo.updateElo(body.winnerId, newWinnerElo, 'WIN'),
      agentRepo.updateElo(body.loserId,  newLoserElo,  'LOSS'),
    ]);

    // ── 6. Update Redis global leaderboard sorted set ────────────────────────
    // Errors here are non-fatal — leaderboard falls back to Postgres query.
    try {
      const redis = getRedisClient();
      const lbKey = CACHE_KEYS.globalLeaderboard();
      await Promise.all([
        redis.zadd(lbKey, newWinnerElo, body.winnerId),
        redis.zadd(lbKey, newLoserElo,  body.loserId),
      ]);
    } catch (err) {
      app.log.warn({ err, battleId: id }, '[endBattle] Redis leaderboard update failed (non-fatal)');
    }

    // ── 7. Archive to 0G, publish BATTLE_ENDED, settle escrow ───────────────
    const normalizedLog: Array<Record<string, unknown>> = (body.log ?? []).map((entry) =>
      typeof entry === 'string' ? { text: entry } : entry
    );

    const { resultRootHash } = await orchestrator.endBattle(id, {
      winnerId:       body.winnerId,
      loserId:        body.loserId,
      eloChanges,
      finalStateHash: body.finalStateHash ?? `sha256:${id}:${body.winnerId}:${Date.now()}`,
      actionLog:      normalizedLog,
      seed:           body.seed,
      durationMs:     body.durationMs,
    });

    // ── 8. Return updated battle ─────────────────────────────────────────────
    const updatedBattle = await orchestrator.getBattle(id);
    return reply.status(200).send({
      battle:         updatedBattle,
      eloChanges,
      eloDelta,
      newWinnerElo,
      newLoserElo,
      resultRootHash,
      zgExplorerUrl:  resultRootHash
        ? `${process.env.ZEROG_NETWORK === 'testnet' ? 'https://storagescan-testnet.0g.ai' : 'https://storagescan.0g.ai'}/tx/${resultRootHash}`
        : null,
    });
  });

  app.post('/:id/dispute', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { reason } = req.body as { reason: string };
    await orchestrator.disputeBattle(id, reason);
    return { success: true };
  });

  // WebSocket battle stream
  app.get('/ws/battle/:id', { websocket: true }, (connection, req) => {
    const { id } = req.params as { id: string };
    connection.socket.on('message', (msg) => {
      // Broadcast state updates to battle participants
      connection.socket.send(JSON.stringify({ type: 'STATE_UPDATE', battleId: id }));
    });
    connection.socket.on('close', () => {
      console.log(`WebSocket closed for battle ${id}`);
    });
  });
}
