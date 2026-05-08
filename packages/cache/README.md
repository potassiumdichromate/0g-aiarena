# @ai-arena/cache

Redis client wrapper with typed keys for AI Arena services.

## Features

- Type-safe key templates via `CACHE_KEYS`
- JSON serialisation helpers (`getJson`, `setexJson`)
- Sorted set operations for leaderboards (`zadd`, `zrevrange`, `zrank`)
- Hash operations for session data
- List operations for notifications
- Pub/Sub for real-time events

## Usage

```typescript
import { getRedisClient, CACHE_KEYS, TTL } from '@ai-arena/cache';

const redis = getRedisClient();

// Cache agent profile
await redis.setexJson(CACHE_KEYS.agentProfile(agentId), TTL.AGENT_CACHE, agentData);

// Leaderboard
await redis.zadd(CACHE_KEYS.leaderboard('global'), eloRating, agentId);
const top10 = await redis.zrevrange(CACHE_KEYS.leaderboard('global'), 0, 9);
```
