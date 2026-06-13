import { createFootballDataProvider } from '@ai-arena/football-data-client';
import { PredictionOutcome } from '@ai-arena/db-client';
import { leagueRepo } from '../lib/season';
import { settleMatch, cancelMatch } from '../lib/settlement';

const provider = createFootballDataProvider();

/**
 * §10.1 — every 2 minutes: poll the football data provider for any match
 * past kickoff that is still SCHEDULED/LIVE. FINISHED matches get a
 * consensus computed from their LOCKED predictions, persisted as
 * `LeagueMatch.result`, and handed to `settleMatch`. CANCELLED matches are
 * voided via `cancelMatch`. POSTPONED matches are left alone — schedule-sync
 * will pick up a rescheduled kickoff time the next time it runs.
 */
export async function runSettlementTick(): Promise<void> {
  const candidates = await leagueRepo.listSettlementCandidates();
  if (candidates.length === 0) return;

  const results = await provider.getLiveAndFinishedResults(candidates.map((c) => c.providerId));
  const resultByExternalId = new Map(results.map((r) => [r.externalId, r]));

  for (const candidate of candidates) {
    const result = resultByExternalId.get(candidate.providerId);
    if (!result) continue;

    try {
      switch (result.status) {
        case 'LIVE':
          await leagueRepo.updateMatch(candidate.id, { status: 'LIVE' });
          break;

        case 'FINISHED': {
          const locked = await leagueRepo.listPredictionsByMatch(candidate.id, 'LOCKED');
          const consensus = computeConsensus(locked);

          await leagueRepo.updateMatch(candidate.id, {
            status: 'FINISHED',
            settledAt: new Date(),
            result: {
              winner: result.winner,
              scoreHome: result.scoreHome,
              scoreAway: result.scoreAway,
              ...(consensus && { consensus }),
            },
          });
          await settleMatch(candidate.id);
          break;
        }

        case 'CANCELLED':
          await cancelMatch(candidate.id);
          break;

        case 'POSTPONED':
          console.log(`[league-worker] settlement-tick: match ${candidate.id} is POSTPONED — awaiting reschedule`);
          break;
      }
    } catch (err) {
      console.error(`[league-worker] settlement-tick — match ${candidate.id}:`, (err as Error).message);
    }
  }
}

/** Majority vote among LOCKED predictions' `winner`, tie-broken HOME > DRAW > AWAY. */
function computeConsensus(predictions: { winner: PredictionOutcome }[]): PredictionOutcome | undefined {
  if (predictions.length === 0) return undefined;

  const counts: Record<PredictionOutcome, number> = { HOME: 0, DRAW: 0, AWAY: 0 };
  for (const p of predictions) counts[p.winner]++;

  let consensus: PredictionOutcome = 'HOME';
  let max = -1;
  for (const outcome of ['HOME', 'DRAW', 'AWAY'] as const) {
    if (counts[outcome] > max) {
      max = counts[outcome];
      consensus = outcome;
    }
  }
  return consensus;
}
