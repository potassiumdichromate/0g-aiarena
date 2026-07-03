import { IFootballDataProvider, NormalizedMatchResult, ProviderMatch } from '../types';

const BASE_URL = 'https://v3.football.api-sports.io';

/** API-Football fixture `status.short` — https://www.api-football.com/documentation-v3 (Fixtures > Available fixtures status) */
const LIVE_STATUSES = new Set(['1H', 'HT', '2H', 'ET', 'BT', 'P', 'SUSP', 'INT']);
const FINISHED_STATUSES = new Set(['FT', 'AET', 'PEN', 'AWD', 'WO']); // AWD/WO = awarded/walkover — a real result exists, treated as finished
const POSTPONED_STATUSES = new Set(['PST']);
const CANCELLED_STATUSES = new Set(['CANC', 'ABD']); // ABD (abandoned) has no path to a valid final result — closest fit is CANCELLED
// Deliberately NOT mapped to any of the four NormalizedMatchResult statuses: TBD, NS.
// A fixture in one of those states has no result yet — it's filtered out of getLiveAndFinishedResults
// so settlement-tick's existing "if (!result) continue" just waits and retries next tick, rather
// than being force-fit into POSTPONED/CANCELLED and wrongly voided.

/**
 * Sportmonks used a single numeric season_id as `seasonExternalId`. API-Football
 * identifies a season by (league id, year) as two separate query params, so
 * `LeagueSeason.providerId` for this provider is the composite string
 * "{leagueId}:{year}", e.g. "1:2026" for a World Cup league id of 1.
 */
function parseSeasonExternalId(seasonExternalId: string): { leagueId: string; year: string } {
  const [leagueId, year] = seasonExternalId.split(':');
  if (!leagueId || !year) {
    throw new Error(
      `ApiFootballProvider: seasonExternalId must be "{leagueId}:{year}" (e.g. "1:2026"), got "${seasonExternalId}"`,
    );
  }
  return { leagueId, year };
}

/**
 * API-Football's `round` string is free text, e.g. "Group Stage - 1" for group
 * matchdays or a bare stage name ("Round of 16", "Quarter-finals", "Final") for
 * knockout rounds. Normalized to this repo's canonical stage-map.ts labels
 * (built from https://docs.sportmonks.com/... conventions originally, but the
 * label set is provider-agnostic) plus an extracted matchday number when present.
 * Not yet verified against a real World Cup 2026 payload — confirm the exact
 * `round` strings once fixtures are pulled with a real key, this is built from
 * API-Football's documented general conventions.
 */
function normalizeRound(round: string | undefined): { stage: string; matchday?: number } {
  if (!round) return { stage: 'Group Stage' };

  const groupMatch = round.match(/^Group Stage\s*-\s*(\d+)$/i);
  if (groupMatch) return { stage: 'Group Stage', matchday: Number(groupMatch[1]) };

  const normalized = round.trim().toLowerCase();
  const KNOCKOUT_ALIASES: Record<string, string> = {
    'round of 32': 'Round of 32',
    'round of 16': 'Round of 16',
    'quarter-finals': 'Quarter-final',
    'quarter finals': 'Quarter-final',
    quarterfinals: 'Quarter-final',
    'semi-finals': 'Semi-final',
    'semi finals': 'Semi-final',
    semifinals: 'Semi-final',
    '3rd place final': 'Third Place Play-off',
    'third place final': 'Third Place Play-off',
    'third place play-off': 'Third Place Play-off',
    final: 'Final',
  };

  return { stage: KNOCKOUT_ALIASES[normalized] ?? round };
}

interface ApiFootballTeam {
  id: number;
  name: string;
  winner: boolean | null;
}

interface ApiFootballFixture {
  fixture: {
    id: number;
    date: string; // ISO 8601 with offset, e.g. "2020-02-06T14:00:00+00:00"
    venue: { id: number | null; name: string | null; city: string | null };
    status: { long: string; short: string; elapsed: number | null };
  };
  league: {
    id: number;
    season: number;
    round: string;
  };
  teams: {
    home: ApiFootballTeam;
    away: ApiFootballTeam;
  };
  goals: { home: number | null; away: number | null };
  score: {
    fulltime: { home: number | null; away: number | null };
    extratime: { home: number | null; away: number | null };
    penalty: { home: number | null; away: number | null };
  };
}

interface ApiFootballResponse<T> {
  errors: unknown[] | Record<string, string>;
  results: number;
  response: T[];
}

