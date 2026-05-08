# @ai-arena/shared-types

Shared TypeScript type definitions used across all AI Arena services.

## Contents

- `agent.types.ts` — Agent, AgentTraits, AgentMetadata, ClanType, EvolutionStage, CombatArchetype
- `battle.types.ts` — Battle, BattleState, CombatAction, BattleConfig, MatchResult
- `telemetry.types.ts` — TelemetryEvent, TelemetryBatch, event payload types
- `financial.types.ts` — AgentWallet, EscrowRecord, Transaction, SpendingPolicy, X402Challenge
- `memory.types.ts` — MemoryItem, BattleEpisode, WorkingMemoryState, MemoryRetrievalOptions
- `inft.types.ts` — INFTMetadata, EvolutionResult
- `events.types.ts` — NATS event types (BattleEndedEvent, TrainingCompletedEvent, etc.)
- `api.types.ts` — API request/response types

## Usage

```typescript
import { Agent, Battle, TelemetryEvent } from '@ai-arena/shared-types';
```
