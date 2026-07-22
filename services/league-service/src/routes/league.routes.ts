import { FastifyInstance } from 'fastify';
import { meRoutes } from './me.routes';
import { matchesRoutes } from './matches.routes';
import { predictionsRoutes } from './predictions.routes';
import { battlesRoutes } from './battles.routes';
import { rivalriesRoutes } from './rivalries.routes';
import { leaderboardRoutes } from './leaderboard.routes';
import { momentsRoutes } from './moments.routes';
import { factionRoutes } from './faction.routes';
import { adminRoutes } from './admin.routes';

export async function leagueRoutes(app: FastifyInstance): Promise<void> {
  await app.register(meRoutes);
  await app.register(matchesRoutes);
  await app.register(predictionsRoutes);
  await app.register(battlesRoutes);
  await app.register(rivalriesRoutes);
  await app.register(leaderboardRoutes);
  await app.register(momentsRoutes);
  await app.register(factionRoutes);
  await app.register(adminRoutes);
}
