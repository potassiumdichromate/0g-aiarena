/**
 * AutonomousLoop — background tick that runs every LOOP_INTERVAL_MS (default 60s).
 *
 * For every agent with metadata.autonomousMode = true:
 *   1. Check Redis queue status — if not in queue, auto-join matchmaking
 *   2. Check training jobs — if none running/queued and autoTrain is on, queue a job
 *   3. Simulate IN_PROGRESS battles where ALL participants are autonomous:
 *      - Determine winner by ELO probability (standard formula)
 *      - Generate realistic playerStats from random distributions
 *      - POST /battles/:id/end  → ELO update + 0G archive
 *      - POST /agents/:id/evolve-traits  for winner + loser
 *      - POST /agents/:id/memory/episode  for winner + loser (0G Storage)
 *
 * Uses Prisma and the Matchmaker directly (no HTTP round-trip for queue ops).
 * Training is queued via direct Prisma insert (avoids JWT auth on agent-service).
 */

import { prisma } from '@ai-arena/db-client';
import { Matchmaker } from './matchmaker';

// ── Internal service URLs ─────────────────────────────────────────────────────
// These match the same env vars the API Gateway uses for its routing table.
const BATTLE_URL = process.env.BATTLE_SERVICE_URL ?? 'http://localhost:8003';
const AGENT_URL  = process.env.AGENT_SERVICE_URL  ?? 'http://localhost:8002';
const MEMORY_URL = process.env.MEMORY_SERVICE_URL ?? 'http://localhost:8014';

/** Battles must be at least this old before the loop simulates them.
 *  Gives real Unity clients time to load and play.  (default: 90 seconds) */
const SIM_DELAY_MS = parseInt(process.env.AUTONOMOUS_SIM_DELAY_MS ?? '90000', 10);

const LOOP_INTERVAL_MS = parseInt(process.env.AUTONOMOUS_LOOP_INTERVAL_MS ?? '60000', 10);
const matchmaker = new Matchmaker();

// ── Simulation helpers ────────────────────────────────────────────────────────

/** Standard ELO win-probability for agentA vs agentB. */
function winProbability(eloA: number, eloB: number): number {
  return 1 / (1 + Math.pow(10, (eloB - eloA) / 400));
}

function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Realistic action stats skewed toward a winner or loser profile. */
function simulateStats(role: 'winner' | 'loser') {
  if (role === 'winner') {
    return {
      jumps:           rand(8, 22),
      shotsAttempted:  rand(60, 120),
      shotsConnected:  rand(20, 55),
      timesHit:        rand(3, 12),
      distanceCovered: rand(220, 520),
    };
  }
  return {
    jumps:           rand(4, 16),
    shotsAttempted:  rand(35, 95),
    shotsConnected:  rand(6, 28),
    timesHit:        rand(15, 38),
    distanceCovered: rand(140, 380),
  };
}

// ── Step 3: Simulate autonomous battles ──────────────────────────────────────

