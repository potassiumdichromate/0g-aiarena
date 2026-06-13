import { clamp } from '../math';

export type PredictionOutcome = 'HOME' | 'DRAW' | 'AWAY';
export type ConvictionLevel = 'LOW' | 'MEDIUM' | 'HIGH';
export type LeagueStage =
  | 'GROUP'
  | 'ROUND_OF_32'
  | 'ROUND_OF_16'
  | 'QUARTER_FINAL'
  | 'SEMI_FINAL'
  | 'THIRD_PLACE'
  | 'FINAL';
export type EvolutionStage = 'GENESIS' | 'AWAKENED' | 'ASCENDED' | 'LEGENDARY' | 'MYTHIC';

// ── §5.2 Scoring constants ──────────────────────────────────────────────────

export interface ScoringConfig {
  basePoints: {
    correctWinnerOnly: number;
    correctExactScore: number;
    incorrect: number;
  };
  convictionMultiplier: Record<ConvictionLevel, number>;
  stageMultiplier: Record<LeagueStage, number>;
  upsetBonus: number;
  kp: {
    perPrediction: number;
    perCorrectWinner: number;
    perUpsetBonus: number;
  };
}

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  basePoints: {
    correctWinnerOnly: 20,
    correctExactScore: 50, // implies correct winner; NOT additive with the 20
    incorrect: 0,
  },
  convictionMultiplier: {
    LOW: 1.0,
    MEDIUM: 1.25,
    HIGH: 1.5,
  },
  stageMultiplier: {
    GROUP: 1.0,
    ROUND_OF_32: 1.25,
    ROUND_OF_16: 1.5,
    QUARTER_FINAL: 2.0,
    SEMI_FINAL: 3.0,
    THIRD_PLACE: 3.0, // [DECISION] not specified in source PDF; treated as SF-equivalent
    FINAL: 5.0,
  },
  upsetBonus: 0.25, // +25% if backing the underdog and correct
  kp: {
    perPrediction: 2, // awarded for any settled, non-void prediction
    perCorrectWinner: 5,
    perUpsetBonus: 5, // additive on top of perCorrectWinner if isUpset
  },
};

export interface NormalizedMatchResult {
  winner: PredictionOutcome;
  scoreHome: number;
  scoreAway: number;
}

export interface PredictionForScoring {
  winner: PredictionOutcome;
  scoreHome: number;
  scoreAway: number;
  conviction: ConvictionLevel;
}

export interface MatchForScoring {
  stage: LeagueStage;
}

export interface ScoreResult {
  isCorrectWinner: boolean;
  isExactScore: boolean;
  isUpset: boolean;
  basePoints: number;
  arenaAwarded: number; // rounded, credited to AgentWallet.balanceArena
  kpAwarded: number; // credited to LeagueUserProfile.kpBalance
}

/**
 * Pure function, called once per LOCKED prediction during settlement (§10.2).
 * `wasUnderdog` is computed against the cached match consensus (§5.4).
 */
export function scoreLeaguePrediction(
  prediction: PredictionForScoring,
  result: NormalizedMatchResult,
  match: MatchForScoring,
  wasUnderdog: boolean,
  config: ScoringConfig = DEFAULT_SCORING_CONFIG,
): ScoreResult {
  const isCorrectWinner = prediction.winner === result.winner;
  const isExactScore =
    isCorrectWinner &&
    prediction.scoreHome === result.scoreHome &&
    prediction.scoreAway === result.scoreAway;

  if (!isCorrectWinner) {
    return {
      isCorrectWinner: false,
      isExactScore: false,
      isUpset: false,
      basePoints: config.basePoints.incorrect,
      arenaAwarded: 0,
      kpAwarded: config.kp.perPrediction, // KP rewards participation, not correctness
    };
  }

  const isUpset = wasUnderdog; // correct AND backed the underdog
  const basePoints = isExactScore
    ? config.basePoints.correctExactScore
    : config.basePoints.correctWinnerOnly;

  const convictionMult = config.convictionMultiplier[prediction.conviction];
  const stageMult = config.stageMultiplier[match.stage];
  const upsetMult = isUpset ? 1 + config.upsetBonus : 1;

  const arenaAwarded = Math.round(basePoints * convictionMult * stageMult * upsetMult);

  let kpAwarded = config.kp.perPrediction + config.kp.perCorrectWinner;
  if (isUpset) kpAwarded += config.kp.perUpsetBonus;

  return { isCorrectWinner, isExactScore, isUpset, basePoints, arenaAwarded, kpAwarded };
}

