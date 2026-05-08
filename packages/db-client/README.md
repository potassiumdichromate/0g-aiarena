# @ai-arena/db-client

Prisma ORM client and repository classes for the AI Arena PostgreSQL database.

## Setup

```bash
pnpm generate     # Generate Prisma client from schema
pnpm migrate:dev  # Create and apply migrations (development)
pnpm migrate      # Apply existing migrations (production)
pnpm studio       # Open Prisma Studio
```

## Schema Overview

| Table | Description |
|---|---|
| users | Player accounts, linked wallet addresses |
| agents | AI agent profiles, ELO ratings, traits |
| ai_models | LoRA model versions per agent |
| battles | Battle records, configs, results |
| tournaments | Tournament brackets and state |
| agent_wallets | Solana wallet addresses + balances |
| training_jobs | Training job queue and status |
| agent_memories | Agent memory items (working/episodic/semantic) |
| intelligence_layers | Game-specific AI configs |
| escrow_records | Solana escrow state mirror |
| ledger_entries | Financial transaction ledger |
| staking_records | $ARENA staking history |
| leaderboard_entries | Ranked leaderboard positions |

## Usage

```typescript
import { prisma, AgentRepository } from '@ai-arena/db-client';

const agentRepo = new AgentRepository(prisma);
const agent = await agentRepo.findById('agent-uuid');
```
