import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { leaderboardRoutes } from './routes/leaderboard.routes';

const PORT = parseInt(process.env.PORT ?? '8041', 10);

async function bootstrap(): Promise<void> {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });
  await app.register(helmet);
  app.get('/health', async () => ({ status: 'ok', service: 'leaderboard-service' }));
  await app.register(leaderboardRoutes, { prefix: '/leaderboards' });
  await app.listen({ port: PORT, host: '0.0.0.0' });
  app.log.info(`Leaderboard service running on port ${PORT}`);
}

bootstrap().catch(err => { console.error(err); process.exit(1); });
