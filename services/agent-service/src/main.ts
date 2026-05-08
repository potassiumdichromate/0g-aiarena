import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import { agentRoutes } from './routes/agent.routes';

const PORT = parseInt(process.env.PORT ?? '8002', 10);

async function bootstrap(): Promise<void> {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: true });
  await app.register(helmet);
  await app.register(jwt, { secret: process.env.JWT_SECRET ?? 'dev-secret' });
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });

  app.get('/health', async () => ({ status: 'ok', service: 'agent-service' }));
  await app.register(agentRoutes, { prefix: '/agents' });

  await app.listen({ port: PORT, host: '0.0.0.0' });
  app.log.info(`Agent service running on port ${PORT}`);
}

bootstrap().catch(err => { console.error(err); process.exit(1); });
