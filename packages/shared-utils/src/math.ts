/**
 * ELO rating calculation
 */
export function calculateElo(
  ratingA: number,
  ratingB: number,
  outcome: 'WIN' | 'LOSS' | 'DRAW',
  kFactor = 32
): { newA: number; newB: number; changeA: number; changeB: number } {
  const expectedA = 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
  const expectedB = 1 - expectedA;

  const scoreA = outcome === 'WIN' ? 1 : outcome === 'DRAW' ? 0.5 : 0;
  const scoreB = 1 - scoreA;

  const changeA = Math.round(kFactor * (scoreA - expectedA));
  const changeB = Math.round(kFactor * (scoreB - expectedB));

  return {
    newA: Math.max(100, ratingA + changeA),
    newB: Math.max(100, ratingB + changeB),
    changeA,
    changeB,
  };
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.max(0, Math.min(1, t));
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function variance(values: number[]): number {
  if (values.length < 2) return 0;
  const avg = mean(values);
  const squaredDiffs = values.map(v => Math.pow(v - avg, 2));
  return mean(squaredDiffs);
}

export function stdDev(values: number[]): number {
  return Math.sqrt(variance(values));
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function normalise(value: number, min: number, max: number): number {
  if (max === min) return 0;
  return clamp((value - min) / (max - min), 0, 1);
}
