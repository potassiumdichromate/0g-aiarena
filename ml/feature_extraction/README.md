# Feature Extraction Module

Converts raw gameplay telemetry events into structured behavioural feature vectors used for embedding generation, behaviour analysis, and training data preparation.

## What It Does

1. Consumes raw telemetry session files (JSON/Parquet from 0G Storage)
2. Computes 11+ behavioural features per session (APS, KD, aggression index, reaction latency, etc.)
3. Outputs feature vectors stored in Qdrant and 0G Storage
4. Feeds downstream embedding-worker and training-worker

## Files

| File | Purpose |
|------|---------|
| `extractor.py` | `BattleFeatureExtractor` — computes all feature dimensions |
| `pipeline.py` | End-to-end file→feature vector pipeline |

## Feature Dimensions

| Feature | Description |
|---------|-------------|
| `actions_per_second` | Combat engagement rate |
| `kill_death_ratio` | Raw KD |
| `ability_usage_rate` | Ability activation frequency |
| `avg_reaction_latency_ms` | Time from enemy appearance to action |
| `action_entropy` | Diversity of action types (unpredictability) |
| `total_damage_dealt` | Normalised match damage |
| `movement_entropy` | Spatial position entropy (map coverage) |
| `aggression_index` | Push events / retreat events ratio |
| `headshot_rate` | Precision indicator |
| `economy_efficiency` | Resource-to-damage ratio |
| `burst_frequency` | High-action density windows per minute |

## Usage

```bash
pip install -r requirements.txt

python pipeline.py \
  --session-path /agents/<id>/telemetry/raw/<session_id>.parquet \
  --output-path /agents/<id>/telemetry/features/<session_id>.npy
```
