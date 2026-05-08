# @ai-arena/event-bus

NATS JetStream wrapper for reliable event publishing and subscribing across AI Arena services.

## Usage

```typescript
import { getEventBus, SUBJECTS } from '@ai-arena/event-bus';

const bus = await getEventBus();

// Publish
await bus.publish(SUBJECTS.BATTLE_ENDED, { battleId: '...', result: { ... } });

// Subscribe
bus.subscribe(SUBJECTS.TRAINING_QUEUED, async (data) => {
  console.log('Training job queued:', data.jobId);
});

// Create stream (call once on startup)
await bus.createStream({
  name: 'BATTLES',
  subjects: ['battle.*'],
  maxAge: 86400 * 7, // 7 days in seconds
});
```
