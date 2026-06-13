export type LeagueTribe = 'NEXUS_01' | 'SHADOW_9' | 'ATHENA' | 'VOIDWALKER';

export type CombatArchetype = 'BERSERKER' | 'TACTICIAN' | 'SUPPORT' | 'ASSASSIN' | 'DEFENDER' | 'HYBRID';

/**
 * Mirrors `@ai-arena/shared-types` `AgentTraits`. Declared structurally here
 * (rather than imported) to keep `shared-utils` dependency-free — any object
 * with these numeric fields (e.g. `Agent.metadata.traits`) satisfies it.
 */
export interface AgentTraitVector {
  aggression: number;
  patience: number;
  adaptability: number;
  riskTolerance: number;
  teamwork: number;
  creativity: number;
  endurance: number;
  precision: number;
}

/** `Agent.traits` is a JSON blob defaulting to `{}` — fill missing fields with the schema midpoint (50). */
export function normalizeTraits(raw: unknown): AgentTraitVector {
  const t = (raw ?? {}) as Partial<AgentTraitVector>;
  return {
    aggression: t.aggression ?? 50,
    patience: t.patience ?? 50,
    adaptability: t.adaptability ?? 50,
    riskTolerance: t.riskTolerance ?? 50,
    teamwork: t.teamwork ?? 50,
    creativity: t.creativity ?? 50,
    endurance: t.endurance ?? 50,
    precision: t.precision ?? 50,
  };
}

// ── Step 1 — archetype default (§3.2) ───────────────────────────────────────
// Covers the common case with zero ambiguity. HYBRID falls through to Step 2.
const ARCHETYPE_TRIBE_MAP: Record<Exclude<CombatArchetype, 'HYBRID'>, LeagueTribe> = {
  TACTICIAN: 'NEXUS_01', // High patience/precision -> data-driven framing
  DEFENDER: 'NEXUS_01', // Conservative, calculated picks
  BERSERKER: 'SHADOW_9', // High aggression -> antagonistic commentary
  ASSASSIN: 'SHADOW_9', // High precision/edge -> cynical, surgical takes
  SUPPORT: 'ATHENA', // High teamwork/endurance -> composed, principled tone
};

// ── Step 2 — trait-centroid affinity (§3.2), used for HYBRID ───────────────
// The product spec's centroid traits (deception, loyalty, resilience) don't
// exist on AgentTraits — nearest real-trait analogues are used instead:
//   deception  -> riskTolerance, loyalty -> teamwork, resilience -> endurance
const TRIBE_CENTROIDS: Record<LeagueTribe, Partial<Record<keyof AgentTraitVector, number>>> = {
  NEXUS_01: { precision: 1.0, patience: 1.0 },
  SHADOW_9: { aggression: 1.0, riskTolerance: 1.0 },
  ATHENA: { teamwork: 1.0, endurance: 1.0 },
  VOIDWALKER: { creativity: 1.0, adaptability: 1.0 },
};

const TRIBE_ORDER: LeagueTribe[] = ['NEXUS_01', 'SHADOW_9', 'ATHENA', 'VOIDWALKER'];

export function tribeAffinity(traits: AgentTraitVector, tribe: LeagueTribe): number {
  const weights = TRIBE_CENTROIDS[tribe];
  return Object.entries(weights).reduce(
    (sum, [trait, weight]) => sum + traits[trait as keyof AgentTraitVector] * (weight ?? 0),
    0,
  );
}

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/**
 * Deterministic, computed once at enrollment and persisted on
 * `LeagueAgentSeasonStats.tribe` — never recomputed mid-season (§3.2).
 *
 * Tie-break on equal Step 2 scores: deterministic hash of `agentId` selects
 * among the tied tribes (lexicographically ordered) so the result is stable
 * per agent without depending on map iteration order.
 */
export function mapAgentToTribe(agentId: string, archetype: CombatArchetype, traits: AgentTraitVector): LeagueTribe {
  if (archetype !== 'HYBRID') {
    return ARCHETYPE_TRIBE_MAP[archetype];
  }

  const scores = TRIBE_ORDER.map((tribe) => ({ tribe, score: tribeAffinity(traits, tribe) }));
  const maxScore = Math.max(...scores.map((s) => s.score));
  const tied = scores.filter((s) => s.score === maxScore).map((s) => s.tribe);

  if (tied.length === 1) return tied[0];

  const sorted = [...tied].sort();
  return sorted[hashString(agentId) % sorted.length];
}
