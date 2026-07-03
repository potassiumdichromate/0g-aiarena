/**
 * NOT WIRED IN. This is a real, docs-verified implementation of the
 * IFootballDataProvider interface for Sportmonks v3, kept here — deliberately
 * outside `providers/`, not imported by `provider-factory.ts`, not re-exported
 * from `index.ts` — so it can't be selected by accident, but is fully intact
 * if the project ever needs to switch off API-Football (pricing, rate limits,
 * coverage gaps, etc).
 *
 * Built and verified against Sportmonks' own live documentation
 * (docs.sportmonks.com/v3) on 2026-07-03: base URL, auth header, the nested
 * `/schedules/seasons/{id}` -> stages[] -> rounds[] -> fixtures[] response
 * shape, the `state_id` status table, and the `scores[]`/`participants[]`
 * field layout for results. Never exercised against a real API key.
 *
 * To reactivate: move this file back to `../sportmonks.provider.ts` (fixing
 * the two relative imports below back to `../types`/`../stage-map`), add the
 * `case 'sportmonks':` branch back to `provider-factory.ts`, and re-add the
 * `SportmonksProvider` export to `index.ts`.
 */
import { IFootballDataProvider, NormalizedMatchResult, ProviderMatch } from '../../types';
import { STAGE_LABEL_MAP } from '../../stage-map';

const BASE_URL = 'https://api.sportmonks.com/v3/football';

/** Sportmonks fixture `state_id` — see https://docs.sportmonks.com/football/api/state-ids */
const LIVE_STATE_IDS = new Set([2, 22, 6, 9]); // 1st half, 2nd half, extra time, penalty shootout
const FINISHED_STATE_IDS = new Set([5, 7, 8]); // full time, after extra time, after penalties
const POSTPONED_STATE_ID = 10;
const CANCELLED_STATE_ID = 12;

/**
 * Sportmonks' own round/stage names don't always match this repo's
 * `STAGE_LABEL_MAP` keys exactly (e.g. they may say "3rd Place Final"
 * instead of "Third Place Play-off") — normalized here so the existing
 * `mapProviderStage()` default table in schedule-sync.ts keeps working
 * unmodified. Extend this if a real World Cup 2026 payload uses a label
 * not covered here — verify against a live response once the API key is
 * available, this was built from Sportmonks' documented conventions, not
 * a live payload.
 */
const SPORTMONKS_STAGE_ALIASES: Record<string, string> = {
  'group stage': 'Group Stage',
  'round of 32': 'Round of 32',
  'round of 16': 'Round of 16',
  'quarter-final': 'Quarter-final',
  'quarter final': 'Quarter-final',
  'quarterfinals': 'Quarter-final',
  'semi-final': 'Semi-final',
  'semi final': 'Semi-final',
  'semifinals': 'Semi-final',
  '3rd place final': 'Third Place Play-off',
  'third place play-off': 'Third Place Play-off',
  'third place final': 'Third Place Play-off',
  final: 'Final',
};

function normalizeStageLabel(rawName: string | undefined): string {
  if (!rawName) return 'Group Stage';
  const alias = SPORTMONKS_STAGE_ALIASES[rawName.trim().toLowerCase()];
  return alias ?? rawName;
}

interface SportmonksFixtureParticipant {
  id: number;
  name: string;
  meta?: { location?: 'home' | 'away'; winner?: boolean | null };
}

interface SportmonksScoreEntry {
  description: string; // "CURRENT" | "1ST_HALF" | "2ND_HALF" | "PENALTIES" | ...
  score: { goals: number; participant: 'home' | 'away' };
}

interface SportmonksFixture {
  id: number;
  name?: string;
  starting_at: string; // "YYYY-MM-DD HH:mm:ss", UTC, per Sportmonks convention
  state_id: number;
  venue_id?: number | null;
  round?: { name?: string } | null;
  stage?: { name?: string } | null;
  participants?: SportmonksFixtureParticipant[];
  scores?: SportmonksScoreEntry[];
}

interface SportmonksListResponse<T> {
  data: T;
}

function toIsoUtc(sportmonksTimestamp: string): string {
  // Sportmonks returns "YYYY-MM-DD HH:mm:ss" with an implicit UTC offset — not
  // valid ISO 8601 as-is (needs a 'T' separator and 'Z' suffix).
  return new Date(`${sportmonksTimestamp.replace(' ', 'T')}Z`).toISOString();
}

function extractTeams(fixture: SportmonksFixture): { home: string | null; away: string | null } {
  const participants = fixture.participants ?? [];
  const home = participants.find((p) => p.meta?.location === 'home');
  const away = participants.find((p) => p.meta?.location === 'away');
  return { home: home?.name ?? null, away: away?.name ?? null };
}

function fixtureToProviderMatch(fixture: SportmonksFixture): ProviderMatch | null {
  const { home, away } = extractTeams(fixture);
  if (!home || !away) return null; // participants not yet confirmed (e.g. "Winner of Group A" placeholder)

  return {
    externalId: String(fixture.id),
    homeTeam: home,
    awayTeam: away,
    kickoffAt: toIsoUtc(fixture.starting_at),
    stage: normalizeStageLabel(fixture.stage?.name),
    matchday: undefined,
  };
}

