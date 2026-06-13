import { ConvictionLevel, LeagueStage, PredictionOutcome, LeagueAgentSeasonStats } from '@ai-arena/db-client';
import { ScoringConfig } from '@ai-arena/shared-utils';

/** Presentational mapping — conviction level -> a 0-100 "confidence" display percentage. */
export function convictionToConfidencePct(conviction: ConvictionLevel): number {
  return { LOW: 60, MEDIUM: 75, HIGH: 90 }[conviction];
}

/**
 * §15.7.2 — "what this agent COULD earn if its current pick is exactly right."
 * Always assumes the best case (exact score) since `isExactScore` is unknown pre-settlement.
 */
export function potentialArenaPayout(conviction: ConvictionLevel, stage: LeagueStage, scoring: ScoringConfig): number {
  return scoring.basePoints.correctExactScore * scoring.convictionMultiplier[conviction] * scoring.stageMultiplier[stage];
}

/** §15.3 `predictionPool` — sum of every prediction's best-case $ARENA payout for the match. */
export function sumPredictionPool(predictions: { conviction: ConvictionLevel }[], stage: LeagueStage, scoring: ScoringConfig): number {
  return predictions.reduce((sum, p) => sum + potentialArenaPayout(p.conviction, stage, scoring), 0);
}

/** "BRA" / "ARG" / "Draw" — short label for the predicted side, used with a score e.g. "BRA 2-1". */
export function pickLabel(winner: PredictionOutcome, homeTeam: string, awayTeam: string): string {
  if (winner === 'HOME') return homeTeam;
  if (winner === 'AWAY') return awayTeam;
  return 'Draw';
}

/** "BRA Win" / "Draw" — used for the §15.7.1 Match Result question pick. */
export function matchResultPickLabel(winner: PredictionOutcome, homeTeam: string, awayTeam: string): string {
  return winner === 'DRAW' ? 'Draw' : `${pickLabel(winner, homeTeam, awayTeam)} Win`;
}

export interface ConsensusDTO {
  homePct: number;
  awayPct: number;
  drawPct: number;
}

/** §15.3 `consensus` — generalized 3-way pick distribution across all predictions for a match. */
export function computeConsensus(winners: PredictionOutcome[]): ConsensusDTO {
  if (winners.length === 0) return { homePct: 0, awayPct: 0, drawPct: 0 };

  const home = winners.filter((w) => w === 'HOME').length;
  const away = winners.filter((w) => w === 'AWAY').length;
  const draw = winners.filter((w) => w === 'DRAW').length;
  const total = winners.length;

  return {
    homePct: Math.round((home / total) * 100),
    awayPct: Math.round((away / total) * 100),
    drawPct: Math.round((draw / total) * 100),
  };
}

/** §15.5 — "prediction accuracy record", e.g. "18-2", not a battle win/loss record. */
export function predictionRecord(stats: Pick<LeagueAgentSeasonStats, 'correctWinnerCount' | 'predictionsTotal'>): string {
  return `${stats.correctWinnerCount}-${stats.predictionsTotal - stats.correctWinnerCount}`;
}

/** §15.3 — derive `homeScore`/`awayScore`/`liveMinute` from `LeagueMatch.result` (Json, shape varies by provider). */
export function scoreFromResult(result: unknown): { homeScore: number | null; awayScore: number | null; liveMinute: number | null } {
  const r = (result ?? {}) as Record<string, unknown>;
  return {
    homeScore: typeof r.scoreHome === 'number' ? r.scoreHome : null,
    awayScore: typeof r.scoreAway === 'number' ? r.scoreAway : null,
    liveMinute: typeof r.liveMinute === 'number' ? r.liveMinute : null,
  };
}
