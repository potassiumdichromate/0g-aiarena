/**
 * a2a-marketplace-service — job meaning for the A2A agent marketplace.
 *
 * Owns prompts, parsing, requirement documents and (from Phase 5) negotiation.
 * Holds NO chain key: every on-chain action is delegated to base-chain-service,
 * which holds the only Base signer.
 *
 * Reads are open — an external agent must be able to discover jobs and fetch
 * the canonical requirements document without KULT credentials. Writes are
 * JWT-authenticated at the gateway and service-key guarded here.
 */

import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import { jobRoutes } from './routes/job.routes';
import { negotiationRoutes } from './routes/negotiation.routes';
import { executionRoutes } from './routes/execution.routes';
import { identityRoutes } from './routes/identity.routes';
import { pollExecution } from './execution.service';

const PORT = parseInt(process.env.PORT ?? '8080', 10);
const SERVICE_NAME = 'a2a-marketplace-service';

async function bootstrap(): Promise<void> {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: true });
  await app.register(helmet);
  // Writes act AS an agent, so they need a session to prove who is asking.
  await app.register(jwt, { secret: process.env.JWT_SECRET ?? 'dev-secret' });

  app.get('/health', async () => ({
    status: 'ok',
    service: SERVICE_NAME,
    baseChainService: process.env.BASE_CHAIN_SERVICE_URL ?? 'http://localhost:8051',
  }));

  await app.register(jobRoutes, { prefix: '/jobs' });
  await app.register(negotiationRoutes, { prefix: '/negotiations' });
  await app.register(executionRoutes, { prefix: '/execution' });
  await app.register(identityRoutes, { prefix: '/agents' });

  // Advance delivered work on a tick. Without this a job sits at EXECUTING
  // after training finishes and only ever reaches the escrow timeout.
  const POLL_MS = parseInt(process.env.EXECUTION_POLL_INTERVAL_MS ?? '30000', 10);
  setInterval(() => {
    pollExecution().catch((err) => app.log.error({ err }, 'execution poll failed'));
  }, POLL_MS).unref();

  await app.listen({ port: PORT, host: '0.0.0.0' });
  app.log.info(`${SERVICE_NAME} listening on :${PORT}`);
}

bootstrap().catch((err) => {
  console.error(`[${SERVICE_NAME}] Failed to start:`, err);
  process.exit(1);
});
