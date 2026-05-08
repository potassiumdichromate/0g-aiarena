import { SolanaExecutor, SettlementResult } from './solana-executor';

export interface RetryOptions {
  maxAttempts: number;
  jobId: string;
}

export class RetryHandler {
  constructor(private readonly executor: SolanaExecutor) {}

  async executeWithRetry(
    fn: () => Promise<SettlementResult>,
    options: RetryOptions
  ): Promise<SettlementResult> {
    let lastError: unknown;
    let delayMs = 1000;

    for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
      try {
        const result = await fn();
        if (attempt > 1) {
          console.log(`[settlement-worker] Job ${options.jobId} succeeded on attempt ${attempt}`);
        }
        return result;
      } catch (err) {
        lastError = err;
        console.warn(`[settlement-worker] Job ${options.jobId} attempt ${attempt} failed:`, err);

        if (attempt < options.maxAttempts) {
          await new Promise(r => setTimeout(r, delayMs));
          delayMs *= 2; // Exponential backoff
        }
      }
    }

    throw lastError;
  }
}
