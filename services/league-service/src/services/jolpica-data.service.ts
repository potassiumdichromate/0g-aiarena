import { prisma } from '@ai-arena/db-client';

/**
 * Jolpica F1 (Ergast successor) -- the real historical driver/constructor
 * form backbone described in docs/league/F1_PREDICTION_ENGINE_PLAN.md §2/§9.
 * Free, no API key, Ergast-compatible response shape (verified live).
 * Volunteer-maintained -- every response is cached in our own DB, never
 * queried live at prediction time.
 *
 * This is REAL past-season data (2018-2025), independent of whatever the
 * "current" simulated date is elsewhere in this app -- it answers "what has
 * this driver/team historically achieved", the Jolpica half of the plan's
 * "Jolpica answers history, FastF1 answers this weekend's pace" split.
 * FastF1 itself (Python-only, telemetry) is out of scope for this Node
 * backend and isn't implemented here -- see that doc for what's deferred.
 */
const JOLPICA_BASE = 'https://api.jolpi.ca/ergast/f1';

const MIN_CALL_INTERVAL_MS = 300;
let lastCallAt = 0;

async function jolpicaFetch<T>(path: string): Promise<T> {
  const wait = lastCallAt + MIN_CALL_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();

  const res = await fetch(`${JOLPICA_BASE}${path}`);
  if (!res.ok) throw new Error(`Jolpica ${path} returned ${res.status}`);
  return res.json() as Promise<T>;
}

interface JolpicaDriver {
  driverId: string; code?: string; givenName: string; familyName: string;
}
interface JolpicaConstructor {
  constructorId: string; name: string;
}
interface JolpicaResult {
  grid: string; position?: string; points: string; status: string; laps: string;
  Driver: JolpicaDriver; Constructor: JolpicaConstructor;
  FastestLap?: { rank: string };
}
interface JolpicaRace {
  season: string; round: string; raceName: string; date: string;
  Circuit: { circuitId: string };
  Results?: JolpicaResult[];
}
interface JolpicaDriverStanding {
  position: string; points: string; wins: string;
  Driver: JolpicaDriver; Constructors: JolpicaConstructor[];
}

class JolpicaDataService {
  /** Number of rounds in a season, via the season's race schedule. */
  private async getRoundCount(season: number): Promise<number> {
    const data = await jolpicaFetch<{ MRData: { RaceTable: { Races: JolpicaRace[] } } }>(`/${season}.json?limit=100`);
    return data.MRData.RaceTable.Races.length;
  }

  /**
   * Pulls every round's race classification for a season into F1RaceResult.
   * Idempotent upsert -- safe to re-run.
   */
  async syncSeasonResults(season: number): Promise<number> {
    const rounds = await this.getRoundCount(season);
    let synced = 0;

    for (let round = 1; round <= rounds; round++) {
      try {
        const data = await jolpicaFetch<{ MRData: { RaceTable: { Races: JolpicaRace[] } } }>(`/${season}/${round}/results.json?limit=30`);
        const race = data.MRData.RaceTable.Races[0];
        if (!race?.Results) continue;

        for (const r of race.Results) {
          await prisma.f1RaceResult.upsert({
            where: { season_round_driverCode: { season, round, driverCode: r.Driver.driverId } },
            create: {
              season, round, raceName: race.raceName, circuitId: race.Circuit.circuitId, raceDate: new Date(race.date),
              driverCode: r.Driver.driverId, driverAbbr: r.Driver.code ?? null,
              driverName: `${r.Driver.givenName} ${r.Driver.familyName}`,
              constructorId: r.Constructor.constructorId, constructorName: r.Constructor.name,
              grid: parseInt(r.grid, 10) || null, finishPosition: r.position ? parseInt(r.position, 10) : null,
              points: parseFloat(r.points), status: r.status, laps: parseInt(r.laps, 10) || null,
              fastestLapRank: r.FastestLap ? parseInt(r.FastestLap.rank, 10) : null,
            },
            update: {
              finishPosition: r.position ? parseInt(r.position, 10) : null,
              points: parseFloat(r.points), status: r.status, laps: parseInt(r.laps, 10) || null,
              fastestLapRank: r.FastestLap ? parseInt(r.FastestLap.rank, 10) : null,
            },
          });
          synced++;
        }
      } catch (err) {
        console.warn(`[JolpicaDataService] Failed to sync ${season} round ${round} results:`, (err as Error).message);
      }
    }
    return synced;
  }

