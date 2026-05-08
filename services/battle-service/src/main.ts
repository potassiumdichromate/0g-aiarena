import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import websocket from '@fastify/websocket';
import { battleRoutes } from './routes/battle.routes';

const PORT = parseInt(process.env.PORT ?? '8021', 10);

async function bootstrap(): Promise<void> {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: true });
  await app.register(helmet);
  await app.register(jwt, { secret: process.env.JWT_SECRET ?? 'dev-secret' });
  await app.register(websocket);

  app.get('/health', async () => ({ status: 'ok', service: 'battle-service' }));
  await app.register(battleRoutes, { prefix: '/battles' });

  await app.listen({ port: PORT, host: '0.0.0.0' });
  app.log.info(`Battle service running on port ${PORT}`);
}

bootstrap().catch(err => { console.error(err); process.exit(1); });
