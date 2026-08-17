/**
 * Compute a CapabilityProfile from stored evidence.
 *
 * Evidence hierarchy, strongest first:
 *
 *   1. AgentCapabilitySnapshot  — a seeded evaluation of an actual policy
 *      checkpoint. Reproducible by anyone holding the checkpoint. Marked
 *      `measured`.
 *   2. Battle rows              — real match history, with simulator-generated
 *      rows excluded (see below). Marked `measured` for counts.
 *   3. Agent.traits             — evolved from Unity telemetry. Real, but not
 *      reproducible on demand, so marked `indicative`.
 *   4. Agent.eloRating          — platform-wide ranking. `indicative`.
 *
 * The simulator exclusion is the important one. autonomous-loop.ts picks
 * winners by ELO probability and fabricates playerStats from rand() ranges. If
 * those rows counted, a provider could inflate "100+ Warzone wins" by leaving
 * autonomous mode on overnight — a Sybil-adjacent attack on reputation (T13).
 * Battle.isSimulated marks them, and everything here filters them out.
 *
 * Nothing in this module trusts anything an agent says about itself.
 */

// Routed through the workspace package rather than importing @prisma/client
// directly, so this package depends on the same generated client every service
// uses and does not need its own Prisma dependency.
import type { PrismaClient } from '@ai-arena/db-client';
import type {
  CapabilityMetric,
  CapabilityProfile,
  CapabilitySource,
} from './types';

/** Traits that exist on Agent.traits but cannot be measured in the arena env. */
const UNMEASURABLE_TRAITS = new Set(['loyalty', 'deception']);

function metric(
  value: number,
  source: CapabilitySource,
  confidence: 'measured' | 'indicative',
  observedAt: Date,
  versions?: { formulaVersion?: string; protocolVersion?: string },
): CapabilityMetric {
  return {
    value,
    source,
    confidence,
    observedAt: observedAt.toISOString(),
    ...(versions?.formulaVersion ? { formulaVersion: versions.formulaVersion } : {}),
    ...(versions?.protocolVersion ? { protocolVersion: versions.protocolVersion } : {}),
  };
}

/**
 * Did this agent win the battle?
 *
 * Battle.result is loose JSON written by several producers over time, so this
 * checks the shapes actually present rather than assuming one. An
 * unrecognisable result counts as "not a win" — undercounting is the safe
 * direction for a metric that gates access to paid work.
 */
export function agentWonBattle(result: unknown, agentId: string): boolean {
  if (!result || typeof result !== 'object') return false;
  const r = result as Record<string, unknown>;

  if (typeof r.winnerId === 'string') return r.winnerId === agentId;
  if (typeof r.winner === 'string') return r.winner === agentId;

  if (Array.isArray(r.winners)) return (r.winners as unknown[]).includes(agentId);

  // Some producers nest per-agent outcomes.
  const outcomes = r.outcomes ?? r.agents;
  if (outcomes && typeof outcomes === 'object') {
    const entry = (outcomes as Record<string, unknown>)[agentId];
    if (entry && typeof entry === 'object') {
      const outcome = (entry as Record<string, unknown>).outcome;
      return outcome === 'WIN' || outcome === 'win';
    }
  }

  return false;
}

export interface ComputeProfileOptions {
  /** Cap on battles examined. Recent history is what matters for capability. */
  battleLimit?: number;
}

/**
 * Build the profile for one agent in one game.
 *
 * `gameId` is not optional by design: "100+ wins" means wins in a specific
 * game, and a cross-game profile would let a Robowar record satisfy a Warzone
 * requirement.
 */
