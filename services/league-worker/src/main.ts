import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import { leagueRepo } from './lib/season';
import { rebuildLeaderboards } from './lib/leaderboard';
import { runPreGen } from './jobs/pregen';
import { runLockSweep } from './jobs/lock-sweep';
import { runSettlementTick } from './jobs/settlement-tick';
import { runScheduleSync } from './jobs/schedule-sync';
import { runWeeklyReset } from './jobs/weekly-reset';

const PORT = parseInt(process.env.PORT ?? '8061', 10);

const ONE_MINUTE = 60_000;
const ONE_HOUR = 60 * ONE_MINUTE;
const ONE_DAY = 24 * ONE_HOUR;

let lastWeeklyResetKey: string | null = null;

function runTick(name: string, fn: () => Promise<void>): () => void {
  return () => {
    fn().catch((err) => console.error(`[league-worker] ${name} failed:`, (err as Error).message));
  };
}

/** §14.3 — fires once, at the start of the first minute of Sunday UTC. */
function weeklyResetTick(): void {
  const now = new Date();
  if (now.getUTCDay() !== 0 || now.getUTCHours() !== 0) return;

  const weekKey = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}`;
  if (weekKey === lastWeeklyResetKey) return;
  lastWeeklyResetKey = weekKey;

  runWeeklyReset().catch((err) => console.error('[league-worker] weekly-reset failed:', (err as Error).message));
}

async function bootstrap(): Promise<void> {
  const app = Fastify({ logger: true });
  await app.register(helmet);

  app.get('/health', async () => ({ status: 'ok', service: 'league-worker' }));

  await app.listen({ port: PORT, host: '0.0.0.0' });
  app.log.info(`League worker running on port ${PORT}`);

  try {
    const season = await leagueRepo.getActiveSeason();
    if (season) await rebuildLeaderboards(season.id);
  } catch (err) {
    console.error('[league-worker] startup leaderboard rebuild failed:', (err as Error).message);
  }

  const lockSweepTick = runTick('lock-sweep', runLockSweep);
  const settlementTick = runTick('settlement-tick', runSettlementTick);
  const preGenTick = runTick('pregen', runPreGen);
  const scheduleSyncTick = runTick('schedule-sync', runScheduleSync);

  // Run once on startup so a restart doesn't wait a full interval.
  lockSweepTick();
  settlementTick();
  preGenTick();
  scheduleSyncTick();
  weeklyResetTick();

  const timers = [
    setInterval(lockSweepTick, ONE_MINUTE),
    setInterval(settlementTick, 2 * ONE_MINUTE),
    setInterval(preGenTick, ONE_HOUR),
    setInterval(scheduleSyncTick, ONE_DAY),
    setInterval(weeklyResetTick, ONE_MINUTE),
  ];

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received — shutting down`);
    for (const timer of timers) clearInterval(timer);
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

process.on('uncaughtException', (err) => {
  console.error('[league-worker] Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[league-worker] Unhandled rejection:', reason);
});

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
