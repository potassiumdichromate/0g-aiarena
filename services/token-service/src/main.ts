/**
 * Token Service — Fastify entry point
 *
 * Port: 8050  (add to API gateway upstream list)
 */

import Fastify from 'fastify';
import cors    from '@fastify/cors';
import helmet  from '@fastify/helmet';
import { tokenRoutes } from './routes/token.routes';

const PORT = parseInt(process.env.PORT ?? '8050', 10);
const HOST = process.env.HOST ?? '0.0.0.0';

async function start() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport: process.env.NODE_ENV === 'development'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
    },
    bodyLimit: 1_048_576,
    requestTimeout: 30_000,
    connectionTimeout: 30_000,
  });

  await app.register(cors, {
    origin:      process.env.ALLOWED_ORIGINS?.split(',') ?? ['http://localhost:3000'],
    credentials: true,
  });

  await app.register(helmet, {
    contentSecurityPolicy: false,
    frameguard: { action: 'deny' },
    hsts: process.env.NODE_ENV === 'production'
      ? { maxAge: 31_536_000, includeSubDomains: true }
      : false,
  });

  app.get('/health', async () => ({ ok: true, service: 'token-service', ts: new Date() }));

  await app.register(tokenRoutes, { prefix: '/v1/token' });

  try {
    await app.listen({ port: PORT, host: HOST });
    app.log.info(`token-service listening on ${HOST}:${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  process.on('SIGINT',  async () => { await app.close(); process.exit(0); });
  process.on('SIGTERM', async () => { await app.close(); process.exit(0); });
}

start().catch((err) => { console.error(err); process.exit(1); });