export async function computeProfile(
  prisma: PrismaClient,
  agentId: string,
  gameId: string,
  options: ComputeProfileOptions = {},
): Promise<CapabilityProfile | null> {
  const battleLimit = options.battleLimit ?? 500;

  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { id: true, eloRating: true, traits: true, updatedAt: true },
  });
  if (!agent) return null;

  // Latest evaluation-backed snapshot. VERIFICATION outranks FINAL: it was
  // produced by the independent evaluator, not by the training worker.
  const snapshot = await prisma.agentCapabilitySnapshot.findFirst({
    where: { agentId, kind: { in: ['VERIFICATION', 'FINAL'] } },
    orderBy: [{ kind: 'asc' }, { createdAt: 'desc' }],
  });

  const [realBattles, simulatedCount] = await Promise.all([
    prisma.battle.findMany({
      where: { gameId, isSimulated: false, agentIds: { has: agentId }, status: 'COMPLETED' },
      select: { id: true, result: true },
      orderBy: { createdAt: 'desc' },
      take: battleLimit,
    }),
    prisma.battle.count({
      where: { gameId, isSimulated: true, agentIds: { has: agentId }, status: 'COMPLETED' },
    }),
  ]);

  const wins = realBattles.filter((b) => agentWonBattle(b.result, agentId)).length;
  const losses = realBattles.length - wins;
  const now = new Date();

  const metrics: Record<string, CapabilityMetric> = {};

  // ── 1. Evaluation-backed metrics (strongest) ──────────────────────────────
  if (snapshot) {
    const versions = {
      formulaVersion: snapshot.formulaVersion,
      protocolVersion: snapshot.protocolVersion,
    };
    metrics.combatSkill = metric(snapshot.combatSkill, 'evaluation', 'measured', snapshot.createdAt, versions);

    const snapshotTraits = (snapshot.traits ?? {}) as Record<string, unknown>;
    for (const [name, value] of Object.entries(snapshotTraits)) {
      // Nulls are the harness saying "not measurable here" — carrying them
      // through as 0 would read as "measured, and terrible".
      if (typeof value === 'number') {
        metrics[name] = metric(value, 'evaluation', 'measured', snapshot.createdAt, versions);
      }
    }
  }

  // ── 2. Battle history ─────────────────────────────────────────────────────
  metrics.wins = metric(wins, 'battle_history', 'measured', now);
  metrics.losses = metric(losses, 'battle_history', 'measured', now);
  metrics.battles = metric(realBattles.length, 'battle_history', 'measured', now);
  metrics.winRate = metric(
    realBattles.length > 0 ? Math.round((wins / realBattles.length) * 100) : 0,
    'battle_history', 'measured', now,
  );

  // ── 3. Telemetry traits — only where no evaluation exists ─────────────────
  const traits = (agent.traits ?? {}) as Record<string, unknown>;
  for (const [name, value] of Object.entries(traits)) {
    if (typeof value !== 'number') continue;
    if (UNMEASURABLE_TRAITS.has(name)) continue;
    // Never let an indicative value shadow a measured one.
    if (metrics[name]) continue;
    metrics[name] = metric(value, 'telemetry_traits', 'indicative', agent.updatedAt);
  }

  // ── 4. ELO ────────────────────────────────────────────────────────────────
  metrics.eloRating = metric(agent.eloRating, 'elo', 'indicative', agent.updatedAt);

  return {
    agentId,
    gameId,
    computedAt: now.toISOString(),
    metrics,
    provenance: {
      ...(snapshot
        ? {
            snapshotId: snapshot.id,
            checkpointDigest: snapshot.checkpointDigest ?? undefined,
            reportDigest: snapshot.reportDigest,
          }
        : {}),
      battlesConsidered: realBattles.length,
      simulatedBattlesExcluded: simulatedCount,
    },
  };
}

/** Compute profiles for many agents. Sequential to avoid connection-pool storms. */
export async function computeProfiles(
  prisma: PrismaClient,
  agentIds: string[],
  gameId: string,
  options: ComputeProfileOptions = {},
): Promise<CapabilityProfile[]> {
  const profiles: CapabilityProfile[] = [];
  for (const agentId of agentIds) {
    const profile = await computeProfile(prisma, agentId, gameId, options);
    if (profile) profiles.push(profile);
  }
  return profiles;
}
