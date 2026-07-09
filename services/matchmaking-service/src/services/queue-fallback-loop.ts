/**
 * QueueFallbackLoop — periodic sweep that checks every currently-queued
 * agent and, once one has waited at least MIN_WAIT_MS (default 30s) with no
 * real opponent found, matches them with an idle agent instead so the game
 * is guaranteed to start -- preferring an autonomous-mode (opted-in) agent,
 * but falling back to any idle agent at all if none are available (see
 * Matchmaker.fillWithAutonomousAgent).
 *
 * Runs on a short interval (default 10s) so the 30-second threshold is
 * caught promptly without scanning constantly. Uses a plain Redis KEYS scan
 * over `queue_entry:*` -- the queue is expected to stay small (bounded by
 * concurrently-waiting agents), so this is cheap relative to the interval.
 */

import { getRedisClient } from '@ai-arena/cache';
import { Matchmaker } from './matchmaker';

const SWEEP_INTERVAL_MS = parseInt(process.env.QUEUE_FALLBACK_INTERVAL_MS ?? '10000', 10);
const MIN_WAIT_MS        = parseInt(process.env.QUEUE_FALLBACK_MIN_WAIT_MS ?? '30000', 10);

const matchmaker = new Matchmaker();

async function sweepQueue(): Promise<void> {
  const redis = getRedisClient().getClient();

  let keys: string[] = [];
  try {
    keys = await redis.keys('queue_entry:*');
  } catch (err) {
    console.warn('[QueueFallbackLoop] Could not scan queue entries:', (err as Error).message);
    return;
  }
  if (keys.length === 0) return;

  for (const key of keys) {
    const agentId = key.slice('queue_entry:'.length);
    try {
      const { matched, opponentId } = await matchmaker.fillWithAutonomousAgent(agentId, MIN_WAIT_MS);
      if (matched) {
        console.info(`[QueueFallbackLoop] Filled queue for ${agentId} with autonomous agent ${opponentId}`);
      }
    } catch (err) {
      console.warn(`[QueueFallbackLoop] Fallback check failed for ${agentId}:`, (err as Error).message);
    }
  }
}

export function startQueueFallbackLoop(): void {
  console.info(
    `[QueueFallbackLoop] Starting -- sweep every ${SWEEP_INTERVAL_MS / 1000}s, ` +
    `fallback to an autonomous agent after ${MIN_WAIT_MS / 1000}s of no match`
  );
  setInterval(() => sweepQueue().catch(console.error), SWEEP_INTERVAL_MS);
}
