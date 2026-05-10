import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import { authRoutes } from './routes/auth.routes';
import { userRoutes } from './routes/user.routes';

const PORT = parseInt(process.env.PORT ?? '8001', 10);

async function bootstrap(): Promise<void> {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: true });
  await app.register(helmet, { global: true });
  await app.register(jwt, {
    secret: process.env.JWT_SECRET ?? 'dev-secret-change-in-prod',
    sign: { expiresIn: '1h' },
  });
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });

  // Expose app.authenticate as a preHandler shortcut for JWT verification
  app.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
    try { await request.jwtVerify(); } catch (err) { reply.send(err); }
  });

  app.get('/health', async () => ({ status: 'ok', service: 'identity-service' }));

  await app.register(authRoutes, { prefix: '/auth' });
  await app.register(userRoutes, { prefix: '/users' });

  await app.listen({ port: PORT, host: '0.0.0.0' });
  app.log.info(`Identity service running on port ${PORT}`);
}

bootstrap().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
