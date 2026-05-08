import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import { walletRoutes } from './routes/wallet.routes';
import { transactionRoutes } from './routes/transaction.routes';

const PORT = parseInt(process.env.PORT ?? '8003', 10);

async function bootstrap(): Promise<void> {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });
  await app.register(helmet);
  await app.register(jwt, { secret: process.env.JWT_SECRET ?? 'dev-secret' });
  app.get('/health', async () => ({ status: 'ok', service: 'financial-service' }));
  await app.register(walletRoutes, { prefix: '/wallets' });
  await app.register(transactionRoutes, { prefix: '/transactions' });
  await app.listen({ port: PORT, host: '0.0.0.0' });
  app.log.info(`Financial service running on port ${PORT}`);
}

bootstrap().catch(err => { console.error(err); process.exit(1); });
