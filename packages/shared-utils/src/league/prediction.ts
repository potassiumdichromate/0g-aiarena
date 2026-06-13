import { PredictionOutcome, ConvictionLevel, LeagueStage } from './scoring';
import { AgentTraitVector } from './tribe';

export class LeaguePredictionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeaguePredictionValidationError';
  }
}

export interface PredictionInput {
  winner: PredictionOutcome;
  scoreHome: number;
  scoreAway: number;
  conviction: ConvictionLevel;
}

/**
 * Applied identically regardless of source — AI, FALLBACK, or USER_OVERRIDE
 * (§6.3). A bad AI response is rejected exactly like a bad user submission.
 */
export function validatePrediction(input: PredictionInput, matchStage: LeagueStage): void {
  if (!Number.isInteger(input.scoreHome) || !Number.isInteger(input.scoreAway)) {
    throw new LeaguePredictionValidationError('scores must be integers');
  }
  if (input.scoreHome < 0 || input.scoreHome > 20 || input.scoreAway < 0 || input.scoreAway > 20) {
    throw new LeaguePredictionValidationError('scores must be within 0-20');
  }

  const impliedWinner: PredictionOutcome =
    input.scoreHome > input.scoreAway ? 'HOME' :
    input.scoreHome < input.scoreAway ? 'AWAY' : 'DRAW';
  if (impliedWinner !== input.winner) {
    throw new LeaguePredictionValidationError(
      `winner '${input.winner}' is inconsistent with score ${input.scoreHome}-${input.scoreAway}`,
    );
  }

  if (matchStage !== 'GROUP' && input.winner === 'DRAW') {
    throw new LeaguePredictionValidationError('knockout-stage predictions cannot be a draw');
  }

  if (!['LOW', 'MEDIUM', 'HIGH'].includes(input.conviction)) {
    throw new LeaguePredictionValidationError('invalid conviction level');
  }
}

// ── §7.3 Deterministic fallback ─────────────────────────────────────────────

function hashStringToInt(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/** Deterministic per-seed PRNG (mulberry32) — same seed always yields the same sequence. */
export function seededRandom(seed: string): () => number {
  let state = hashStringToInt(seed) || 1;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface FallbackPrediction {
  winner: PredictionOutcome;
  scoreHome: number;
  scoreAway: number;
  conviction: ConvictionLevel;
  reasoning: string;
}

/**
 * Always passes `validatePrediction` and is reproducible for the same
 * (agentId, matchId) pair, so a settlement re-run or lazy-gen retry doesn't
 * silently change an already-displayed prediction (§7.3). `traits` are in the
 * 0-100 `AgentTraits` range and normalized to 0-1 here.
 */
export function generateFallbackPrediction(
  agentId: string,
  matchId: string,
  stage: LeagueStage,
  traits: AgentTraitVector,
): FallbackPrediction {
  const rng = seededRandom(`${agentId}:${matchId}`);

  const decisiveness = (traits.aggression + traits.creativity) / 200;
  const tightness = (traits.patience + traits.precision) / 200;

  let winner: PredictionOutcome;
  if (stage !== 'GROUP') {
    // no draws allowed in knockout (§6.3) — slight home-advantage bias
    winner = rng() < 0.52 ? 'HOME' : 'AWAY';
  } else {
    const drawChance = 0.28 * (1 - decisiveness);
    const r = rng();
    winner = r < drawChance ? 'DRAW' : r < drawChance + 0.5 ? 'HOME' : 'AWAY';
  }

  const margin = winner === 'DRAW' ? 0 : 1 + Math.floor(rng() * (tightness > 0.6 ? 1 : 2));
  const base = Math.floor(rng() * 2);
  const [scoreHome, scoreAway] =
    winner === 'HOME' ? [base + margin, base] :
    winner === 'AWAY' ? [base, base + margin] :
    [base, base];

  const conviction: ConvictionLevel = tightness > 0.7 ? 'HIGH' : tightness > 0.4 ? 'MEDIUM' : 'LOW';

  return {
    winner,
    scoreHome,
    scoreAway,
    conviction,
    reasoning: 'Agent is thinking...', // surfaced verbatim by the frontend's degraded-UI state
  };
}