function fixtureToResult(fixture: SportmonksFixture): NormalizedMatchResult {
  let status: NormalizedMatchResult['status'] = 'POSTPONED';
  if (LIVE_STATE_IDS.has(fixture.state_id)) status = 'LIVE';
  else if (FINISHED_STATE_IDS.has(fixture.state_id)) status = 'FINISHED';
  else if (fixture.state_id === CANCELLED_STATE_ID) status = 'CANCELLED';
  else if (fixture.state_id === POSTPONED_STATE_ID) status = 'POSTPONED';

  const scores = fixture.scores ?? [];
  const scoreHome = scores.find((s) => s.description === 'CURRENT' && s.score.participant === 'home')?.score.goals ?? null;
  const scoreAway = scores.find((s) => s.description === 'CURRENT' && s.score.participant === 'away')?.score.goals ?? null;

  const homeParticipant = fixture.participants?.find((p) => p.meta?.location === 'home');
  const awayParticipant = fixture.participants?.find((p) => p.meta?.location === 'away');
  let winner: NormalizedMatchResult['winner'] = null;
  if (status === 'FINISHED') {
    if (homeParticipant?.meta?.winner === true) winner = 'HOME';
    else if (awayParticipant?.meta?.winner === true) winner = 'AWAY';
    else if (scoreHome !== null && scoreAway !== null) winner = scoreHome === scoreAway ? 'DRAW' : scoreHome > scoreAway ? 'HOME' : 'AWAY';
  }

  const penaltyHome = scores.find((s) => s.description === 'PENALTIES' && s.score.participant === 'home')?.score.goals;
  const penaltyAway = scores.find((s) => s.description === 'PENALTIES' && s.score.participant === 'away')?.score.goals;
  const wentToPenalties = fixture.state_id === 8 || (penaltyHome !== undefined && penaltyAway !== undefined);

  return {
    externalId: String(fixture.id),
    status,
    scoreHome,
    scoreAway,
    winner,
    wentToPenalties,
    // `winner`/CURRENT score are what scoring uses (§5.3) — penaltyScore is display-only,
    // so it's only included when both sides' penalty tallies were actually found, never guessed.
    ...(wentToPenalties && penaltyHome !== undefined && penaltyAway !== undefined
      ? { penaltyScore: { home: penaltyHome, away: penaltyAway } }
      : {}),
    // Sportmonks doesn't expose a distinct "finished at" timestamp on the fixture object —
    // this is informational only (not scoring-relevant), using kickoff as a placeholder.
    finishedAt: status === 'FINISHED' ? toIsoUtc(fixture.starting_at) : null,
  };
}

/**
 * Real Sportmonks v3 Football API integration. Endpoints and field mapping
 * built from https://docs.sportmonks.com/v3/ (fixtures, schedules, livescores,
 * fixture entity, state-ids) — not yet exercised against a live account.
 * Verify the first real response shape once `SPORTMONKS_API_KEY` is set, in
 * particular: the `scores[]` participant/description values, and whether
 * `include=` needs dot-notation (`stages.rounds.fixtures.participants`) for
 * the nested `/schedules/seasons/{id}` endpoint.
 */
export class SportmonksProvider implements IFootballDataProvider {
  constructor(private readonly apiKey: string) {
    if (!apiKey) {
      throw new Error('SportmonksProvider requires SPORTMONKS_API_KEY to be set');
    }
  }

  private async request<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${BASE_URL}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

    const res = await fetch(url.toString(), {
      headers: { Authorization: this.apiKey, Accept: 'application/json' },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Sportmonks API ${res.status} on ${path}: ${body.slice(0, 500)}`);
    }

    return res.json() as Promise<T>;
  }

  async getSchedule(seasonExternalId: string): Promise<ProviderMatch[]> {
    const response = await this.request<
      SportmonksListResponse<
        Array<{ rounds?: Array<{ fixtures?: SportmonksFixture[] }> }>
      >
    >(`/schedules/seasons/${seasonExternalId}`, {
      include: 'stages.rounds.fixtures.participants;stages.rounds.fixtures.scores;stages.rounds.fixtures.stage',
    });

    const fixtures: SportmonksFixture[] = [];
    for (const stage of response.data ?? []) {
      for (const round of stage.rounds ?? []) {
        for (const fixture of round.fixtures ?? []) {
          fixtures.push(fixture);
        }
      }
    }

    return fixtures.map(fixtureToProviderMatch).filter((m): m is ProviderMatch => m !== null);
  }

  async getLiveAndFinishedResults(externalIds: string[]): Promise<NormalizedMatchResult[]> {
    if (externalIds.length === 0) return [];

    // Sportmonks' "Fixtures by Multiple IDs" endpoint takes a comma-separated
    // ID list in the path.
    const response = await this.request<SportmonksListResponse<SportmonksFixture[]>>(
      `/fixtures/multi/${externalIds.join(',')}`,
      { include: 'participants;scores;stage;round' },
    );

    return (response.data ?? []).map(fixtureToResult);
  }
}

// Re-exported so a future stage-mismatch can be diagnosed quickly against
// the canonical table this provider normalizes toward.
export { STAGE_LABEL_MAP as _STAGE_LABEL_MAP_REFERENCE };
