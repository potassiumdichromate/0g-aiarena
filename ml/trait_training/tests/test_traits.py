"""
Trait measurement is the contract the marketplace settles against, so these
tests pin its arithmetic rather than just exercising it.
"""

import math

import pytest

from trait_training.rollout import EpisodeMetrics
from trait_training.traits import (
    COMBAT_SKILL_WEIGHTS,
    CAPABILITY_FORMULA_VERSION,
    _normalized_action_entropy,
    aggregate_counters,
    measure,
)
from environment import ACTION_VOCAB


def make_episode(**overrides) -> EpisodeMetrics:
    base = dict(
        seed=1, difficulty=0.5, steps=100, won=True, total_reward=10.0,
        attack_attempts=50, attack_hits=40,
        ability_attempts=10, ability_hits=8,
        damage_dealt=6.0, damage_taken=0.4, hp_retained=0.6,
        flee_uses=2, flee_while_low_hp=2,
        heal_uses=2, heal_while_useful=2,
        defend_uses=10, idle_uses=0,
        action_counts=[50, 10, 2, 0, 10, 2, 0],
    )
    base.update(overrides)
    return EpisodeMetrics(**base)


def test_formula_weights_sum_to_one():
    # If a weight is retuned without rebalancing, combatSkill silently changes
    # scale and every historical score becomes incomparable.
    assert math.isclose(sum(COMBAT_SKILL_WEIGHTS.values()), 1.0, rel_tol=1e-9)


def test_measurement_is_deterministic():
    episodes = [make_episode(seed=i) for i in range(5)]
    assert measure(episodes).to_dict() == measure(episodes).to_dict()


def test_precision_is_hits_over_attempts():
    episodes = [make_episode(attack_attempts=100, attack_hits=75, ability_attempts=0, ability_hits=0)]
    m = measure(episodes)
    assert m.components['precision'] == pytest.approx(0.75)
    assert m.traits.precision == 75


def test_perfect_agent_scores_near_100_and_hopeless_agent_near_0():
    perfect = [
        make_episode(
            won=True, attack_attempts=50, attack_hits=50, ability_attempts=0, ability_hits=0,
            damage_dealt=20.0, damage_taken=0.0, hp_retained=1.0, steps=100,
        )
    ]
    hopeless = [
        make_episode(
            won=False, attack_attempts=50, attack_hits=0, ability_attempts=0, ability_hits=0,
            damage_dealt=0.0, damage_taken=1.0, hp_retained=0.0, steps=100,
            flee_uses=0, flee_while_low_hp=0, heal_uses=0, heal_while_useful=0,
        )
    ]
    assert measure(perfect).combat_skill > 90
    assert measure(hopeless).combat_skill < 10


def test_combat_skill_is_monotonic_in_precision():
    def skill(hits):
        return measure([make_episode(attack_attempts=100, attack_hits=hits,
                                     ability_attempts=0, ability_hits=0)]).combat_skill

    scores = [skill(h) for h in (0, 25, 50, 75, 100)]
    assert scores == sorted(scores)
    assert scores[0] < scores[-1]


def test_unmeasurable_traits_are_none_not_invented():
    # loyalty/deception have no behavioural signal in this environment.
    # Returning a plausible number would be exactly the fabrication this
    # pipeline exists to avoid.
    traits = measure([make_episode()]).traits
    assert traits.loyalty is None
    assert traits.deception is None
    assert 'loyalty' not in traits.measurable()


def test_adaptability_rewards_correct_situational_use():
    good = measure([make_episode(flee_uses=4, flee_while_low_hp=4, heal_uses=4, heal_while_useful=4)])
    bad = measure([make_episode(flee_uses=4, flee_while_low_hp=0, heal_uses=4, heal_while_useful=0)])
    assert good.traits.adaptability == 100
    assert bad.traits.adaptability == 0


def test_never_using_situational_actions_scores_zero_adaptability():
    # An agent that never flees and never heals has not *demonstrated*
    # adaptability, so it must not receive a free pass.
    never = measure([make_episode(flee_uses=0, flee_while_low_hp=0, heal_uses=0, heal_while_useful=0)])
    assert never.traits.adaptability == 0


def test_action_entropy_bounds():
    single = [0] * len(ACTION_VOCAB)
    single[0] = 100
    assert _normalized_action_entropy(single) == pytest.approx(0.0)

    uniform = [10] * len(ACTION_VOCAB)
    assert _normalized_action_entropy(uniform) == pytest.approx(1.0)

    assert _normalized_action_entropy([0] * len(ACTION_VOCAB)) == 0.0


def test_creativity_tracks_behavioural_variety():
    one_note = [0] * len(ACTION_VOCAB)
    one_note[0] = 100
    varied = [15, 15, 15, 15, 15, 15, 10]

    assert measure([make_episode(action_counts=one_note)]).traits.creativity == 0
    assert measure([make_episode(action_counts=varied)]).traits.creativity > 90


def test_all_traits_within_platform_scale():
    for episodes in ([make_episode()], [make_episode(won=False, hp_retained=0.0, damage_taken=5.0)]):
        for name, value in measure(episodes).traits.measurable().items():
            assert 0 <= value <= 100, f'{name} out of range: {value}'


def test_zero_episodes_raises_rather_than_returning_a_default():
    # Silently returning zeros here would let an empty evaluation read as a
    # legitimately terrible agent.
    with pytest.raises(ValueError):
        measure([])


def test_counters_carry_provenance():
    c = aggregate_counters([make_episode(), make_episode(won=False)])
    assert c['episodes'] == 2
    assert c['wins'] == 1
    assert c['attack_attempts'] == 100


def test_formula_version_is_pinned():
    # A changed formula with an unchanged version breaks reproducibility of
    # every previously settled job.
    assert CAPABILITY_FORMULA_VERSION == 'cap-v1'
    assert measure([make_episode()]).formula_version == 'cap-v1'
