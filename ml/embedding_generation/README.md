# Embedding Generation Module

Generates dense vector embeddings for agent behaviour profiles, battle episodes, and memory items using BGE-M3 (BAAI General Embedding, Multi-lingual, Multi-task, Multi-granularity).

## What It Does

1. Takes agent feature vectors, battle episodes, or text descriptions as input
2. Generates 1024-dimensional embeddings using BGE-M3
3. Upserts embeddings into Qdrant for similarity search (RAG retrieval)
4. Stores embedding metadata references in 0G Storage

## Files

| File | Purpose |
|------|---------|
| `generate.py` | `BGEEmbedder` singleton with typed encode methods |
| `batch_embed.py` | Batch JSONL input → Qdrant bulk upsert |

## Embedding Types

| Type | Input | Use Case |
|------|-------|----------|
| `behaviour` | Feature vector as text | Find agents with similar playstyle |
| `episode` | Battle episode JSON | RAG memory retrieval |
| `profile` | Agent traits + history text | Opponent profiling |
| `tactic` | Tactic description | Tactic similarity search |

## Usage

```bash
pip install -r requirements.txt

# Single embedding
python generate.py --type behaviour --agent-id <uuid>

# Batch embed all episodes for an agent
python batch_embed.py \
  --input /agents/<id>/telemetry/processed/ \
  --collection agent_memory \
  --agent-id <uuid>
```
