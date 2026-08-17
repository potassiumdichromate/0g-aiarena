"""
The evaluation ladder must separate agents of different quality.

This is a matching requirement, not an aesthetic one. A job posting says
"provider must have combat skill >= 90". If every competent agent scores the
same because the ladder saturates, that predicate selects nobody or everybody
and discovery is meaningless.

eval-v1 failed this: its hardest rung was 0.9, which every competent policy won
outright. These tests pin the property so a future ladder edit cannot silently
reintroduce it.
"""

import numpy as np
import pytest
import torch

from trait_training.bc import train_behaviour_cloning
from trait_training.demonstrations import collect_demonstrations
from trait_training.evaluate import (
    EVAL_PROTOCOL_VERSION,
    STANDARD_DIFFICULTIES,
    evaluate_policy,
)
from trait_training.policy import ArenaActorCritic, ScriptedPolicy, greedy_policy_fn
from trait_training.rollout import ATTACK, IDLE


class HopelessPolicy:
    def __call__(self, obs: np.ndarray) -> int:
        return IDLE


class WeakPolicy:
    """Swings every third tick regardless of range."""

    def __init__(self):
        self._tick = 0

    def __call__(self, obs: np.ndarray) -> int:
        self._tick += 1
        return ATTACK if self._tick % 3 == 0 else IDLE


def _skill(policy, episodes: int = 4) -> int:
    return evaluate_policy(policy, seed_root=555, episodes_per_difficulty=episodes).measurement.combat_skill


def test_protocol_version_pinned():
    assert EVAL_PROTOCOL_VERSION == 'eval-v2'


def test_ladder_has_a_rung_above_the_saturation_point():
    # eval-v1's ceiling was 0.9, which every competent policy beats.
    assert max(STANDARD_DIFFICULTIES) > 1.0


def test_ladder_drops_the_rungs_everyone_wins():
    # 0.3 and 0.5 were won by every candidate measured, including a hopeless one.
    assert min(STANDARD_DIFFICULTIES) >= 0.7


def test_ladder_separates_three_quality_tiers():
    competent = _skill(ScriptedPolicy(aggression=1.0))
    weak = _skill(WeakPolicy())
    hopeless = _skill(HopelessPolicy())

    assert competent > weak > hopeless, f'competent={competent} weak={weak} hopeless={hopeless}'
    # A meaningful gap, not a rounding difference — matching predicates need room.
    assert competent - weak >= 10


def test_competent_policy_does_not_saturate():
    """
    A competent agent must leave headroom at the top.

    If a decent policy already scores ~100, no job can ask for a genuinely
    excellent provider and expect the predicate to mean anything.
    """
    assert _skill(ScriptedPolicy(aggression=1.0)) < 90


@pytest.mark.parametrize('seed_root', [555, 987654])
def test_hardest_rung_is_reliably_winnable_by_a_competent_policy(seed_root):
    """
    A rung nobody ever wins carries no information (3.0+ measured at 0.00), and
    one that flips between 0.00 and 0.25 depending on the seed root adds
    variance rather than signal — which is exactly why 2.5 was dropped from
    this ladder. The top rung must be hard but reliably winnable.
    """
    report = evaluate_policy(
        ScriptedPolicy(aggression=1.0), seed_root=seed_root, episodes_per_difficulty=8,
        difficulties=[max(STANDARD_DIFFICULTIES)],
    )
    assert report.measurement.components['winRate'] > 0.0


def test_trained_policy_still_beats_an_untrained_one_on_the_new_ladder():
    torch.manual_seed(0)
    untrained = ArenaActorCritic()
    trained = ArenaActorCritic()
    demos = collect_demonstrations(ScriptedPolicy(), episodes=14, difficulties=[0.7, 0.9], seed=0)
    train_behaviour_cloning(trained, demos, epochs=6, seed=0)

    assert _skill(greedy_policy_fn(trained)) > _skill(greedy_policy_fn(untrained))
