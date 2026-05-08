"""
Dataset utilities for behaviour cloning.
Loads and preprocesses battle replay frames into (state, action) pairs.
"""
from __future__ import annotations

import json
import random
from dataclasses import dataclass
from typing import Any, Dict, List, Tuple

import numpy as np
import torch
from torch.utils.data import Dataset


ACTION_VOCAB = ["ATTACK", "DEFEND", "FLEE", "SUPPORT", "ABILITY_1", "ABILITY_2", "IDLE"]
ACTION_TO_IDX = {a: i for i, a in enumerate(ACTION_VOCAB)}
IDX_TO_ACTION = {i: a for a, i in ACTION_TO_IDX.items()}
NUM_ACTIONS = len(ACTION_VOCAB)

STATE_DIM = 32  # flattened observation vector


@dataclass
class BattleFrame:
    agent_id: str
    frame_number: int
    observation: np.ndarray  # shape (STATE_DIM,)
    action: str
    reward: float = 0.0


def encode_observation(raw: Dict[str, Any]) -> np.ndarray:
    """Encode a raw game state dict into a fixed-size float32 vector."""
    vec = np.zeros(STATE_DIM, dtype=np.float32)
    vec[0] = float(raw.get("health", 100)) / 100.0
    vec[1] = float(raw.get("enemy_health", 100)) / 100.0
    vec[2] = float(raw.get("distance_to_enemy", 10)) / 20.0
    vec[3] = float(raw.get("cooldown_1", 0)) / 10.0
    vec[4] = float(raw.get("cooldown_2", 0)) / 10.0
    vec[5] = float(raw.get("time_remaining", 300)) / 300.0
    pos = raw.get("position", {"x": 0, "y": 0, "z": 0})
    vec[6] = float(pos.get("x", 0)) / 100.0
    vec[7] = float(pos.get("y", 0)) / 50.0
    vec[8] = float(pos.get("z", 0)) / 100.0
    # Pad remaining with noise for richer input
    rng = np.random.default_rng(int(raw.get("frame_number", 0)))
    vec[9:] = rng.uniform(-0.1, 0.1, STATE_DIM - 9).astype(np.float32)
    return vec


def load_replay_frames(replay_path: str) -> List[BattleFrame]:
    """Load replay JSON file and parse into BattleFrame list."""
    with open(replay_path, "r") as f:
        replay = json.load(f)

    frames: List[BattleFrame] = []
    for raw in replay.get("frames", []):
        for agent_state in raw.get("agentStates", []):
            action = agent_state.get("lastAction", "IDLE").upper()
            if action not in ACTION_TO_IDX:
                action = "IDLE"
            obs = encode_observation({
                **raw,
                "frame_number": raw.get("frameNumber", 0),
                **agent_state,
            })
            frames.append(BattleFrame(
                agent_id=agent_state.get("agentId", "unknown"),
                frame_number=raw.get("frameNumber", 0),
                observation=obs,
                action=action,
                reward=float(agent_state.get("reward", 0.0)),
            ))
    return frames


class BehaviourCloningDataset(Dataset):
    """PyTorch Dataset for behaviour cloning from replay frames."""

    def __init__(self, frames: List[BattleFrame], augment: bool = False):
        self.frames = frames
        self.augment = augment

    def __len__(self) -> int:
        return len(self.frames)

    def __getitem__(self, idx: int) -> Tuple[torch.Tensor, torch.Tensor]:
        frame = self.frames[idx]
        obs = frame.observation.copy()
        if self.augment:
            obs += np.random.normal(0, 0.01, obs.shape).astype(np.float32)
        state = torch.tensor(obs, dtype=torch.float32)
        label = torch.tensor(ACTION_TO_IDX[frame.action], dtype=torch.long)
        return state, label

    @classmethod
    def from_replay_file(cls, path: str, augment: bool = False) -> "BehaviourCloningDataset":
        frames = load_replay_frames(path)
        return cls(frames, augment=augment)

    @classmethod
    def from_synthetic(cls, n_samples: int = 10000, seed: int = 42) -> "BehaviourCloningDataset":
        """Generate synthetic dataset for testing / pre-training."""
        rng = np.random.default_rng(seed)
        frames = []
        for i in range(n_samples):
            obs = rng.uniform(0, 1, STATE_DIM).astype(np.float32)
            # Heuristic labels: low health → FLEE, high aggression obs → ATTACK
            if obs[0] < 0.2:
                action = "FLEE"
            elif obs[0] > 0.7 and obs[1] < 0.5:
                action = "ATTACK"
            else:
                action = random.choice(ACTION_VOCAB)
            frames.append(BattleFrame(
                agent_id=f"synthetic_{i}",
                frame_number=i,
                observation=obs,
                action=action,
            ))
        return cls(frames, augment=False)


def split_dataset(
    dataset: BehaviourCloningDataset,
    train_ratio: float = 0.8,
    val_ratio: float = 0.1,
) -> Tuple["BehaviourCloningDataset", "BehaviourCloningDataset", "BehaviourCloningDataset"]:
    """Split dataset into train / val / test subsets."""
    n = len(dataset)
    indices = list(range(n))
    random.shuffle(indices)
    train_end = int(n * train_ratio)
    val_end = int(n * (train_ratio + val_ratio))

    def subset(idxs):
        ds = BehaviourCloningDataset([dataset.frames[i] for i in idxs], augment=False)
        return ds

    return subset(indices[:train_end]), subset(indices[train_end:val_end]), subset(indices[val_end:])
