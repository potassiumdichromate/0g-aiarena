import { addHours } from '@ai-arena/shared-utils';
import { leagueRepo, requireActiveSeason, configFor, NoActiveSeasonError } from '../lib/season';

/**
 * §6.4 / §9.1 — every minute: lock any predictions whose match kickoff has
 * passed (claim-based conditional update, idempotent), and expire any
 * PENDING battles that have sat unaccepted past `battles.pendingExpiryHours`.
 */
export async function runLockSweep(): Promise<void> {
  const locked = await leagueRepo.lockDuePredictions();
  if (locked > 0) console.log(`[league-worker] lock-sweep: locked ${locked} prediction(s)`);

  let season;
  try {
    season = await requireActiveSeason();
  } catch (err) {
    if (err instanceof NoActiveSeasonError) return;
    throw err;
  }

  const config = configFor(season);
  const cutoff = addHours(new Date(), -config.battles.pendingExpiryHours);
  const expired = await leagueRepo.expirePendingBattles(cutoff);
  if (expired > 0) console.log(`[league-worker] lock-sweep: expired ${expired} pending battle(s)`);
}
