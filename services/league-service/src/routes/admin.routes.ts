import { FastifyInstance } from 'fastify';
import { prisma } from '@ai-arena/db-client';
import { createFootballDataProvider, mapProviderStage } from '@ai-arena/football-data-client';
import { leagueRepo } from '../lib/season';

const provider = createFootballDataProvider();

function isAuthorized(req: { headers: Record<string, unknown> }): boolean {
  return req.headers['x-service-key'] === process.env.INTERNAL_SERVICE_SECRET;
}

/**
 * Ops-only season management. There was previously no way to switch which
 * competition the League feature pulls fixtures from short of hand-editing
 * the DB -- the World Cup `LeagueSeason` row was the only one that ever
 * existed (packages/db-client/scripts/seed-league-season.cjs, a one-off,
 * unparameterized script). Same recurring-need pattern as F1's
 * ACTIVE_GRAND_PRIX_ID: competitions change, so this needs to be an
 * operation, not a one-time seed.
 *
 * Switching creates a NEW season row rather than mutating the old one's
 * providerId -- schedule-sync only ever upserts fixtures matching the
 * current providerId (packages/db-client's LeagueMatch is unique on
 * (seasonId, providerId)), it never deletes stale rows from a prior
 * competition. Deactivating the old season instead of overwriting it means
 * its real match history / settled predictions stay intact and simply stop
 * being the one `getActiveSeason()` returns.
 */
export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // GET /v1/league/admin/seasons — list all seasons, active first.
  app.get('/admin/seasons', async (req, reply) => {
    if (!isAuthorized(req)) return reply.status(401).send({ error: 'Unauthorized' });
    const seasons = await prisma.leagueSeason.findMany({ orderBy: [{ isActive: 'desc' }, { startsAt: 'desc' }] });
    return { seasons };
  });

  // POST /v1/league/admin/seasons — create (or reactivate, if slug exists)
  // a season and make it the sole active one. providerId must be
  // "{api-football leagueId}:{year}" (see football-data-client's
  // parseSeasonExternalId) -- e.g. "39:2026" for Premier League 2026-27.
  app.post('/admin/seasons', async (req, reply) => {
    if (!isAuthorized(req)) return reply.status(401).send({ error: 'Unauthorized' });

    const { slug, name, providerId, startsAt, endsAt } = req.body as {
      slug: string; name: string; providerId: string; startsAt: string; endsAt: string;
    };
    if (!slug || !name || !providerId || !startsAt || !endsAt) {
      return reply.status(400).send({ error: 'slug, name, providerId, startsAt, endsAt are all required' });
    }

    const [, season] = await prisma.$transaction([
      prisma.leagueSeason.updateMany({ where: { isActive: true }, data: { isActive: false } }),
      prisma.leagueSeason.upsert({
        where: { slug },
        create: { slug, name, providerId, startsAt: new Date(startsAt), endsAt: new Date(endsAt), isActive: true },
        update: { name, providerId, startsAt: new Date(startsAt), endsAt: new Date(endsAt), isActive: true },
      }),
    ]);

    return { season };
  });

  // POST /v1/league/admin/schedule-sync — manually pull fixtures for the
  // active season right now, instead of waiting for league-worker's 24h
  // cron (services/league-worker/src/jobs/schedule-sync.ts). Duplicated
  // here (not calling league-worker over HTTP) since league-worker has no
  // routes besides /health and this needs the same provider + repo access
  // league-service already has.
  app.post('/admin/schedule-sync', async (req, reply) => {
    if (!isAuthorized(req)) return reply.status(401).send({ error: 'Unauthorized' });

    const season = await leagueRepo.getActiveSeason();
    if (!season) return reply.status(409).send({ error: 'no active league season' });
    if (!season.providerId) return reply.status(409).send({ error: 'active season has no providerId set' });

    const fixtures = await provider.getSchedule(season.providerId);

    for (const fixture of fixtures) {
      const fields = {
        stage: mapProviderStage(fixture.stage),
        homeTeam: fixture.homeTeam,
        awayTeam: fixture.awayTeam,
        kickoffAt: new Date(fixture.kickoffAt),
        ...(fixture.venue !== undefined && { venue: fixture.venue }),
        ...(fixture.matchday !== undefined && { matchday: fixture.matchday }),
      };
      await leagueRepo.upsertMatch(season.id, fixture.externalId, fields, fields);
    }

    return { season: season.slug, providerId: season.providerId, fixtures: fixtures.length };
  });
}
