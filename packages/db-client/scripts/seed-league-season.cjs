/**
 * One-time script to create the KULTAI World Cup 2026 LeagueSeason row.
 * No admin API route exists for season creation yet (see
 * docs/league/LEAGUE_SYSTEM_ARCHITECTURE.md — this was never built), so this
 * runs directly against Prisma. Safe to re-run: no-ops if the season already
 * exists (unique on `slug`).
 *
 * Run from a Render Shell on any DB-connected service (DATABASE_URL must be
 * set in the environment — it already is on aiarena-league, aiarena-agent,
 * etc.), from the packages/db-client directory:
 *
 *   cd packages/db-client && node scripts/seed-league-season.cjs
 *
 * providerId "1:2026" is ApiFootballProvider's composite season identifier
 * (see packages/football-data-client/src/providers/api-football.provider.ts)
 * — league id 1 = "World Cup" (men's, FIFA), season year 2026. Both verified
 * live against the real API-Football account on 2026-07-03 (league search +
 * a real fixtures?league=1&season=2026 call returning actual today's-date
 * results, e.g. a finished match at BC Place, Vancouver).
 */
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const SLUG = 'kultai-world-cup-2026';

async function main() {
  const existing = await prisma.leagueSeason.findUnique({ where: { slug: SLUG } });
  if (existing) {
    console.log(`Season already exists — id=${existing.id} isActive=${existing.isActive} providerId=${existing.providerId}`);
    return;
  }

  const season = await prisma.leagueSeason.create({
    data: {
      slug: SLUG,
      name: 'KULTAI World Cup 2026',
      providerId: '1:2026',
      startsAt: new Date('2026-06-11T00:00:00Z'),
      endsAt: new Date('2026-07-07T23:59:59Z'),
      isActive: true,
      config: {}, // resolveLeagueConfig() fills in defaults at read time — see packages/shared-utils
    },
  });

  console.log(`Created LeagueSeason — id=${season.id} slug=${season.slug} providerId=${season.providerId}`);
  console.log('schedule-sync will pick this up on its next run and start pulling real fixtures for league=1, season=2026.');
}

main()
  .catch((err) => {
    console.error('Failed to seed LeagueSeason:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
