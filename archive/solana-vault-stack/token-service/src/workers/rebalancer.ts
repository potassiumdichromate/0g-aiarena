/**
 * rebalancer worker
 *
 * Runs on a schedule (default: every 6 hours) to check if the USDC/USDT
 * ratio in the reserve has drifted beyond the ±5% threshold (60/40 target).
 *
 * If drift is detected:
 *   Phase 1  — alerts ops channel via NATS and logs to DB (no auto-swap)
 *   Phase 2  — execute swap via Jupiter Aggregator (TODO)
 *
 * Run standalone:
 *   node dist/workers/rebalancer.js
 * or set REBALANCE_INTERVAL_MS to override the 6h default.
 */

import { TreasuryService } from '../services/treasury.service';

const INTERVAL_MS = parseInt(process.env.REBALANCE_INTERVAL_MS ?? '21600000', 10); // 6h

const treasury = new TreasuryService();

async function tick() {
  console.log('[rebalancer] Checking reserve balance...');
  try {
    await treasury.maybeRebalance();
  } catch (err) {
    console.error('[rebalancer] Error during rebalance check:', err);
  }
}

// Run immediately on startup, then on interval
tick();
const timer = setInterval(tick, INTERVAL_MS);

console.log(`[rebalancer] Running every ${INTERVAL_MS / 3_600_000}h`);

// ── Graceful shutdown ────────────────────────────────────────────────────────

async function shutdown(signal: string) {
  console.log(`[rebalancer] ${signal} received — stopping.`);
  clearInterval(timer);
  process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
  console.error('[rebalancer] Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[rebalancer] Unhandled rejection:', reason);
});
