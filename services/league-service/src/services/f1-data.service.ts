import { prisma, F1RaceStatus, F1PredictionMarket, Prisma } from '@ai-arena/db-client';
import { NotFoundError, ConflictError } from '../lib/errors';

/**
 * F1 League data source: API-SPORTS Formula-1 API (docs/league/F1_LEAGUE_CONTEXT.md).
 * Now on the Pro plan (verified live via GET /status: plan "Pro", 7500 req/day)
 * -- full 2026 season data confirmed reachable, including the real Belgium GP
 * (competition id 15) weekend: 1st Practice 2026-07-17T11:30Z = 17:00 IST,
 * Race 2026-07-19T13:00Z.
 */
const F1_API_BASE = 'https://v1.formula-1.api-sports.io';
const BELGIUM_GRAND_PRIX_ID = 15;
const DEFAULT_SEASON = parseInt(process.env.F1_DEFAULT_SEASON ?? '2026', 10);

interface ProviderTeam {
  id: number; name: string; logo: string | null; base: string | null;
  first_team_entry: number | null; world_championships: number | null;
  chassis: string | null; engine: string | null; tyres: string | null;
}

interface ProviderDriver {
  id: number; name: string; abbr: string | null; image: string | null;
  nationality: string | null; country: { code: string | null } | null;
  birthdate: string | null; number: number | null; podiums: number | null;
  career_points: string | null;
  teams: Array<{ season: number; team: { id: number; name: string } }>;
}

interface ProviderRanking {
  position: number;
  driver: { id: number };
  team: { id: number };
  points: number; wins: number; season: number;
}

interface ProviderRace {
  id: number;
  competition: { id: number; name: string; location: { country: string; city: string } };
  circuit: { id: number; name: string; image: string | null } | null;
  season: number;
  type: string;
  laps: { total: number | null };
  distance: string | null;
  timezone: string;
  date: string;
  status: string;
  fastest_lap: { driver: { id: number | null }; time: string | null };
}

// The free plan's 10 req/min limit (hit live during the first sync attempt)
// no longer applies on Pro (7500 req/day, no documented per-minute cap seen
// in testing) -- kept a light throttle anyway since api-sports doesn't
// publish a per-minute number for Pro and a sync still fires ~26+ calls in a
// row (teams, ~22 drivers, races). The backoff-retry below still protects
// against hitting whatever the real limit turns out to be.
const MIN_CALL_INTERVAL_MS = 350; // ~170 req/min
let lastCallAt = 0;

