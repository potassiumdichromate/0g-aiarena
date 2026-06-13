import { createHash } from 'crypto';

/** §10.2 step 7 — `LeagueSettlementLog.resultHash`, a content hash of the normalized result used for a settlement run. */
export function hashResult(result: unknown): string {
  return createHash('sha256').update(JSON.stringify(result)).digest('hex');
}