function fixtureToProviderMatch(fixture: ApiFootballFixture): ProviderMatch | null {
  const { home, away } = fixture.teams;
  if (!home?.name || !away?.name) return null; // placeholder team ("Winner of Group A") not yet resolved

  const { stage, matchday } = normalizeRound(fixture.league.round);

  return {
    externalId: String(fixture.fixture.id),
    homeTeam: home.name,
    awayTeam: away.name,
    kickoffAt: new Date(fixture.fixture.date).toISOString(),
    stage,
    ...(fixture.fixture.venue.name && { venue: fixture.fixture.venue.name }),
    ...(matchday !== undefined && { matchday }),
  };
}

function fixtureToResult(fixture: ApiFootballFixture): NormalizedMatchResult | null {
  const short = fixture.fixture.status.short;

  let status: NormalizedMatchResult['status'];
  if (LIVE_STATUSES.has(short)) status = 'LIVE';
  else if (FINISHED_STATUSES.has(short)) status = 'FINISHED';
  else if (POSTPONED_STATUSES.has(short)) status = 'POSTPONED';
  else if (CANCELLED_STATUSES.has(short)) status = 'CANCELLED';
  else return null; // TBD / NS — no result yet, let settlement-tick retry next poll rather than guess

  const scoreHome = fixture.goals.home;
  const scoreAway = fixture.goals.away;

  let winner: NormalizedMatchResult['winner'] = null;
  if (status === 'FINISHED') {
    if (fixture.teams.home.winner === true) winner = 'HOME';
    else if (fixture.teams.away.winner === true) winner = 'AWAY';
    else if (scoreHome !== null && scoreAway !== null) winner = scoreHome === scoreAway ? 'DRAW' : scoreHome > scoreAway ? 'HOME' : 'AWAY';
  }

  const penalty = fixture.score.penalty;
  const wentToPenalties = penalty.home !== null && penalty.away !== null;

  return {
    externalId: String(fixture.fixture.id),
    status,
    scoreHome,
    scoreAway,
    winner,
    wentToPenalties,
    ...(wentToPenalties ? { penaltyScore: { home: penalty.home as number, away: penalty.away as number } } : {}),
    // API-Football doesn't expose a distinct "finished at" timestamp on the fixture object —
    // informational only (not scoring-relevant, see §5.3), using kickoff as a placeholder.
    finishedAt: status === 'FINISHED' ? new Date(fixture.fixture.date).toISOString() : null,
  };
}

/**
 * Real API-Football (api-sports.io) v3 integration. Endpoint paths and response
 * field mapping verified live against https://www.api-football.com/documentation-v3
 * on 2026-07-03 (Fixtures endpoint response sample, Leagues endpoint, fixture
 * status table) — not yet exercised against a real API key / live World Cup 2026
 * payload. Verify the first real response once `API_FOOTBALL_API_KEY` is set,
 * in particular the exact `round` string format for World Cup group/knockout
 * stages (see `normalizeRound` above).
 */
export class ApiFootballProvider implements IFootballDataProvider {
  constructor(private readonly apiKey: string) {
    if (!apiKey) {
      throw new Error('ApiFootballProvider requires API_FOOTBALL_API_KEY to be set');
    }
  }

  private async request<T>(params: Record<string, string>): Promise<ApiFootballResponse<T>> {
    const url = new URL(`${BASE_URL}/fixtures`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

    const res = await fetch(url.toString(), {
      headers: { 'x-apisports-key': this.apiKey },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`API-Football ${res.status} on /fixtures: ${body.slice(0, 500)}`);
    }

    const json = (await res.json()) as ApiFootballResponse<T>;
    const errors = json.errors;
    const hasErrors = Array.isArray(errors) ? errors.length > 0 : Object.keys(errors ?? {}).length > 0;
    if (hasErrors) {
      throw new Error(`API-Football returned errors: ${JSON.stringify(errors)}`);
    }

    return json;
  }

  async getSchedule(seasonExternalId: string): Promise<ProviderMatch[]> {
    const { leagueId, year } = parseSeasonExternalId(seasonExternalId);
    const { response } = await this.request<ApiFootballFixture>({ league: leagueId, season: year });
    return response.map(fixtureToProviderMatch).filter((m): m is ProviderMatch => m !== null);
  }

  async getLiveAndFinishedResults(externalIds: string[]): Promise<NormalizedMatchResult[]> {
    if (externalIds.length === 0) return [];

    // API-Football batches by a hyphen-joined `ids` param, max 20 per call —
    // chunk defensively in case a settlement tick ever has more candidates than that.
    const chunks: string[][] = [];
    for (let i = 0; i < externalIds.length; i += 20) chunks.push(externalIds.slice(i, i + 20));

    const results: NormalizedMatchResult[] = [];
    for (const chunk of chunks) {
      const { response } = await this.request<ApiFootballFixture>({ ids: chunk.join('-') });
      for (const fixture of response) {
        const result = fixtureToResult(fixture);
        if (result) results.push(result);
      }
    }
    return results;
  }
}
