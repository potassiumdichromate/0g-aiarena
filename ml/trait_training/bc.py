"""
Behaviour cloning — supervised imitation of the trainer's donated trajectories.

Real training: cross-entropy over (observation -> action) pairs, minibatch SGD,
a held-out split so reported accuracy is not measured on the training data.
Replaces workers/training-worker/src/behaviour_cloning.py, which sleeps two
seconds and returns a hardcoded `{'loss': 0.342, 'accuracy': 0.876}`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Dict, List, Optional

import numpy as np
import torch
import torch.nn as nn

from .demonstrations import DemonstrationSet, to_tensors
from .policy import ArenaActorCritic


@dataclass
class BCResult:
    epochs: int
    final_train_loss: float
    final_val_loss: float
    val_accuracy: float
    samples: int
    history: List[Dict[str, float]]


def train_behaviour_cloning(
    model: ArenaActorCritic,
    demos: DemonstrationSet,
    epochs: int = 8,
    batch_size: int = 256,
    learning_rate: float = 1e-3,
    val_fraction: float = 0.15,
    seed: int = 0,
    on_epoch: Optional[Callable[[int, int, Dict[str, float]], None]] = None,
) -> BCResult:
    """Fit `model.actor` to the donated demonstrations."""
    generator = torch.Generator().manual_seed(seed)
    observations, actions = to_tensors(demos)
    total = observations.shape[0]

    # Shuffle before splitting: demonstrations arrive in episode order, so a
    # tail split would validate entirely on the hardest difficulty.
    permutation = torch.randperm(total, generator=generator)
    observations, actions = observations[permutation], actions[permutation]

    val_size = max(1, int(total * val_fraction)) if total > 1 else 0
    train_obs, train_act = observations[val_size:], actions[val_size:]
    val_obs, val_act = observations[:val_size], actions[:val_size]

    if train_obs.shape[0] == 0:
        raise ValueError('Not enough demonstrations to train on')

    optimizer = torch.optim.Adam(model.actor.parameters(), lr=learning_rate)
    criterion = nn.CrossEntropyLoss()
    history: List[Dict[str, float]] = []

    final_train_loss = 0.0
    final_val_loss = 0.0
    val_accuracy = 0.0

    for epoch in range(epochs):
        model.actor.train()
        order = torch.randperm(train_obs.shape[0], generator=generator)
        epoch_loss, batches = 0.0, 0

        for start in range(0, train_obs.shape[0], batch_size):
            index = order[start:start + batch_size]
            optimizer.zero_grad()
            loss = criterion(model.actor(train_obs[index]), train_act[index])
            loss.backward()
            # The transformer actor is prone to large early gradients on this
            # small, highly-correlated dataset.
            torch.nn.utils.clip_grad_norm_(model.actor.parameters(), 1.0)
            optimizer.step()

            epoch_loss += float(loss.item())
            batches += 1

        final_train_loss = epoch_loss / max(1, batches)

        model.actor.eval()
        if val_size > 0:
            with torch.no_grad():
                logits = model.actor(val_obs)
                final_val_loss = float(criterion(logits, val_act).item())
                val_accuracy = float((logits.argmax(dim=-1) == val_act).float().mean().item())
        else:
            final_val_loss, val_accuracy = final_train_loss, 0.0

        entry = {
            'epoch': float(epoch + 1),
            'trainLoss': final_train_loss,
            'valLoss': final_val_loss,
            'valAccuracy': val_accuracy,
        }
        history.append(entry)
        if on_epoch is not None:
            on_epoch(epoch + 1, epochs, entry)

    return BCResult(
        epochs=epochs,
        final_train_loss=final_train_loss,
        final_val_loss=final_val_loss,
        val_accuracy=val_accuracy,
        samples=int(total),
        history=history,
    )
