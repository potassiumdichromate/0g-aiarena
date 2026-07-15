import { prisma, F1RaceStatus, Prisma } from '@ai-arena/db-client';
import { NotFoundError, ConflictError } from '../lib/errors';

/**
 * F1 League data source: API-SPORTS Formula-1 API (docs/league/F1_LEAGUE_CONTEXT.md).
 * `teams`/`drivers` are unrestricted by season on the free plan; `races` is
 * capped to seasons 2022-2024 until the API-SPORTS plan is upgraded -- see
 * that doc for the live-verified endpoint shapes this mirrors.
 */
const F1_API_BASE = 'https://v1.formula-1.api-sports.io';
const BELGIUM_GRAND_PRIX_ID = 15;
/** Free-plan season ceiling -- swap to the current season once the plan is upgraded. */
const DEFAULT_SEASON = parseInt(process.env.F1_DEFAULT_SEASON ?? '2024', 10);

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

// Free-plan F1 API rate limit is 10 requests/minute (hit this live during the
// first sync: syncDriversFromRankings makes ~1 call per driver in a season,
// ~24+ calls, with no spacing between them). Every call goes through this
// throttle so the whole service self-paces under the limit, plus a backoff
// retry for the rare case a burst still gets rate-limited.
const MIN_CALL_INTERVAL_MS = 6_500; // ~9.2 req/min, safely under the 10/min cap
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

  async listDrivers() {
    return prisma.f1Driver.findMany({ include: { currentTeam: true }, orderBy: { name: 'asc' } });
  }

  async getDriver(id: string) {
    const driver = await prisma.f1Driver.findUnique({ where: { id }, include: { currentTeam: true } });
    if (!driver) throw new NotFoundError('driver not found');
    return driver;
  }

  async makePick(raceId: string, agentId: string, predictedDriverId: string, reasoning?: string) {
    const [race, driver] = await Promise.all([
      prisma.f1Race.findUnique({ where: { id: raceId } }),
      prisma.f1Driver.findUnique({ where: { id: predictedDriverId } }),
    ]);
    if (!race) throw new NotFoundError('race not found');
    if (!driver) throw new NotFoundError('driver not found');
    if (race.status !== 'SCHEDULED') throw new ConflictError('picks are only open while the race is scheduled');

    return prisma.f1Prediction.upsert({
      where: { raceId_agentId: { raceId, agentId } },
      create: { raceId, agentId, predictedDriverId, reasoning },
      update: { predictedDriverId, reasoning },
    });
  }

  async getPick(raceId: string, agentId: string) {
    return prisma.f1Prediction.findUnique({
      where: { raceId_agentId: { raceId, agentId } },
      include: { predictedDriver: true },
    });
  }
}

export const f1DataService = new F1DataService();
export { BELGIUM_GRAND_PRIX_ID, DEFAULT_SEASON };
