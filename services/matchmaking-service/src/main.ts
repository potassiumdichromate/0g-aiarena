import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import { matchmakingRoutes } from './routes/matchmaking.routes';
import { startAutonomousLoop } from './services/autonomous-loop';
import { startQueueFallbackLoop } from './services/queue-fallback-loop';
import { Matchmaker } from './services/matchmaker';

const PORT = parseInt(process.env.PORT ?? '8020', 10);

/** Run cleanup every 2 minutes — cancels battles stuck > 10 min in non-terminal status. */
function startCleanupLoop(): void {
  const mm = new Matchmaker();
  const INTERVAL_MS = 2 * 60 * 1_000; // 2 minutes

  // Run once at startup to clear anything that survived a restart
  mm.cleanupStaleBattles().catch((err) =>
    console.warn('[Cleanup] Startup cleanup error:', err)
  );

  setInterval(() => {
    mm.cleanupStaleBattles().catch((err) =>
      console.warn('[Cleanup] Interval cleanup error:', err)
    );
  }, INTERVAL_MS);
}

async function bootstrap(): Promise<void> {
  const app = Fastify({ logger: true });
  await app.register(cors, { origin: true });
  await app.register(helmet);
  await app.register(jwt, { secret: process.env.JWT_SECRET ?? 'dev-secret' });

  app.get('/health', async () => ({ status: 'ok', service: 'matchmaking-service' }));
  await app.register(matchmakingRoutes, { prefix: '/queue' });

  await app.listen({ port: PORT, host: '0.0.0.0' });
  app.log.info(`Matchmaking service running on port ${PORT}`);

  // Start the background autonomous agent loop
  startAutonomousLoop();

  // Start the queue fallback loop (30s wait -> match with an idle autonomous agent)
  startQueueFallbackLoop();

  // Start the stale-battle cleanup loop (10-minute TTL)
  startCleanupLoop();
}

bootstrap().catch(err => { console.error(err); process.exit(1); });