  /**
   * Pulls the point-in-time driver standings AS OF every round of a season
   * into F1SeasonStanding -- standings after round N are what's known
   * before round N+1 starts (the "before race" correctness rule from the
   * plan doc). Idempotent upsert.
   */
  async syncSeasonStandings(season: number): Promise<number> {
    const rounds = await this.getRoundCount(season);
    let synced = 0;

    for (let round = 1; round <= rounds; round++) {
      try {
        const data = await jolpicaFetch<{ MRData: { StandingsTable: { StandingsLists: Array<{ DriverStandings: JolpicaDriverStanding[] }> } } }>(
          `/${season}/${round}/driverStandings.json?limit=30`,
        );
        const standings = data.MRData.StandingsTable.StandingsLists[0]?.DriverStandings ?? [];

        for (const s of standings) {
          await prisma.f1SeasonStanding.upsert({
            where: { season_round_driverCode: { season, round, driverCode: s.Driver.driverId } },
            create: {
              season, round, driverCode: s.Driver.driverId, driverAbbr: s.Driver.code ?? null,
              driverName: `${s.Driver.givenName} ${s.Driver.familyName}`,
              constructorId: s.Constructors[0]?.constructorId ?? 'unknown',
              position: parseInt(s.position, 10), points: parseFloat(s.points), wins: parseInt(s.wins, 10),
            },
            update: {
              position: parseInt(s.position, 10), points: parseFloat(s.points), wins: parseInt(s.wins, 10),
            },
          });
          synced++;
        }
      } catch (err) {
        console.warn(`[JolpicaDataService] Failed to sync ${season} round ${round} standings:`, (err as Error).message);
      }
    }
    return synced;
  }

  async syncSeason(season: number): Promise<{ results: number; standings: number }> {
    const results = await this.syncSeasonResults(season);
    const standings = await this.syncSeasonStandings(season);
    return { results, standings };
  }

  /**
   * Recency-weighted recent-form features for one driver, computed from
   * whatever F1RaceResult rows are already stored (docs/league/F1_PREDICTION_ENGINE_PLAN.md
   * §4 "driver_recent_form_score" -- weights: most recent 35%, -1 25%,
   * -2 18%, -3 13%, -4 9%). Pass `throughSeason`/`throughRound` to get the
   * form known as of a specific point in time (avoids leaking future races
   * into a "before race" feature); omit both for the most recent form
   * available.
   */
  async getDriverForm(driverCode: string, opts: { throughSeason?: number; throughRound?: number } = {}) {
    const races = await prisma.f1RaceResult.findMany({
      where: {
        driverCode,
        ...(opts.throughSeason
          ? { OR: [{ season: { lt: opts.throughSeason } }, { season: opts.throughSeason, round: { lte: opts.throughRound ?? 999 } }] }
          : {}),
      },
      orderBy: [{ season: 'desc' }, { round: 'desc' }],
      take: 5,
    });
    if (races.length === 0) return null;

    const weights = [0.35, 0.25, 0.18, 0.13, 0.09];
    let weightedFinish = 0;
    let weightSum = 0;
    let dnfCount = 0;
    let pointsSum = 0;

    races.forEach((r, i) => {
      const w = weights[i] ?? 0;
      if (r.finishPosition != null) {
        weightedFinish += r.finishPosition * w;
        weightSum += w;
      }
      if (!/^finished|\+\d+ lap/i.test(r.status)) dnfCount++;
      pointsSum += r.points;
    });

    return {
      racesConsidered: races.length,
      recentFormScore: weightSum > 0 ? weightedFinish / weightSum : null,
      last5PointsTotal: pointsSum,
      last5DnfRate: dnfCount / races.length,
    };
  }
}

export const jolpicaDataService = new JolpicaDataService();
