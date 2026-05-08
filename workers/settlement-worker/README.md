# settlement-worker

TypeScript NATS subscriber that executes Solana settlement transactions when escrows are resolved.

## Subscriptions

- `escrow.settled` → Execute Solana settle instruction with retry

## Setup

```bash
pnpm install
pnpm dev
```