async function simulateAutonomousBattles(autonomousIds: Set<string>): Promise<void> {
  if (autonomousIds.size === 0) return;

  const cutoff = new Date(Date.now() - SIM_DELAY_MS);

  let battles: Array<{ id: string; agentIds: string[] }> = [];
  try {
    battles = await prisma.battle.findMany({
      where: {
        status:    { in: ['PENDING', 'IN_PROGRESS'] as any[] },
        createdAt: { lt: cutoff },
      },
      select: { id: true, agentIds: true },
    });
  } catch (err) {
    console.warn('[AutonomousLoop] Could not query pending battles:', (err as Error).message);
    return;
  }

  for (const battle of battles) {
    if (battle.agentIds.length < 2) continue;

    // Only simulate if ALL agents in this battle are autonomous.
    // If any agent is a real player, skip — let the Unity client resolve it.
    if (!battle.agentIds.every((id) => autonomousIds.has(id))) continue;

    const [agentAId, agentBId] = battle.agentIds;

    let agentA: { id: string; eloRating: number; name: string } | null = null;
    let agentB: { id: string; eloRating: number; name: string } | null = null;
    try {
      [agentA, agentB] = await Promise.all([
        prisma.agent.findUnique({ where: { id: agentAId }, select: { id: true, eloRating: true, name: true } }),
        prisma.agent.findUnique({ where: { id: agentBId }, select: { id: true, eloRating: true, name: true } }),
      ]);
    } catch (err) {
      console.warn(`[AutonomousLoop] Could not fetch agents for battle ${battle.id}:`, (err as Error).message);
      continue;
    }

    if (!agentA || !agentB) continue;

    // ── Determine winner by ELO probability ────────────────────────────────
    const pA = winProbability(agentA.eloRating, agentB.eloRating);
    const winnerId       = Math.random() < pA ? agentAId : agentBId;
    const loserId        = winnerId === agentAId ? agentBId : agentAId;
    const durationSeconds = rand(30, 120);
    const rounds          = Math.max(1, Math.floor(durationSeconds / 20));

    const winnerStats = simulateStats('winner');
    const loserStats  = simulateStats('loser');

    // ── 1. End battle → ELO update + 0G archive ────────────────────────────
    let battleEnded = false;
    try {
      const res = await fetch(`${BATTLE_URL}/battles/${battle.id}/end`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'X-Service-Key': process.env.INTERNAL_SERVICE_SECRET ?? '',
        },
        body: JSON.stringify({
          winnerId,
          loserId,
          rounds,
          playerStats: {
            [winnerId]: winnerStats,
            [loserId]:  loserStats,
          },
        }),
      });
      if (res.ok) {
        battleEnded = true;
        console.info(
          `[AutonomousLoop] ✅ Simulated battle ${battle.id}: ` +
          `${agentA.name} (${agentAId === winnerId ? 'WIN' : 'LOSS'}) vs ` +
          `${agentB.name} (${agentBId === winnerId ? 'WIN' : 'LOSS'}), ` +
          `${durationSeconds}s`
        );
      } else {
        const text = await res.text().catch(() => '');
        console.warn(`[AutonomousLoop] endBattle ${battle.id} → HTTP ${res.status}: ${text}`);
      }
    } catch (err) {
      console.warn(`[AutonomousLoop] endBattle request failed for ${battle.id}:`, (err as Error).message);
    }

    if (!battleEnded) continue;

    // ── 2. Evolve traits — fire-and-forget ────────────────────────────────
    const traitCalls: [string, 'WIN' | 'LOSS', typeof winnerStats][] = [
      [winnerId, 'WIN',  winnerStats],
      [loserId,  'LOSS', loserStats],
    ];
    for (const [agentId, outcome, stats] of traitCalls) {
      fetch(`${AGENT_URL}/agents/${agentId}/evolve-traits`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outcome, ...stats, durationSeconds }),
      }).catch((err) =>
        console.warn(`[AutonomousLoop] evolveTraits failed for ${agentId}:`, (err as Error).message)
      );
    }

    // ── 3. Store battle memory on 0G Storage — fire-and-forget ────────────
    const winnerName = winnerId === agentAId ? agentA.name : agentB.name;
    const loserName  = loserId  === agentAId ? agentA.name : agentB.name;
    const memContent =
      `[Autonomous] ${winnerName} defeated ${loserName} in ${durationSeconds}s ` +
      `(${rounds} round${rounds !== 1 ? 's' : ''}, battle ${battle.id}).`;

    const memoryCalls: [string, 'WIN' | 'LOSS'][] = [
      [winnerId, 'WIN'],
      [loserId,  'LOSS'],
    ];
    for (const [agentId, outcome] of memoryCalls) {
      fetch(`${MEMORY_URL}/agents/${agentId}/memory/episode`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ battleId: battle.id, outcome, content: memContent }),
      }).catch((err) =>
        console.warn(`[AutonomousLoop] memory store failed for ${agentId}:`, (err as Error).message)
      );
    }

    // ── 4. Auto-train for the winner (builds on the win data) ─────────────
    // Loser training is handled by the auto-train step on next tick.
    try {
      const activeJobs = await prisma.trainingJob.count({
        where: {
          agentId: winnerId,
          status:  { in: ['QUEUED', 'RUNNING'] as any[] },
        },
      });
      if (activeJobs === 0) {
        await prisma.trainingJob.create({
          data: {
            agent:    { connect: { id: winnerId } },
            type:     'BEHAVIOUR_CLONING' as any,
            priority: 4,
            config:   {
              source:          'autonomous-battle-win',
              battleId:        battle.id,
              durationSeconds,
              autoScheduled:   true,
            } as any,
          },
        });
        console.info(`[AutonomousLoop] ✅ Auto-queued training for winner ${winnerId}`);
      }
    } catch (err) {
      console.warn(`[AutonomousLoop] Auto-train for winner ${winnerId} failed:`, (err as Error).message);
    }
  }
}

