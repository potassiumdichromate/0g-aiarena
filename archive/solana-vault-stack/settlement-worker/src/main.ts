import { getEventBus, SUBJECTS } from '@ai-arena/event-bus';
import { SolanaExecutor } from './solana-executor';
import { RetryHandler } from './retry-handler';

const executor = new SolanaExecutor();
const retryHandler = new RetryHandler(executor);

async function main(): Promise<void> {
  console.log('[settlement-worker] Starting...');

  const bus = await getEventBus();

  bus.subscribe<{
    escrowId: string;
    battleId: string;
    winnerId: string;
    amounts: Record<string, number>;
    txHash?: string;
  }>(SUBJECTS.ESCROW_SETTLED, async (event) => {
    console.log(`[settlement-worker] Processing settlement for escrow ${event.escrowId}`);

    try {
      const result = await retryHandler.executeWithRetry(
        () => executor.settleEscrow(event.escrowId, event.winnerId, event.amounts),
        { maxAttempts: 3, jobId: event.escrowId }
      );

      console.log(`[settlement-worker] Settlement complete: ${result.txHash}`);
    } catch (err) {
      console.error(`[settlement-worker] Settlement failed for ${event.escrowId}:`, err);
    }
  });

  console.log(`[settlement-worker] Subscribed to ${SUBJECTS.ESCROW_SETTLED}`);

  // Keep process alive
  process.on('SIGTERM', async () => {
    console.log('[settlement-worker] Shutting down...');
    process.exit(0);
  });
}

main().catch(err => {
  console.error('[settlement-worker] Fatal error:', err);
  process.exit(1);
});
