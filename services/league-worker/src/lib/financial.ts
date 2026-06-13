const FINANCIAL_SERVICE_URL = process.env.FINANCIAL_SERVICE_URL ?? 'http://localhost:8003';

function serviceHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Service-Key': process.env.INTERNAL_SERVICE_SECRET ?? '',
  };
}

/** Thrown when financial-service rejects a league credit/settlement call. */
export class LeagueFinancialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeagueFinancialError';
  }
}

export interface LeaguePredictionRewardRequest {
  agentId: string;
  predictionId: string;
  amount: number;
  metadata: { matchId: string; seasonId: string };
}

/**
 * §5.6/§10.2 step 4 — financial-service credits `AgentWallet.balanceArena`
 * via a `LedgerEntry` (type `LEAGUE_PREDICTION_REWARD`, status `CONFIRMED`).
 * Idempotent on `(predictionId, type)` — a duplicate call for an
 * already-credited prediction must be a no-op, not an error (task #20).
 */
export async function creditLeaguePredictionReward(req: LeaguePredictionRewardRequest): Promise<void> {
  const res = await fetch(`${FINANCIAL_SERVICE_URL}/escrow/league/credit`, {
    method: 'POST',
    headers: serviceHeaders(),
    body: JSON.stringify(req),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new LeagueFinancialError(`financial-service /escrow/league/credit failed (${res.status}): ${text}`);
  }
}

export interface LeagueBattleSettleRequest {
  battleId: string;
  winnerId: string | null; // null -> void/refund both stakes (tie or cancellation)
}

/**
 * §9.3/§9.4 — financial-service settles (`winnerId` set, loser's stake paid
 * to the winner) or voids (`winnerId === null`, both stakes refunded) the
 * `LeagueBattle`'s `EscrowRecord`, transitioning `LeagueBattle.status` to
 * `SETTLED` or `VOID` within the same transaction (task #20).
 */
export async function settleLeagueBattleRemote(req: LeagueBattleSettleRequest): Promise<void> {
  const res = await fetch(`${FINANCIAL_SERVICE_URL}/escrow/league/battles/settle`, {
    method: 'POST',
    headers: serviceHeaders(),
    body: JSON.stringify(req),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new LeagueFinancialError(`financial-service /escrow/league/battles/settle failed (${res.status}): ${text}`);
  }
}
