# @ai-arena/shared-utils

Shared utility functions for all AI Arena services.

## Modules

- `crypto.ts` — SHA256, HMAC, nonce generation, base64 helpers
- `validation.ts` — Zod schemas for all major types, `validateOrThrow`
- `math.ts` — ELO calculation, lerp, mean, variance, percentile, clamp, normalise
- `time.ts` — Date/time helpers, Unix timestamps, duration formatting
- `retry.ts` — `retry()` with exponential backoff, `sleep()`
- `circuit-breaker.ts` — `CircuitBreaker` class (CLOSED/OPEN/HALF_OPEN states)

## Usage

```typescript
import { calculateElo, retry, CircuitBreaker, sha256 } from '@ai-arena/shared-utils';

// ELO calculation
const { newA, changeA } = calculateElo(1200, 1150, 'WIN');

// Retry with backoff
const result = await retry(() => fetchData(), { maxAttempts: 3, initialDelayMs: 200 });

// Circuit breaker
const breaker = new CircuitBreaker({ name: 'zerog-api', failureThreshold: 5, timeout: 30000 });
const data = await breaker.execute(() => callExternalApi());
```
