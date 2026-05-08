# Anomaly Detection Module

Detects cheating, scripted bots, and economic exploits in AI agent behaviour using Isolation Forest and statistical z-score analysis.

## What It Does

1. Consumes agent transaction and gameplay events
2. Scores each event against a trained IsolationForest model
3. Applies z-score checks for known cheat signatures:
   - Superhuman APS (actions per second > 20)
   - Inhuman reaction latency (< 50ms consistently)
   - Scripted-bot pattern detection (repeated identical action sequences)
4. Returns a composite anomaly score (0.0–1.0)
5. Triggers wallet freeze when score > 0.9

## Files

| File | Purpose |
|------|---------|
| `scorer.py` | `AnomalyScorer` — IsolationForest + z-score detection |
| `train_detector.py` | Train detector on historical clean data, pickle persist |

## Anomaly Score Thresholds

| Score | Action |
|-------|--------|
| 0.0 – 0.5 | Normal — no action |
| 0.5 – 0.7 | Warning — flag for review |
| 0.7 – 0.9 | High risk — restrict large wagers |
| 0.9 – 1.0 | Critical — auto-freeze wallet, alert admin |

## Usage

```bash
pip install -r requirements.txt

# Train on clean baseline data
python train_detector.py --data-path ./baseline_events.jsonl

# Score a single agent's recent events
python scorer.py --agent-id <uuid> --events-json ./recent_events.json
```
