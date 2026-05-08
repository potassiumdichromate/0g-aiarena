# @ai-arena/vector-db

Qdrant vector database client wrapper for AI Arena semantic memory and RAG retrieval.

## Collections

| Collection | Vector Size | Distance | Used For |
|---|---|---|---|
| agent_memories | 1024 | Cosine | Agent episodic memory retrieval |
| battle_episodes | 1024 | Cosine | Battle episode similarity search |
| behaviour_profiles | 512 | Cosine | Agent behaviour clustering |
| agent_embeddings | 1024 | Cosine | Agent-to-agent similarity |

## Usage

```typescript
import { getQdrantClient, COLLECTIONS } from '@ai-arena/vector-db';

const qdrant = getQdrantClient();

// Upsert a memory
await qdrant.upsertVector(COLLECTIONS.AGENT_MEMORIES, {
  id: 'memory-uuid',
  vector: embedding,  // 1024-dim float array
  payload: { agentId, type: 'EPISODIC', content: '...' },
});

// Search for similar memories
const results = await qdrant.search(
  COLLECTIONS.AGENT_MEMORIES,
  queryEmbedding,
  { must: [{ key: 'agentId', match: { value: agentId } }] },
  5
);
```
