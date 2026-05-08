# behaviour-worker

Python worker that consumes telemetry batches from NATS and extracts behavioural features, computes agent traits, and classifies combat archetypes.

## Port: N/A (NATS subscriber)

## Pipeline

1. Subscribe to `telemetry.batch.received`
2. Extract features (actions per second, KD ratio, position entropy, etc.)
3. Calculate trait scores (aggression, patience, adaptability, etc.)
4. Classify combat archetype (BERSERKER, TACTICIAN, etc.)
5. Publish to `telemetry.processed`

## Setup

```bash
pip install -r requirements.txt
python -m src.main
```
