import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import { trainingRoutes } from './routes/training.routes';

const PORT = parseInt(process.env.PORT ?? '8012', 10);

async function bootstrap(): Promise<void> {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });
  await app.register(helmet);
  await app.register(jwt, { secret: process.env.JWT_SECRET ?? 'dev-secret' });
  app.get('/health', async () => ({ status: 'ok', service: 'training-service' }));
  await app.register(trainingRoutes, { prefix: '/jobs' });
  await app.listen({ port: PORT, host: '0.0.0.0' });
  app.log.info(`Training service running on port ${PORT}`);
}

bootstrap().catch(err => { console.error(err); process.exit(1); });