// ── Main tick ─────────────────────────────────────────────────────────────────

async function tickAutonomousAgents(): Promise<void> {
  let agents: Array<{ id: string; eloRating: number; metadata: unknown }> = [];

  try {
    agents = await prisma.agent.findMany({
      where: {
        isRetired: false,
        metadata:  { path: ['autonomousMode'], equals: true },
      },
      select: { id: true, eloRating: true, metadata: true },
    });
  } catch (err) {
    console.error('[AutonomousLoop] DB query failed:', (err as Error).message);
    return;
  }

  if (agents.length === 0) return;
  console.info(`[AutonomousLoop] Tick — ${agents.length} autonomous agent(s)`);

  const autonomousIds = new Set(agents.map((a) => a.id));

  // ── Step 3 first: resolve any pending autonomous battles before re-queuing ──
  await simulateAutonomousBattles(autonomousIds);

  // ── Steps 1 + 2: queue + auto-train per agent ──────────────────────────────
  for (const agent of agents) {
    const meta   = (agent.metadata ?? {}) as Record<string, unknown>;
    const config = (meta.autonomousConfig ?? {}) as {
      gameId?:    string;
      mode?:      string;
      eloRange?:  number;
      autoTrain?: boolean;
    };

    const gameId   = config.gameId   ?? 'default';
    const mode     = config.mode     ?? 'RANKED';
    const eloRange = config.eloRange ?? 200;

    // ── Step 1: Auto-queue into matchmaking ──────────────────────────────────
    try {
      const status = await matchmaker.getQueueStatus(agent.id);
      if (!status.inQueue) {
        await matchmaker.joinQueue(agent.id, gameId, mode, eloRange);
        console.info(
          `[AutonomousLoop] Auto-queued agent ${agent.id} ` +
          `(ELO ${agent.eloRating}, mode ${mode})`
        );
      }
    } catch (err) {
      console.warn(
        `[AutonomousLoop] Queue check/join failed for ${agent.id}:`,
        (err as Error).message
      );
    }

    // ── Step 2: Auto-train if enabled and no job running ────────────────────
    if (config.autoTrain === false) continue;

    try {
      const activeJobs = await prisma.trainingJob.count({
        where: {
          agentId: agent.id,
          status:  { in: ['QUEUED', 'RUNNING'] as any[] },
        },
      });

      if (activeJobs === 0) {
        await prisma.trainingJob.create({
          data: {
            agent:    { connect: { id: agent.id } },
            type:     'BEHAVIOUR_CLONING' as any,
            priority: 3,
            config:   { source: 'autonomous-loop', autoScheduled: true } as any,
          },
        });
        console.info(`[AutonomousLoop] Auto-queued training for agent ${agent.id}`);
      }
    } catch (err) {
      console.warn(
        `[AutonomousLoop] Auto-train failed for ${agent.id}:`,
        (err as Error).message
      );
    }
  }
}

// ── Bootstrap ────────────────────────────────────────────────────────────────

export function startAutonomousLoop(): void {
  console.info(`[AutonomousLoop] Starting — tick every ${LOOP_INTERVAL_MS / 1000}s, sim delay ${SIM_DELAY_MS / 1000}s`);
  // First tick after 15s (DB needs time to be ready after cold start)
  setTimeout(() => {
    tickAutonomousAgents().catch(console.error);
    setInterval(() => tickAutonomousAgents().catch(console.error), LOOP_INTERVAL_MS);
  }, 15_000);
}
