# memory-service

**Port: 8014**

4-tier agent memory system with **0G Storage mainnet** archival and on-chain anchoring.

## Memory Tiers

| Tier | Storage | TTL | Use |
|------|---------|-----|-----|
| 1. Working | Redis | 1h (per battle) | Sub-ms access during battle ticks |
| 2. Episodic | PostgreSQL + Qdrant | Permanent | Battle episode records + RAG vectors |
| 3. Semantic | Qdrant | Permanent | Abstracted patterns, cross-battle learning |
| 4. Procedural | **0G Storage mainnet** | Immutable | Full snapshots, on-chain anchored |

## 0G Storage Integration

| Operation | What happens |
|-----------|-------------|
| `storeEpisode()` | Writes to Postgres + Qdrant, **and** uploads episode JSON to 0G Storage → indexed as `agents/{id}/memory/episodes/{memoryId}` |
| `compactMemory()` | Serialises top-500 memories → uploads to 0G Storage → indexes as `agents/{id}/memory/snapshot-latest` + versioned copy → publishes event for inft-service to call `updateMemoryRoot()` on-chain |
| `getMemorySnapshot()` | Downloads from 0G Storage by rootHash — used for cold-start recovery, fine-tuning prep, anti-cheat audit |

Memory rootHashes are anchored in the INFT via `updateMemoryRoot(tokenId, bytes32)` on 0G Chain,
making every agent's memory cryptographically verifiable and portable across ownership transfers.

## API Routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/agents/:id/memories` | List memories (paginated, filter by `type`) |
| `GET` | `/agents/:id/memories/working` | Current working memory (Redis) |
| `PUT` | `/agents/:id/memories/working` | Update working memory state |
| `DELETE` | `/agents/:id/memories/working` | Clear working memory |
| `POST` | `/agents/:id/memories/episode` | Store battle episode → Postgres + Qdrant + 0G Storage |
| `GET` | `/agents/:id/memories/retrieve` | Semantic RAG retrieval (`?query=...&limit=10`) |
| `POST` | `/agents/:id/memories/compact` | Compact + snapshot → 0G Storage → returns `{ rootHash, archivedCount }` |
| `GET` | `/agents/:id/memories/snapshots` | List all 0G Storage snapshot versions |
| `GET` | `/agents/:id/memories/snapshot` | Download latest snapshot from 0G Storage |
| `GET` | `/agents/:id/memories/snapshot/:rootHash` | Download specific snapshot by rootHash |

## storage_index paths

```
agents/{agentId}/memory/snapshot-latest      ← most recent compact
agents/{agentId}/memory/snapshot-{timestamp} ← versioned history
agents/{agentId}/memory/episodes/{memoryId}  ← individual episode archive
```

## Environment Variables

```bash
ZEROG_NETWORK=mainnet
ZEROG_STORAGE_PRIVATE_KEY=0x...
DATABASE_URL=...
REDIS_URL=...
QDRANT_URL=...
NATS_URL=...
```
