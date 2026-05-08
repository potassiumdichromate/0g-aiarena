import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import websocket from '@fastify/websocket';
import { telemetryRoutes } from './routes/telemetry.routes';

const PORT = parseInt(process.env.PORT ?? '8010', 10);

async function bootstrap(): Promise<void> {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: true });
  await app.register(helmet);
  await app.register(jwt, { secret: process.env.JWT_SECRET ?? 'dev-secret' });
  await app.register(websocket);

  app.get('/health', async () => ({ status: 'ok', service: 'telemetry-service' }));
  await app.register(telemetryRoutes, { prefix: '/sessions' });

  await app.listen({ port: PORT, host: '0.0.0.0' });
  app.log.info(`Telemetry service running on port ${PORT}`);
}

bootstrap().catch(err => { console.error(err); process.exit(1); });
