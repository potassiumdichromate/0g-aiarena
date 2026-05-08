# embedding-worker

Python worker that generates BGE-M3 embeddings from telemetry events and upserts them into Qdrant for semantic memory retrieval.

## Port: N/A (NATS subscriber)

## Subscriptions

- `telemetry.processed` — Generate embeddings for processed telemetry

## Setup

```bash
pip install -r requirements.txt
python -m src.main
```
