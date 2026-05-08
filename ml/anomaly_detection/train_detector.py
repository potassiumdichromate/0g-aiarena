"""
Train and persist the anomaly detection model from historical feature data.
"""
from __future__ import annotations

import argparse
import json
import os
import pickle
from typing import Dict, List, Tuple

import numpy as np

from scorer import BehaviourAnomalyScorer, FEATURE_NAMES

MODEL_PATH = os.environ.get("ANOMALY_MODEL_PATH", "anomaly_model.pkl")


def load_features_from_jsonl(path: str) -> Tuple[np.ndarray, List[str]]:
    """Load feature vectors from JSONL where each line is {agent_id, features: [...]}."""
    agent_ids = []
    vectors = []
    with open(path) as f:
        for line in f:
            rec = json.loads(line.strip())
            agent_ids.append(rec.get("agent_id", "unknown"))
            vectors.append(rec.get("features", [0.0] * len(FEATURE_NAMES)))
    return np.array(vectors, dtype=np.float32), agent_ids


def generate_synthetic_features(n: int = 5000, seed: int = 42) -> Tuple[np.ndarray, List[str]]:
    """Generate synthetic feature matrix for testing."""
    rng = np.random.default_rng(seed)
    # Normal behaviour distribution
    normal = rng.normal(
        loc=[2.0, 1.0, 0.5, 200, 1.5, 30, 3000, 2.0, 2.0, 300, 500],
        scale=[0.5, 0.5, 0.2, 80, 0.5, 10, 1000, 0.5, 0.5, 60, 150],
        size=(n, len(FEATURE_NAMES)),
    ).astype(np.float32)
    normal = np.clip(normal, 0, None)

    # 5% anomalous bots
    n_bots = n // 20
    bots = normal[:n_bots].copy()
    bots[:, 0] = rng.uniform(9, 15, n_bots).astype(np.float32)   # superhuman APS
    bots[:, 3] = rng.uniform(1, 8, n_bots).astype(np.float32)    # inhuman latency
    bots[:, 4] = rng.uniform(0, 0.05, n_bots).astype(np.float32) # no variance
    normal[:n_bots] = bots

    rng.shuffle(normal)
    agent_ids = [f"agent_{i}" for i in range(n)]
    return normal, agent_ids


def train(features_path: str | None, output_path: str, contamination: float = 0.05) -> None:
    if features_path and os.path.exists(features_path):
        X, ids = load_features_from_jsonl(features_path)
        print(f"[train_detector] Loaded {len(ids)} agent feature vectors from {features_path}")
    else:
        X, ids = generate_synthetic_features(n=5000)
        print(f"[train_detector] Generated {len(ids)} synthetic feature vectors")

    scorer = BehaviourAnomalyScorer(contamination=contamination)
    scorer.fit(X)

    with open(output_path, "wb") as f:
        pickle.dump(scorer, f)
    print(f"[train_detector] Model saved to {output_path}")

    # Quick validation
    results = scorer.score_batch(X[:20], ids[:20])
    n_anomalies = sum(1 for r in results if r.is_anomaly)
    print(f"[train_detector] Validation: {n_anomalies}/20 samples flagged as anomalies")


def load_scorer(model_path: str = MODEL_PATH) -> BehaviourAnomalyScorer:
    with open(model_path, "rb") as f:
        return pickle.load(f)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--features", type=str, default=None, help="JSONL features file")
    parser.add_argument("--output", type=str, default=MODEL_PATH)
    parser.add_argument("--contamination", type=float, default=0.05)
    args = parser.parse_args()

    train(args.features, args.output, args.contamination)
