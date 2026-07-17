import { prisma, Prisma } from '@ai-arena/db-client';
import { NotFoundError, ConflictError } from '../lib/errors';
import { f1DataService, DEFAULT_SEASON } from './f1-data.service';

const INFERENCE_SERVICE_URL = process.env.INFERENCE_SERVICE_URL ?? 'http://localhost:8013';
const F1_API_BASE = 'https://v1.formula-1.api-sports.io';

/**
 * Standard F1 points table (top 10 finishers). Used to score fantasy teams
 * from real F1RaceClassification rows -- no invented scoring rules.
 */
const F1_POINTS_TABLE: Record<number, number> = {
  1: 25, 2: 18, 3: 15, 4: 12, 5: 10, 6: 8, 7: 6, 8: 4, 9: 2, 10: 1,
};
const FASTEST_LAP_BONUS = 1; // only awarded to a top-10 finisher, per real F1 rules

interface ProviderRaceResult {
  driver: { id: number };
  position: number | null;
  status: string;
  time?: { fastest_lap?: { rank?: number | null } | null } | null;
}

class F1FantasyService {
  /**
   * "AI drafts my team" -- the model picks one driver + their constructor
   * from the real current grid for the season, grounded in live standings.
   * One team per agent per season (re-drafting overwrites the previous pick).
   */
  async draftTeam(agentId: string, season: number = DEFAULT_SEASON) {
    const drivers = await f1DataService.listDrivers(season);
    if (drivers.length === 0) throw new ConflictError('no drivers synced yet -- run POST /v1/f1/sync first');

    const res = await fetch(`${INFERENCE_SERVICE_URL}/f1-fantasy-draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Service-Key': process.env.INTERNAL_SERVICE_SECRET ?? '' },
      body: JSON.stringify({
        agentId,
        season,
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
      throw new Error(`inference-service f1-fantasy-draft failed: ${text}`);
    }
    const { driverId, teamName, reasoning } = (await res.json()) as {
      driverId: string; teamName: string; reasoning: string;
    };

    const driver = await prisma.f1Driver.findUnique({ where: { id: driverId } });
    if (!driver) throw new Error('AI draft returned an invalid driver id');
    if (!driver.currentTeamId) throw new ConflictError(`${driver.name} has no current team synced -- cannot draft a constructor`);

    return prisma.f1FantasyTeam.upsert({
      where: { agentId_season: { agentId, season } },
      create: { agentId, season, name: teamName, driverId, constructorId: driver.currentTeamId, reasoning },
      update: { name: teamName, driverId, constructorId: driver.currentTeamId, reasoning },
      include: { driver: true, constructor: true },
    });
  }

  async getTeam(agentId: string, season: number = DEFAULT_SEASON) {
    return prisma.f1FantasyTeam.findUnique({
      where: { agentId_season: { agentId, season } },
      include: { driver: true, constructor: true },
    });
  }

  /** Real per-driver classification for one completed race, pulled from the provider. */
  async syncRaceClassification(raceId: string) {
    const race = await prisma.f1Race.findUnique({ where: { id: raceId } });
    if (!race) throw new NotFoundError('race not found');
    if (race.status !== 'COMPLETED') throw new ConflictError('classification is only available once the race is COMPLETED');

    const apiKey = process.env.F1_API_KEY;
    if (!apiKey) throw new Error('F1_API_KEY not configured');

    const res = await fetch(`${F1_API_BASE}/rankings/races?race=${race.providerId}`, {
      headers: { 'x-apisports-key': apiKey },
    });
    if (!res.ok) throw new Error(`F1 API rankings/races returned ${res.status}`);
    const data = (await res.json()) as { response: ProviderRaceResult[] };

    const rows = data.response ?? [];
    let synced = 0;
    for (const r of rows) {
      const driver = await prisma.f1Driver.findUnique({ where: { providerId: r.driver.id } });
      if (!driver) continue;

      const position = r.position ?? null;
      const points = position ? (F1_POINTS_TABLE[position] ?? 0) : 0;
      const fastestLap = r.time?.fastest_lap?.rank === 1;

      await prisma.f1RaceClassification.upsert({
        where: { raceId_driverId: { raceId, driverId: driver.id } },
        create: { raceId, driverId: driver.id, position, points, fastestLap, status: r.status },
        update: { position, points, fastestLap, status: r.status },
      });
      synced++;
    }
    return { synced };
  }

  /**
   * Applies one completed race's real classification to every fantasy team
   * for that race's season. Idempotent per (team, race) via the
   * F1FantasyScore unique constraint -- safe to re-run.
   */
  async scoreRace(raceId: string) {
    const race = await prisma.f1Race.findUnique({ where: { id: raceId } });
    if (!race) throw new NotFoundError('race not found');
    if (race.status !== 'COMPLETED') throw new ConflictError('cannot score a race that is not COMPLETED');

    const classifications = await prisma.f1RaceClassification.findMany({ where: { raceId } });
    if (classifications.length === 0) {
      throw new ConflictError('no classification synced for this race -- run POST /v1/f1/fantasy/races/:raceId/sync-classification first');
    }
    const byDriverId = new Map(classifications.map((c) => [c.driverId, c]));

    const teams = await prisma.f1FantasyTeam.findMany({ where: { season: race.season } });
    let scored = 0;
    for (const team of teams) {
      const already = await prisma.f1FantasyScore.findUnique({ where: { teamId_raceId: { teamId: team.id, raceId } } });
      if (already) continue;

      const c = byDriverId.get(team.driverId);
      const driverPoints = c?.points ?? 0;
      const fastestLapBonus = c?.fastestLap ? FASTEST_LAP_BONUS : 0;
      const pointsEarned = driverPoints + fastestLapBonus;

      await prisma.$transaction([
        prisma.f1FantasyScore.create({
          data: {
            teamId: team.id,
            raceId,
            pointsEarned,
            breakdown: {
              driverFinishPosition: c?.position ?? null,
              driverPoints,
              fastestLapBonus,
            } as Prisma.InputJsonValue,
          },
        }),
        prisma.f1FantasyTeam.update({
          where: { id: team.id },
          data: { totalPoints: { increment: pointsEarned } },
        }),
      ]);
      scored++;
    }
    return { scored };
  }

  /** Fantasy leaderboard for a season -- highest totalPoints first. */
  async getLeaderboard(season: number = DEFAULT_SEASON, limit = 50) {
    return prisma.f1FantasyTeam.findMany({
      where: { season },
      orderBy: { totalPoints: 'desc' },
      take: limit,
      include: { driver: true, constructor: true },
    });
  }
}

export const f1FantasyService = new F1FantasyService();
