"""
Find difficulty rungs that actually discriminate between agents.

Phase 2 shipped the ladder [0.3, 0.5, 0.7, 0.9] and measurement showed a
trained policy winning 40/40 across all of it. A rung everyone wins is a rung
that carries no information: winRate contributes a flat 0.30 to every competent
agent, and capability profiles bunch up — which breaks matching, because a job
asking for "combat skill >= 90" cannot separate candidates.

This sweeps a range of difficulties against policies of deliberately different
quality and prints where they start to come apart. The chosen ladder goes into
evaluate.STANDARD_DIFFICULTIES.

    docker run --rm kult-trait-training python trait_training/scripts/difficulty_sweep.py
"""

from __future__ import annotations

import argparse
import sys

import numpy as np
import torch

from trait_training.bc import train_behaviour_cloning
from trait_training.demonstrations import collect_demonstrations
from trait_training.evaluate import evaluate_policy
from trait_training.policy import ArenaActorCritic, ScriptedPolicy, greedy_policy_fn
from trait_training.rollout import ATTACK, IDLE


class WeakPolicy:
    """Attacks only sometimes, and not always in range — a mediocre agent."""

    def __init__(self, period: int = 3):
        self.period = period
        self._tick = 0

    def __call__(self, obs: np.ndarray) -> int:
        self._tick += 1
        return ATTACK if self._tick % self.period == 0 else IDLE


def train_student(seed: int = 0) -> ArenaActorCritic:
    torch.manual_seed(seed)
    model = ArenaActorCritic()
    demos = collect_demonstrations(ScriptedPolicy(), episodes=20, difficulties=[0.3, 0.5, 0.7], seed=seed)
    train_behaviour_cloning(model, demos, epochs=8, seed=seed)
    return model


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--episodes', type=int, default=8)
    parser.add_argument(
        '--difficulties', type=float, nargs='+',
        default=[0.3, 0.5, 0.7, 0.9, 1.2, 1.5, 2.0, 2.5, 3.0, 4.0],
    )
    args = parser.parse_args()

    print('\nTraining a student policy for the sweep...')
    student = train_student()

    candidates = [
        ('trained', greedy_policy_fn(student)),
        ('scripted', ScriptedPolicy()),
        ('weak', WeakPolicy()),
    ]

    print(f'\n{"difficulty":>12} | ' + ' | '.join(f'{name:>18}' for name, _ in candidates))
    print('-' * (14 + 22 * len(candidates)))

    spreads = []
    for difficulty in args.difficulties:
        cells = []
        win_rates = []
        for _name, policy in candidates:
            report = evaluate_policy(
                policy, seed_root=987654, episodes_per_difficulty=args.episodes,
                difficulties=[difficulty],
            )
            win_rate = report.measurement.components['winRate']
            win_rates.append(win_rate)
            cells.append(f'win {win_rate:>4.2f} skill {report.measurement.combat_skill:>3}')

        spread = max(win_rates) - min(win_rates)
        spreads.append((difficulty, spread, win_rates))
        print(f'{difficulty:>12.1f} | ' + ' | '.join(f'{c:>18}' for c in cells))

    print('\nDiscrimination (max-min win rate across candidates):')
    for difficulty, spread, win_rates in spreads:
        bar = '#' * int(spread * 40)
        flag = ''
        if all(w >= 0.999 for w in win_rates):
            flag = '  <- everyone wins, carries no information'
        elif all(w <= 0.001 for w in win_rates):
            flag = '  <- nobody wins, carries no information'
        print(f'  {difficulty:>5.1f}  {spread:>5.2f}  {bar}{flag}')

    return 0


if __name__ == '__main__':
    sys.exit(main())
