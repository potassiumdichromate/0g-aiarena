/**
 * bridge-listener worker
 *
 * Long-running process: starts the BridgeService and keeps it alive.
 * Handles graceful shutdown (SIGINT/SIGTERM) by stopping event listeners.
 *
 * Run as a separate Node.js process:
 *   node dist/workers/bridge-listener.js
 * or in dev:
 *   ts-node src/workers/bridge-listener.ts
 */

import { BridgeService } from '../services/bridge.service';

const bridge = new BridgeService();

console.log('[bridge-listener] Starting DepositQueued listeners...');
bridge.startListening();

// ── Graceful shutdown ────────────────────────────────────────────────────────

async function shutdown(signal: string) {
  console.log(`[bridge-listener] Received ${signal} — stopping listeners...`);
  bridge.stopListening();
  process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Keep the process alive — the ethers.js event listeners are async
process.on('uncaughtException', (err) => {
  console.error('[bridge-listener] Uncaught exception:', err);
  // Don't exit — log and continue. Bridge listener must stay alive.
});

process.on('unhandledRejection', (reason) => {
  console.error('[bridge-listener] Unhandled rejection:', reason);
});

console.log('[bridge-listener] Listening for deposits. Press Ctrl+C to stop.');
