import { ConvictionLevel, LeagueStage, PredictionOutcome } from '@ai-arena/db-client';

const INFERENCE_SERVICE_URL = process.env.INFERENCE_SERVICE_URL ?? 'http://localhost:8013';
const FINANCIAL_SERVICE_URL = process.env.FINANCIAL_SERVICE_URL ?? 'http://localhost:8003';

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
 * §7.2/§15.8 — `decideLeaguePrediction` lives in inference-service; called
 * internally for lazy-gen (league-service) and pre-gen (league-worker).
 * Never throws on inference failure (inference-service itself falls back) —
 * only throws on transport/auth errors, which the caller treats as a 502.
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

/** Thrown when financial-service rejects an escrow lock (e.g. insufficient balance) — maps to 400. */
export class EscrowLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EscrowLockError';
  }
}

/**
 * §9.2 — financial-service owns `EscrowRecord`/`AgentWallet` mutations.
 * On success, financial-service updates `LeagueBattle` -> LOCKED itself
 * within the same transaction (§9.2); league-service just re-reads the row.
 */
export async function lockLeagueEscrowRemote(battleId: string): Promise<void> {
  const res = await fetch(`${FINANCIAL_SERVICE_URL}/escrow/league/lock`, {
    method: 'POST',
    headers: serviceHeaders(),
    body: JSON.stringify({ battleId }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let message = text;
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {
      /* not JSON — use raw text */
    }
    throw new EscrowLockError(message || `financial-service escrow lock failed (${res.status})`);
  }
}
