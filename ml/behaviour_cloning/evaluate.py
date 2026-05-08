"""
Evaluation utilities for behaviour cloning models.
Computes per-action accuracy, confusion matrix, and action distribution.
"""
from __future__ import annotations

from typing import Dict, List, Tuple

import numpy as np
import torch
from torch.utils.data import DataLoader

from dataset import ACTION_VOCAB, BehaviourCloningDataset, IDX_TO_ACTION, NUM_ACTIONS
from model import BCPolicyNetwork


def evaluate_model(
    model: BCPolicyNetwork,
    dataset: BehaviourCloningDataset,
    batch_size: int = 256,
    device: str | None = None,
) -> Dict[str, object]:
    device = device or ("cuda" if torch.cuda.is_available() else "cpu")
    model.to(device).eval()
    loader = DataLoader(dataset, batch_size=batch_size, shuffle=False)

    all_preds: List[int] = []
    all_labels: List[int] = []

    with torch.no_grad():
        for states, labels in loader:
            states = states.to(device)
            preds = model.predict(states, temperature=0)
            all_preds.extend(preds.cpu().tolist())
            all_labels.extend(labels.tolist())

    preds_np = np.array(all_preds)
    labels_np = np.array(all_labels)

    # Confusion matrix
    cm = np.zeros((NUM_ACTIONS, NUM_ACTIONS), dtype=int)
    for p, l in zip(preds_np, labels_np):
        cm[l, p] += 1

    # Per-class metrics
    per_class: Dict[str, Dict[str, float]] = {}
    for i, action in enumerate(ACTION_VOCAB):
        tp = cm[i, i]
        fp = cm[:, i].sum() - tp
        fn = cm[i, :].sum() - tp
        precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
        recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
        f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0.0
        per_class[action] = {"precision": precision, "recall": recall, "f1": f1}

    accuracy = float((preds_np == labels_np).mean())

    return {
        "accuracy": accuracy,
        "per_class": per_class,
        "confusion_matrix": cm.tolist(),
        "action_distribution": {
            IDX_TO_ACTION[i]: int((preds_np == i).sum()) for i in range(NUM_ACTIONS)
        },
    }


def print_report(metrics: Dict) -> None:
    print(f"\nOverall Accuracy: {metrics['accuracy']:.4f}")
    print("\nPer-class metrics:")
    print(f"{'Action':<12} {'Precision':>10} {'Recall':>10} {'F1':>8}")
    print("-" * 44)
    for action, m in metrics["per_class"].items():
        print(f"{action:<12} {m['precision']:>10.4f} {m['recall']:>10.4f} {m['f1']:>8.4f}")
    print("\nAction distribution (predictions):")
    for action, count in metrics["action_distribution"].items():
        print(f"  {action}: {count}")


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=str, required=True)
    parser.add_argument("--replay", type=str, default=None)
    parser.add_argument("--synthetic-n", type=int, default=5000)
    args = parser.parse_args()

    model = BCPolicyNetwork.load(args.model)

    if args.replay:
        dataset = BehaviourCloningDataset.from_replay_file(args.replay)
    else:
        dataset = BehaviourCloningDataset.from_synthetic(n_samples=args.synthetic_n)

    metrics = evaluate_model(model, dataset)
    print_report(metrics)
