"""
Trainer-donated demonstrations.

This is the economic heart of the marketplace. Agent B does not hand Agent A a
number — it rolls out ITS OWN policy and donates the resulting state-action
trajectories. Agent A then learns to imitate them.

The consequence is that the trainer's capability is a real input to the
outcome: a trainer whose policy hits 90% of its attacks donates trajectories
that teach good timing, and a trainer whose policy flails donates noise. A weak
trainer cannot produce a strong student, which is exactly why paying more for a
more capable trainer is rational rather than decorative.

Demonstrations are recorded with a SAMPLING policy, not greedy: identical
greedy trajectories across seeds would collapse the dataset to a handful of
distinct states and teach the student nothing about recovery from unfamiliar
positions.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, List, Optional

import numpy as np
import torch

from environment import AIArenaBattleEnv


@dataclass
class DemonstrationSet:
    observations: np.ndarray  # (N, STATE_DIM) float32
    actions: np.ndarray       # (N,) int64
    episodes: int
    mean_return: float
    win_rate: float

    def __len__(self) -> int:
        return int(self.observations.shape[0])


def collect_demonstrations(
    trainer_policy: Callable[[np.ndarray], int],
    episodes: int,
    difficulties: List[float],
    seed: int = 0,
    max_steps: int = 300,
    on_progress: Optional[Callable[[int, int], None]] = None,
) -> DemonstrationSet:
    """
    Roll out the trainer's policy and record every (observation, action) pair.

    Seeds are derived deterministically from `seed` so a demonstration set can
    be regenerated exactly — it forms part of the job's audit trail.
    """
    observations: List[np.ndarray] = []
    actions: List[int] = []
    returns: List[float] = []
    wins = 0

    for index in range(episodes):
        difficulty = difficulties[index % len(difficulties)]
        env = AIArenaBattleEnv({'difficulty': difficulty, 'max_steps': max_steps})
        obs, _ = env.reset(seed=seed + index)

        episode_return = 0.0
        while True:
            action = int(trainer_policy(obs))
            observations.append(np.asarray(obs, dtype=np.float32).copy())
            actions.append(action)

            obs, reward, terminated, truncated, info = env.step(action)
            episode_return += float(reward)

            if terminated or truncated:
                if float(info['enemy_hp']) <= 0 and float(info['agent_hp']) > 0:
                    wins += 1
                break

        returns.append(episode_return)
        if on_progress is not None:
            on_progress(index + 1, episodes)

    if not observations:
        raise ValueError('Demonstration collection produced no transitions')

    return DemonstrationSet(
        observations=np.stack(observations).astype(np.float32),
        actions=np.asarray(actions, dtype=np.int64),
        episodes=episodes,
        mean_return=float(np.mean(returns)),
        win_rate=float(wins / episodes),
    )


def demonstration_digest(demos: DemonstrationSet) -> str:
    """
    Content hash of the donated data.

    Recorded in the job's evidence bundle so the demonstrations that produced a
    student can be identified after the fact — the provider cannot later claim
    to have donated a better dataset than it did.
    """
    import hashlib

    digest = hashlib.sha256()
    digest.update(np.ascontiguousarray(demos.observations).tobytes())
    digest.update(np.ascontiguousarray(demos.actions).tobytes())
    return f'sha256:{digest.hexdigest()}'


def to_tensors(demos: DemonstrationSet) -> tuple[torch.Tensor, torch.Tensor]:
    return (
        torch.from_numpy(demos.observations),
        torch.from_numpy(demos.actions),
    )
