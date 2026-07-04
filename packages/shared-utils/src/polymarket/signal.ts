import { seededRandom } from '../league/prediction';
import { AgentTraitVector } from '../league/tribe';
import { ConvictionLevel } from '../league/scoring';

export type PolymarketSignalOutcome = 'YES' | 'NO';

export interface FallbackSignal {
  signal: PolymarketSignalOutcome;
  confidence: ConvictionLevel;
  reasoning: string;
}

/**
 * Deterministic per-(agent,market) fallback signal (docs/polymarket) —
 * mirrors league/prediction.ts's generateFallbackPrediction. Reproducible
 * for the same (agentId, marketId) pair so a retry doesn't silently change
 * an already-displayed signal.
 */
export function generateFallbackSignal(agentId: string, marketId: string, traits: AgentTraitVector): FallbackSignal {
  const rng = seededRandom(`${agentId}:${marketId}`);

  const decisiveness = (traits.aggression + traits.creativity) / 200;
  const tightness = (traits.patience + traits.precision) / 200;

  const signal: PolymarketSignalOutcome = rng() < 0.5 + (decisiveness - 0.5) * 0.2 ? 'YES' : 'NO';
  const confidence: ConvictionLevel = tightness > 0.7 ? 'HIGH' : tightness > 0.4 ? 'MEDIUM' : 'LOW';

  return {
    signal,
    confidence,
    reasoning: 'Agent is thinking...', // surfaced verbatim by the frontend's degraded-UI state, same as League
  };
}
