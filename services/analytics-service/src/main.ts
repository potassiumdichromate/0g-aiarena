import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';

const PORT = parseInt(process.env.PORT ?? '8040', 10);
const SERVICE_NAME = 'analytics-service';

async function bootstrap(): Promise<void> {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });
  await app.register(helmet);
  await app.register(jwt, { secret: process.env.JWT_SECRET ?? 'dev-secret' });
  app.get('/health', async () => ({ status: 'ok', service: SERVICE_NAME }));
  await app.listen({ port: PORT, host: '0.0.0.0' });
  app.log.info(`${SERVICE_NAME} running on port ${PORT}`);
}

bootstrap().catch(err => { console.error(err); process.exit(1); });
