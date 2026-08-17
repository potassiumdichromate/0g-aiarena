"""
The economic premise of the marketplace, as an executable test.

Agent A pays more for a more capable Agent B. That is only rational if the
trainer's capability actually changes the outcome. If a weak trainer produced
the same student as a strong one, the whole negotiation would be theatre and
the capability requirements in a job posting would be decoration.

So: a deliberately bad teacher must produce a measurably worse student than a
good one, through the same pipeline, with everything else held equal.
"""

import numpy as np
import pytest
import torch

from trait_training.bc import train_behaviour_cloning
from trait_training.demonstrations import collect_demonstrations
from trait_training.evaluate import evaluate_policy
from trait_training.policy import ArenaActorCritic, ScriptedPolicy, greedy_policy_fn
from trait_training.rollout import ATTACK, IDLE


class IdlePolicy:
    """A teacher with nothing to teach: never attacks, never wins."""

    def __call__(self, obs: np.ndarray) -> int:
        return IDLE


class PanicPolicy:
    """A teacher with an actively harmful habit: attacks from out of range."""

    def __call__(self, obs: np.ndarray) -> int:
        distance = float(obs[2])
        # Attack range is obs[2] < 0.15; this one only ever swings when it
        # cannot possibly connect.
        return ATTACK if distance >= 0.15 else IDLE


def _student_from(teacher, seed: int = 0) -> int:
    """Run demonstrations -> BC with a fixed budget and return combatSkill."""
    torch.manual_seed(seed)
    model = ArenaActorCritic()
    demos = collect_demonstrations(teacher, episodes=14, difficulties=[0.3, 0.5], seed=seed)
    train_behaviour_cloning(model, demos, epochs=6, seed=seed)
    report = evaluate_policy(greedy_policy_fn(model), seed_root=31337, episodes_per_difficulty=3)
    return report.measurement.combat_skill


def test_competent_teacher_beats_idle_teacher():
    competent = _student_from(ScriptedPolicy(aggression=1.0))
    idle = _student_from(IdlePolicy())

    # A student taught only to idle cannot fight.
    assert idle < 20
    assert competent > idle + 20, (
        f'Trainer quality did not propagate: competent={competent}, idle={idle}. '
        'If these are close, paying more for a better trainer is irrational and '
        'the marketplace premise is broken.'
    )


def test_competent_teacher_beats_a_teacher_with_bad_habits():
    competent = _student_from(ScriptedPolicy(aggression=1.0))
    panic = _student_from(PanicPolicy())

    # Attacking out of range is precisely what `precision` penalizes.
    assert competent > panic, f'competent={competent}, panic={panic}'


def test_teacher_win_rate_is_recorded_for_the_audit_trail():
    """The evidence bundle must show what the trainer actually demonstrated."""
    good = collect_demonstrations(ScriptedPolicy(), episodes=8, difficulties=[0.3], seed=1)
    bad = collect_demonstrations(IdlePolicy(), episodes=8, difficulties=[0.3], seed=1)

    assert good.win_rate > bad.win_rate
    assert bad.win_rate == 0.0


@pytest.mark.parametrize('seed', [0, 7])
def test_result_is_not_a_fluke_of_one_seed(seed):
    competent = _student_from(ScriptedPolicy(aggression=1.0), seed=seed)
    idle = _student_from(IdlePolicy(), seed=seed)
    assert competent > idle
