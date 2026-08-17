"""
Reproducibility tests.

These are the tests that make the marketplace's verification claim true. If any
of them fails, an evaluator and a provider can compute different scores for the
same checkpoint and the escrow's completion condition becomes unresolvable.
"""

import numpy as np
import pytest
import torch

from trait_training.evaluate import derive_seeds, evaluate_policy, evaluate_checkpoint
from trait_training.policy import ArenaActorCritic, ScriptedPolicy, greedy_policy_fn, checkpoint_digest
from trait_training.rollout import run_episode


def test_same_seed_same_episode():
    policy = ScriptedPolicy()
    a = run_episode(policy, seed=42, difficulty=0.5)
    b = run_episode(policy, seed=42, difficulty=0.5)
    assert a.to_dict() == b.to_dict()


def test_different_seeds_give_different_episodes():
    # If seeds did not matter, the "ladder" would be one episode repeated and
    # a provider could overfit to a single starting position.
    policy = ScriptedPolicy()
    a = run_episode(policy, seed=1, difficulty=0.5)
    b = run_episode(policy, seed=2, difficulty=0.5)
    assert a.to_dict() != b.to_dict()


def test_difficulty_changes_outcomes():
    policy = ScriptedPolicy()
    easy = run_episode(policy, seed=7, difficulty=0.1)
    hard = run_episode(policy, seed=7, difficulty=1.0)
    assert easy.damage_taken < hard.damage_taken


def test_seed_derivation_is_deterministic_and_unpredictable():
    assert derive_seeds(12345, 10) == derive_seeds(12345, 10)
    assert derive_seeds(12345, 10) != derive_seeds(12346, 10)

    # Seeds must not be a guessable arithmetic sequence — otherwise one leaked
    # seed exposes the whole evaluation ladder (threat T18).
    seeds = derive_seeds(999, 8)
    diffs = {b - a for a, b in zip(seeds, seeds[1:])}
    assert len(diffs) > 1


def test_evaluation_is_reproducible_for_an_untrained_network():
    torch.manual_seed(0)
    model = ArenaActorCritic()

    first = evaluate_policy(greedy_policy_fn(model), seed_root=2024, episodes_per_difficulty=2)
    second = evaluate_policy(greedy_policy_fn(model), seed_root=2024, episodes_per_difficulty=2)

    assert first.measurement.combat_skill == second.measurement.combat_skill
    assert first.report_digest() == second.report_digest()


def test_report_digest_changes_when_the_score_changes():
    torch.manual_seed(0)
    a = evaluate_policy(greedy_policy_fn(ArenaActorCritic()), seed_root=1, episodes_per_difficulty=2)
    b = evaluate_policy(ScriptedPolicy(), seed_root=1, episodes_per_difficulty=2)

    if a.measurement.combat_skill != b.measurement.combat_skill:
        assert a.report_digest() != b.report_digest()


def test_checkpoint_roundtrip_preserves_behaviour(tmp_path):
    """
    A checkpoint written, reloaded, and re-evaluated must score identically.

    This is what lets the escrow settle against a checkpoint digest: the
    artifact handed over is provably the artifact that was measured.
    """
    torch.manual_seed(3)
    model = ArenaActorCritic()
    path = str(tmp_path / 'policy.pt')
    model.save(path)

    direct = evaluate_policy(greedy_policy_fn(model), seed_root=77, episodes_per_difficulty=2)
    reloaded = evaluate_checkpoint(path, seed_root=77, episodes_per_difficulty=2)

    assert direct.measurement.combat_skill == reloaded.measurement.combat_skill
    assert direct.measurement.traits.to_dict() == reloaded.measurement.traits.to_dict()


def test_checkpoint_digest_is_stable_and_content_sensitive(tmp_path):
    torch.manual_seed(4)
    first = ArenaActorCritic()
    path_a = str(tmp_path / 'a.pt')
    first.save(path_a)

    assert checkpoint_digest(path_a) == checkpoint_digest(path_a)

    torch.manual_seed(5)
    path_b = str(tmp_path / 'b.pt')
    ArenaActorCritic().save(path_b)
    assert checkpoint_digest(path_a) != checkpoint_digest(path_b)


def test_greedy_policy_is_deterministic():
    torch.manual_seed(6)
    act = greedy_policy_fn(ArenaActorCritic())
    obs = np.random.default_rng(0).uniform(0, 1, 32).astype(np.float32)
    assert len({act(obs) for _ in range(20)}) == 1


def test_rejects_foreign_checkpoint_format(tmp_path):
    path = str(tmp_path / 'bogus.pt')
    torch.save({'format': 'something-else', 'config': {}}, path)
    with pytest.raises(ValueError, match='Unsupported checkpoint format'):
        ArenaActorCritic.load(path)