async function throttle(): Promise<void> {
  const wait = lastCallAt + MIN_CALL_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

function isRateLimitError(errors: unknown): boolean {
  return !Array.isArray(errors) && !!errors && typeof errors === 'object' && 'rateLimit' in errors;
}

async function f1Fetch<T>(path: string, attempt = 1): Promise<T[]> {
  const apiKey = process.env.F1_API_KEY;
  if (!apiKey) throw new Error('F1_API_KEY not configured');

  await throttle();

  const res = await fetch(`${F1_API_BASE}${path}`, { headers: { 'x-apisports-key': apiKey } });
  if (!res.ok) throw new Error(`F1 API ${path} returned ${res.status}`);

  const data = (await res.json()) as { errors?: unknown; response: T[] };
  const errors = data.errors;
  const hasErrors = Array.isArray(errors) ? errors.length > 0 : errors && Object.keys(errors).length > 0;
  if (hasErrors) {
    if (isRateLimitError(errors) && attempt < 3) {
      console.warn(`[F1DataService] Rate limited on ${path}, waiting 65s before retry ${attempt + 1}/3`);
      await new Promise((r) => setTimeout(r, 65_000));
      return f1Fetch<T>(path, attempt + 1);
    }
    throw new Error(`F1 API ${path} error: ${JSON.stringify(errors)}`);
  }

  return data.response;
}

function mapRaceStatus(providerStatus: string): F1RaceStatus {
  const s = providerStatus.toLowerCase();
  if (s.includes('cancel')) return 'CANCELLED';
  if (s.includes('complet') || s.includes('finish')) return 'COMPLETED';
  if (s.includes('live') || s.includes('progress')) return 'LIVE';
  return 'SCHEDULED';
}

class F1DataService {
  /**
   * Pulls current team roster + the current-era driver grid (via a season's
   * rankings, which is the only reliable "who's actually racing" signal the
   * unrestricted endpoints give us) + one Grand Prix's full race weekend.
   * Idempotent upsert -- safe to re-run on a schedule.
   */
  async syncAll(season: number = DEFAULT_SEASON, grandPrixId: number = BELGIUM_GRAND_PRIX_ID): Promise<{ teams: number; drivers: number; races: number }> {
    const teams = await this.syncTeams();
    const drivers = await this.syncDriversFromRankings(season);
    const races = await this.syncGrandPrix(grandPrixId, season);
    return { teams, drivers, races };
  }

  async syncTeams(): Promise<number> {
    const providerTeams = await f1Fetch<ProviderTeam>('/teams');
    for (const t of providerTeams) {
      await prisma.f1Team.upsert({
        where: { providerId: t.id },
        create: {
          providerId: t.id, name: t.name, logo: t.logo, base: t.base,
          firstTeamEntry: t.first_team_entry, worldChampionships: t.world_championships,
          chassis: t.chassis, engine: t.engine, tyres: t.tyres,
        },
        update: {
          name: t.name, logo: t.logo, base: t.base,
          firstTeamEntry: t.first_team_entry, worldChampionships: t.world_championships,
          chassis: t.chassis, engine: t.engine, tyres: t.tyres,
        },
      });
    }
    return providerTeams.length;
  }

  /**
   * `drivers` (unrestricted) needs an `id`/`search` param per driver -- no
   * bulk listing. `rankings/drivers?season=` (season-restricted but gives
   * id+name+team for everyone who raced that season) is used to discover
   * WHICH drivers to then fetch full profiles for in one pass.
   */
  async syncDriversFromRankings(season: number): Promise<number> {
    const rankings = await f1Fetch<ProviderRanking>(`/rankings/drivers?season=${season}`);
    let synced = 0;
    for (const r of rankings) {
      try {
        const [driver] = await f1Fetch<ProviderDriver>(`/drivers?id=${r.driver.id}`);
        if (!driver) continue;

        const team = await prisma.f1Team.findUnique({ where: { providerId: r.team.id } });

        await prisma.f1Driver.upsert({
          where: { providerId: driver.id },
          create: {
            providerId: driver.id, name: driver.name, abbr: driver.abbr, image: driver.image,
            nationality: driver.nationality, countryCode: driver.country?.code ?? null,
            birthdate: driver.birthdate ? new Date(driver.birthdate) : null,
            number: driver.number, podiums: driver.podiums, careerPoints: driver.career_points,
            currentTeamId: team?.id, teamHistory: driver.teams as unknown as Prisma.InputJsonValue,
          },
          update: {
            name: driver.name, abbr: driver.abbr, image: driver.image,
            nationality: driver.nationality, countryCode: driver.country?.code ?? null,
            birthdate: driver.birthdate ? new Date(driver.birthdate) : null,
            number: driver.number, podiums: driver.podiums, careerPoints: driver.career_points,
            currentTeamId: team?.id, teamHistory: driver.teams as unknown as Prisma.InputJsonValue,
          },
        });
        synced++;
      } catch (err) {
        console.warn(`[F1DataService] Failed to sync driver ${r.driver.id}:`, (err as Error).message);
      }
    }
    return synced;
  }

  async syncGrandPrix(grandPrixId: number, season: number): Promise<number> {
    const races = await f1Fetch<ProviderRace>(`/races?season=${season}&competition=${grandPrixId}`);
    for (const r of races) {
      await prisma.f1Race.upsert({
        where: { providerId: r.id },
        create: {
          providerId: r.id, grandPrixId: r.competition.id, grandPrixName: r.competition.name,
          circuitName: r.circuit?.name, circuitImage: r.circuit?.image,
          season: r.season, sessionType: r.type, status: mapRaceStatus(r.status),
          startsAt: new Date(r.date), laps: r.laps.total, distance: r.distance,
          result: r.status.toLowerCase().includes('complet') ? (r as unknown as Prisma.InputJsonValue) : undefined,
        },
        update: {
          circuitName: r.circuit?.name, circuitImage: r.circuit?.image,
          status: mapRaceStatus(r.status), startsAt: new Date(r.date),
          laps: r.laps.total, distance: r.distance,
          result: r.status.toLowerCase().includes('complet') ? (r as unknown as Prisma.InputJsonValue) : undefined,
        },
      });
    }
    return races.length;
  }

  async getGrandPrixWeekend(grandPrixId: number, season: number = DEFAULT_SEASON) {
    const sessions = await prisma.f1Race.findMany({
      where: { grandPrixId, season },
      orderBy: { startsAt: 'asc' },
    });
    if (sessions.length === 0) return null;

    const race = sessions.find((s) => s.sessionType === 'Race') ?? sessions[0];
    return { race, sessions };
  }

  async listTeams() {
    return prisma.f1Team.findMany({ orderBy: { name: 'asc' } });
  }

  /**
   * Driver grid, enriched with each driver's live current-season standing
   * (position/points/wins) -- the frontend shows real current form on every
   * card without a separate call per driver.
   */
  async listDrivers(season: number = DEFAULT_SEASON) {
    const [drivers, rankings] = await Promise.all([
      prisma.f1Driver.findMany({ include: { currentTeam: true }, orderBy: { name: 'asc' } }),
      this.getRankings(season).catch(() => new Map<number, ProviderRanking>()),
    ]);
    return drivers.map((d) => {
      const r = rankings.get(d.providerId);
      return { ...d, standing: r ? { position: r.position, points: r.points, wins: r.wins, season: r.season } : null };
    });
  }

  async getDriver(id: string) {
    const driver = await prisma.f1Driver.findUnique({ where: { id }, include: { currentTeam: true } });
    if (!driver) throw new NotFoundError('driver not found');
    return driver;
  }

  private rankingsCache: { season: number; fetchedAt: number; rows: ProviderRanking[] } | null = null;

  /** Cached (5 min) current-season rankings, keyed by provider driver id. */
  private async getRankings(season: number): Promise<Map<number, ProviderRanking>> {
    const cacheAgeMs = this.rankingsCache ? Date.now() - this.rankingsCache.fetchedAt : Infinity;
    if (!this.rankingsCache || this.rankingsCache.season !== season || cacheAgeMs > 5 * 60_000) {
      const rows = await f1Fetch<ProviderRanking>(`/rankings/drivers?season=${season}`);
      this.rankingsCache = { season, fetchedAt: Date.now(), rows };
    }
    return new Map(this.rankingsCache.rows.map((r) => [r.driver.id, r]));
  }

  /**
   * Current-season standing for one driver (position/points/wins) --
   * grounds the AI Prediction button in real, current form, not just career
   * totals.
   */
  async getCurrentStanding(providerId: number, season: number = DEFAULT_SEASON): Promise<{ position: number; points: number; wins: number; season: number } | null> {
    const rankings = await this.getRankings(season);
    const row = rankings.get(providerId);
    if (!row) return null;
    return { position: row.position, points: row.points, wins: row.wins, season: row.season };
  }

  async makePick(raceId: string, agentId: string, predictedDriverId: string, market: F1PredictionMarket = 'WINNER', reasoning?: string) {
    const [race, driver] = await Promise.all([
      prisma.f1Race.findUnique({ where: { id: raceId } }),
      prisma.f1Driver.findUnique({ where: { id: predictedDriverId } }),
    ]);
    if (!race) throw new NotFoundError('race not found');
    if (!driver) throw new NotFoundError('driver not found');
    if (race.status !== 'SCHEDULED') throw new ConflictError('picks are only open while the race is scheduled');

    return prisma.f1Prediction.upsert({
      where: { raceId_agentId_market: { raceId, agentId, market } },
      create: { raceId, agentId, market, predictedDriverId, reasoning },
      update: { predictedDriverId, reasoning },
    });
  }

  /** All of an agent's picks for a race, one per market (Winner/Podium/Fastest Lap). */
  async getPicks(raceId: string, agentId: string) {
    return prisma.f1Prediction.findMany({
      where: { raceId, agentId },
      include: { predictedDriver: true },
    });
  }

  /**
   * "Let AI Predict" -- asks the model to name a driver for a market, then
   * saves that as the agent's pick. Grounds the model in the real current
   * grid + live standings so it can only ever pick a driver actually racing.
   */
  async predictPick(raceId: string, agentId: string, market: F1PredictionMarket, season: number = DEFAULT_SEASON) {
    const race = await prisma.f1Race.findUnique({ where: { id: raceId } });
    if (!race) throw new NotFoundError('race not found');
    if (race.status !== 'SCHEDULED') throw new ConflictError('picks are only open while the race is scheduled');

    const drivers = await this.listDrivers(season);
    if (drivers.length === 0) throw new ConflictError('no drivers synced yet -- run POST /v1/f1/sync first');

    const inferenceServiceUrl = process.env.INFERENCE_SERVICE_URL ?? 'http://localhost:8013';
    const res = await fetch(`${inferenceServiceUrl}/f1-race-pick`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Service-Key': process.env.INTERNAL_SERVICE_SECRET ?? '' },
      body: JSON.stringify({
        agentId,
        raceId,
        market,
        grandPrixName: race.grandPrixName,
        circuitName: race.circuitName,
        drivers: drivers.map((d) => ({
          id: d.id,
          name: d.name,
          abbr: d.abbr,
          teamName: d.currentTeam?.name ?? null,
          standing: d.standing,
        })),
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`inference-service f1-race-pick failed: ${text}`);
    }
    const { predictedDriverId, reasoning, source } = (await res.json()) as {
      predictedDriverId: string; reasoning: string; source: 'AI' | 'FALLBACK';
    };

    const pick = await this.makePick(raceId, agentId, predictedDriverId, market, reasoning);
    return { pick, source };
  }

  /**
   * The other half of the pick flow that was never built: comparing a saved
   * F1Prediction against what actually happened. Requires
   * F1RaceClassification to already be synced for this race (real per-driver
   * results -- see f1-fantasy.service.ts syncRaceClassification, same
   * source fantasy-team scoring uses). Per market:
   *   WINNER      -- correct if the picked driver finished P1.
   *   PODIUM      -- correct if the picked driver finished P1-P3.
   *   FASTEST_LAP -- correct if the picked driver set the fastest lap.
   * Idempotent: only touches predictions that haven't been settled yet, so
   * re-running (e.g. after a late classification correction) is safe.
   */
  async settlePredictions(raceId: string): Promise<{ settled: number; correct: number }> {
    const race = await prisma.f1Race.findUnique({ where: { id: raceId } });
    if (!race) throw new NotFoundError('race not found');
    if (race.status !== 'COMPLETED') throw new ConflictError('cannot settle predictions for a race that is not COMPLETED');

    const [classifications, predictions] = await Promise.all([
      prisma.f1RaceClassification.findMany({ where: { raceId } }),
      prisma.f1Prediction.findMany({ where: { raceId, settledAt: null } }),
    ]);
    if (classifications.length === 0) {
      throw new ConflictError('no classification synced for this race -- run POST /v1/f1/fantasy/races/:raceId/sync-classification first');
    }
    const byDriverId = new Map(classifications.map((c) => [c.driverId, c]));

    let correct = 0;
    for (const prediction of predictions) {
      const c = byDriverId.get(prediction.predictedDriverId);
      const isCorrect =
        prediction.market === 'WINNER' ? c?.position === 1 :
        prediction.market === 'PODIUM' ? (c?.position ?? 99) <= 3 :
        prediction.market === 'FASTEST_LAP' ? c?.fastestLap === true :
        false;
      if (isCorrect) correct++;

      await prisma.f1Prediction.update({
        where: { id: prediction.id },
        data: { isCorrect, settledAt: new Date() },
      });
    }

    return { settled: predictions.length, correct };
  }
}

export const f1DataService = new F1DataService();
export { BELGIUM_GRAND_PRIX_ID, DEFAULT_SEASON };