// ── §5.5 Reputation — Bayesian-smoothed composite ───────────────────────────

export interface ReputationConfig {
  base: number;
  priorAccuracy: number;
  priorWeight: number;
  accuracyWeight: number;
  exactRateWeight: number;
  battleWinWeight: number;
  streakBonusPerWin: number;
  streakBonusCap: number;
  calibrationRange: number;
  rivalryBonusWeight: number;
  evolutionStageBonus: Record<EvolutionStage, number>;
  min: number;
  max: number;
}

export const DEFAULT_REPUTATION_CONFIG: ReputationConfig = {
  base: 1500,
  priorAccuracy: 0.45, // slightly below 50% — three-way outcome is harder than a coin flip
  priorWeight: 10, // first 10 predictions are heavily smoothed toward priorAccuracy
  accuracyWeight: 2000, // smoothedAccuracy contributes 0..2000
  exactRateWeight: 1000, // smoothedExactRate contributes 0..1000
  battleWinWeight: 500, // battle win-rate contributes 0..500
  streakBonusPerWin: 20, // currentStreak * 20, capped at streakBonusCap
  streakBonusCap: 300,
  calibrationRange: 200, // conviction-calibration contributes -200..+200
  rivalryBonusWeight: 300, // rivalryRate (win-rate across "serious" rivalries, totalMatchups>=3) contributes 0..300
  evolutionStageBonus: {
    GENESIS: 0,
    AWAKENED: 100,
    ASCENDED: 250,
    LEGENDARY: 400,
    MYTHIC: 500,
  },
  min: 0,
  max: 6000,
};

export interface AgentStatsForReputation {
  predictionsTotal: number;
  correctWinnerCount: number;
  exactScoreCount: number;
  currentStreak: number;
  battleWins: number;
  battleLosses: number;
  avgConvictionCorrect: number;
  avgConvictionWrong: number;
  /**
   * §13 — win-rate across this agent's "serious" rivalries (totalMatchups >= 3),
   * 0 if it has none yet. Rewards agents who consistently come out ahead in
   * their recurring matchups, not just their overall record.
   */
  rivalryRate: number;
}

function smoothedRate(hits: number, total: number, prior: number, priorWeight: number): number {
  return (hits + prior * priorWeight) / (total + priorWeight);
}

/**
 * Recomputed for a single agent immediately after its prediction (and any
 * battle) for a match settles — O(1) per affected agent, never a global
 * recompute.
 */
export function computeReputation(
  stats: AgentStatsForReputation,
  evolutionStage: EvolutionStage,
  cfg: ReputationConfig = DEFAULT_REPUTATION_CONFIG,
): number {
  const accuracy = smoothedRate(stats.correctWinnerCount, stats.predictionsTotal, cfg.priorAccuracy, cfg.priorWeight);
  const exactRate = smoothedRate(stats.exactScoreCount, stats.predictionsTotal, cfg.priorAccuracy * 0.3, cfg.priorWeight);

  const battleTotal = stats.battleWins + stats.battleLosses;
  const battleWinRate = battleTotal > 0 ? smoothedRate(stats.battleWins, battleTotal, 0.5, 4) : 0.5;

  const streakBonus = Math.min(stats.currentStreak * cfg.streakBonusPerWin, cfg.streakBonusCap);

  // Conviction calibration: reward agents whose conviction tracks their actual
  // hit rate (high conviction more often correct than wrong = positive;
  // inverted = negative).
  const calibration = clamp(
    (stats.avgConvictionCorrect - stats.avgConvictionWrong) * cfg.calibrationRange,
    -cfg.calibrationRange,
    cfg.calibrationRange,
  );

  const rivalryBonus = clamp(stats.rivalryRate, 0, 1) * cfg.rivalryBonusWeight;

  const raw =
    cfg.base +
    cfg.accuracyWeight * (accuracy - 0.5) * 2 + // map 0..1 -> -1..1 -> scaled
    cfg.exactRateWeight * exactRate +
    cfg.battleWinWeight * (battleWinRate - 0.5) * 2 +
    streakBonus +
    calibration +
    rivalryBonus +
    cfg.evolutionStageBonus[evolutionStage];

  return clamp(raw, cfg.min, cfg.max);
}

/**
 * `reputationProvisional` is simply `predictionsTotal < 20` — recomputed
 * alongside reputation, surfaced to the frontend as a "provisional" badge so
 * early-season swings don't look like real leaderboard volatility.
 */
export function isReputationProvisional(predictionsTotal: number): boolean {
  return predictionsTotal < 20;
}
