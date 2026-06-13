export type LeagueStage =
  | 'GROUP'
  | 'ROUND_OF_32'
  | 'ROUND_OF_16'
  | 'QUARTER_FINAL'
  | 'SEMI_FINAL'
  | 'THIRD_PLACE'
  | 'FINAL';

/** A single fixture from a provider's season schedule (§8.1). */
export interface ProviderMatch {
  externalId: string; // provider's fixture id — stored as LeagueMatch.providerId
  homeTeam: string; // normalized to FIFA 3-letter code (mapping table per provider)
  awayTeam: string;
  kickoffAt: string; // ISO 8601, UTC
  stage: string; // provider's raw stage label — mapped to LeagueStage via stage-map.ts
  venue?: string;
  matchday?: number;
}

/** Provider status/result lookup response, normalized across adapters (§8.1). */
export interface NormalizedMatchResult {
  externalId: string;
  status: 'LIVE' | 'FINISHED' | 'POSTPONED' | 'CANCELLED';
  scoreHome: number | null; // regulation (90-min) score
  scoreAway: number | null;
  winner: 'HOME' | 'AWAY' | 'DRAW' | null; // regulation result — used for scoring (§5.3)
  wentToPenalties?: boolean; // informational only; does NOT change `winner` for scoring
  penaltyScore?: { home: number; away: number };
  finishedAt: string | null; // ISO 8601, UTC
  consensus?: 'HOME' | 'AWAY' | 'DRAW'; // populated by league-worker at lock time, not by the provider
}

export interface IFootballDataProvider {
  /** Full season schedule — used by the daily schedule-sync job. */
  getSchedule(seasonExternalId: string): Promise<ProviderMatch[]>;

  /** Batched status/result lookup — used by the settlement-polling job. */
  getLiveAndFinishedResults(externalIds: string[]): Promise<NormalizedMatchResult[]>;
}
