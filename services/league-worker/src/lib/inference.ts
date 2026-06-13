import { ConvictionLevel, LeagueStage, PredictionOutcome } from '@ai-arena/db-client';

const INFERENCE_SERVICE_URL = process.env.INFERENCE_SERVICE_URL ?? 'http://localhost:8013';

function serviceHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Service-Key': process.env.INTERNAL_SERVICE_SECRET ?? '',
  };
}

export interface LeagueMatchContext {
  matchId: string;
  homeTeam: string;
  awayTeam: string;
  stage: LeagueStage;
  kickoffAt: string;
  headToHead?: { homeWins: number; awayWins: number; draws: number };
}

export interface LeaguePredictionResult {
  winner: PredictionOutcome;
  scoreHome: number;
  scoreAway: number;
  conviction: ConvictionLevel;
  reasoning: string;
  source: 'AI' | 'FALLBACK';
}

/**
 * §6.2 pre-gen — `decideLeaguePrediction` lives in inference-service. Never
 * throws on inference failure (inference-service itself falls back) — only
 * on transport/auth errors, which the caller falls back to the deterministic
 * generator for.
 */
export async function requestLeaguePrediction(agentId: string, matchContext: LeagueMatchContext): Promise<LeaguePredictionResult> {
  const res = await fetch(`${INFERENCE_SERVICE_URL}/league-prediction`, {
    method: 'POST',
    headers: serviceHeaders(),
    body: JSON.stringify({ agentId, matchContext }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`inference-service /league-prediction returned ${res.status}: ${text}`);
  }

  const data = (await res.json()) as { prediction: LeaguePredictionResult };
  return data.prediction;
}
