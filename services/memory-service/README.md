# memory-service

Hybrid memory system for AI agents: working memory (Redis), episodic memory (Postgres + Qdrant), semantic memory (Qdrant RAG).

## Port: 8014

## API Routes

| Method | Path | Description |
|---|---|---|
| GET | /agents/:agentId/memory | List memories |
| POST | /agents/:agentId/memory/working | Update working memory |
| POST | /agents/:agentId/memory/episode | Store battle episode |
| GET | /agents/:agentId/memory/retrieve | RAG retrieval |
| POST | /agents/:agentId/memory/compact | Trigger compaction |
| DELETE | /agents/:agentId/memory/working | Clear working memory |
