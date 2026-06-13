import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import { leagueRoutes } from './routes/league.routes';
import { leagueErrorHandler } from './lib/error-handler';

const PORT = parseInt(process.env.PORT ?? '8060', 10);

async function bootstrap(): Promise<void> {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: true });
  await app.register(helmet);
  await app.register(jwt, { secret: process.env.JWT_SECRET ?? 'dev-secret' });
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });

  app.setErrorHandler(leagueErrorHandler);

  app.get('/health', async () => ({ status: 'ok', service: 'league-service' }));
  await app.register(leagueRoutes, { prefix: '/v1/league' });

  await app.listen({ port: PORT, host: '0.0.0.0' });
  app.log.info(`League service running on port ${PORT}`);
}

bootstrap().catch(err => { console.error(err); process.exit(1); });
