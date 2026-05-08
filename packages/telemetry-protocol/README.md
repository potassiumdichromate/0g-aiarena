# @ai-arena/telemetry-protocol

Shared telemetry event protocol used by the Unity SDK client and the telemetry-service backend.

## Events

- `COMBAT_ACTION` — Player/agent performed an action
- `POSITION_UPDATE` — Agent position changed
- `HEALTH_CHANGE` — HP changed (damage received or healing)
- `ABILITY_USE` — Ability or skill activated
- `KILL` / `DEATH` — Kill/death events
- `ROUND_START` / `ROUND_END` — Round lifecycle

## Usage

```typescript
import { buildBatch, validateBatch, serialize } from '@ai-arena/telemetry-protocol';

const batch = buildBatch({ sessionId, agentId, events });
const { valid, errors } = validateBatch(batch);
const bytes = serialize(batch);
```
