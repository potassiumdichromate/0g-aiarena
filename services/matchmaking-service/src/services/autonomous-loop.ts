/**
 * AutonomousLoop — background tick that runs every LOOP_INTERVAL_MS (default 60s).
 *
 * For every agent with metadata.autonomousMode = true:
 *   1. Check Redis queue status — if not in queue, auto-join matchmaking
 *   2. Check training jobs — if none running/queued and autoTrain is on, queue a job
 *
 * Uses Prisma and the Matchmaker directly (no HTTP round-trip for queue ops).
 * Training is queued via direct Prisma insert (avoids JWT auth on agent-service).
 */

import { prisma } from '@ai-arena/db-client';
import { Matchmaker } from './matchmaker';

const LOOP_INTERVAL_MS = parseInt(process.env.AUTONOMOUS_LOOP_INTERVAL_MS ?? '60000', 10);
const matchmaker = new Matchmaker();

async function tickAutonomousAgents(): Promise<void> {
  let agents: Array<{ id: string; eloRating: number; metadata: unknown }> = [];

  try {
    // Pull all non-retired agents with autonomousMode enabled.
    // Prisma JSON path filter works on Postgres.
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

    // ── Step 1: Auto-queue ─────────────────────────────────────────────────────
    try {
      const status = await matchmaker.getQueueStatus(agent.id);
      if (!status.inQueue) {
        await matchmaker.joinQueue(agent.id, gameId, mode, eloRange);
        console.info(`[AutonomousLoop] Auto-queued agent ${agent.id} (ELO ${agent.eloRating}, mode ${mode})`);
      }
    } catch (err) {
      console.warn(`[AutonomousLoop] Queue check/join failed for ${agent.id}:`, (err as Error).message);
    }

    // ── Step 2: Auto-train ─────────────────────────────────────────────────────
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
      console.warn(`[AutonomousLoop] Auto-train failed for ${agent.id}:`, (err as Error).message);
    }
  }
}

export function startAutonomousLoop(): void {
  console.info(`[AutonomousLoop] Starting — tick every ${LOOP_INTERVAL_MS / 1000}s`);
  // First tick after 15s (DB needs time to be ready after cold start)
  setTimeout(() => {
    tickAutonomousAgents().catch(console.error);
    setInterval(() => tickAutonomousAgents().catch(console.error), LOOP_INTERVAL_MS);
  }, 15_000);
}
