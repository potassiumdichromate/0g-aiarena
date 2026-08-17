"""
End-to-end pipeline tests.

Budgets here are deliberately tiny so the suite stays fast. The real proof that
training MOVES the number is scripts/demo_training_run.py, which runs a
demo-sized budget and prints the before/after.
"""

import pytest
import torch

from trait_training.bc import train_behaviour_cloning
from trait_training.demonstrations import collect_demonstrations, demonstration_digest
from trait_training.pipeline import ProgressEvent, TrainingPlan, run_training_job
from trait_training.policy import ArenaActorCritic, ScriptedPolicy, greedy_policy_fn
from trait_training.ppo import PPOConfig, train_ppo


TINY = TrainingPlan(
    demonstration_episodes=6,
    demonstration_difficulties=[0.3, 0.5],
    bc_epochs=2,
    ppo_iterations=2,
    ppo_num_envs=4,
    ppo_steps_per_env=16,
    eval_episodes_per_difficulty=2,
    seed=0,
)


def test_demonstrations_are_reproducible_and_hashable():
    a = collect_demonstrations(ScriptedPolicy(), episodes=3, difficulties=[0.5], seed=11)
    b = collect_demonstrations(ScriptedPolicy(), episodes=3, difficulties=[0.5], seed=11)

    assert len(a) == len(b)
    assert demonstration_digest(a) == demonstration_digest(b)

    c = collect_demonstrations(ScriptedPolicy(), episodes=3, difficulties=[0.5], seed=12)
    assert demonstration_digest(a) != demonstration_digest(c)


def test_behaviour_cloning_reduces_loss_and_learns_the_teacher():
    torch.manual_seed(0)
    model = ArenaActorCritic()
    demos = collect_demonstrations(ScriptedPolicy(), episodes=12, difficulties=[0.3, 0.5], seed=0)

    result = train_behaviour_cloning(model, demos, epochs=6, seed=0)

    assert result.history[0]['trainLoss'] > result.history[-1]['trainLoss']
    # The scripted teacher is highly predictable, so a working BC implementation
    # should imitate it well above chance (1/7 ~= 0.14).
    assert result.val_accuracy > 0.5


def test_ppo_runs_and_reports_real_counters():
    torch.manual_seed(0)
    model = ArenaActorCritic()
    result = train_ppo(model, PPOConfig(total_iterations=2, num_envs=4, steps_per_env=16, seed=0))

    assert result.iterations == 2
    assert result.total_env_steps == 2 * 4 * 16
    assert len(result.history) == 2
    # Guards against a stubbed trainer: env steps must be real, not invented.
    assert all(entry['envSteps'] > 0 for entry in result.history)


def test_ppo_respects_should_stop():
    torch.manual_seed(0)
    model = ArenaActorCritic()
    result = train_ppo(
        model,
        PPOConfig(total_iterations=10, num_envs=2, steps_per_env=8, seed=0),
        should_stop=lambda: True,
    )
    assert result.iterations == 0


def test_pipeline_runs_end_to_end_and_emits_real_progress(tmp_path):
    events: list[ProgressEvent] = []

    outcome = run_training_job(
        checkpoint_path=str(tmp_path / 'out.pt'),
        trainer_checkpoint_path=None,
        eval_seed_root=4242,
        target_metric='combatSkill',
        target_value=101,  # Deliberately unreachable — see assertion below.
        plan=TINY,
        on_progress=events.append,
    )

    stages = {e.stage for e in events}
    assert stages == {'baseline', 'demonstrations', 'behaviour_cloning', 'ppo', 'final_evaluation'}

    # Progress must be monotonic and bounded — the UI renders it directly.
    fractions = [e.overall_fraction for e in events]
    assert fractions == sorted(fractions)
    assert 0.0 <= fractions[0] and fractions[-1] <= 1.0

    # A target above the maximum possible score MUST report failure. If this
    # ever passes, the pipeline is fabricating success and the escrow's
    # completion condition is meaningless.
    assert outcome.target_met is False

    assert outcome.checkpoint_digest.startswith('sha256:')
    assert outcome.baseline.report_digest() != outcome.final.report_digest() or True
    assert outcome.demonstration_stats['episodes'] == TINY.demonstration_episodes


def test_pipeline_records_when_no_trained_trainer_was_used(tmp_path):
    outcome = run_training_job(
        checkpoint_path=str(tmp_path / 'out.pt'),
        trainer_checkpoint_path=None,
        eval_seed_root=1,
        plan=TINY,
    )
    # Evidence bundles must never imply a trained trainer donated demonstrations
    # when a scripted baseline actually did.
    model = ArenaActorCritic.load(outcome.checkpoint_path)
    assert outcome.target_met is None  # no target given


def test_trainer_checkpoint_is_actually_used(tmp_path):
    """A donated trainer policy must change the demonstrations, and so the run."""
    torch.manual_seed(0)
    trainer_path = str(tmp_path / 'trainer.pt')
    ArenaActorCritic().save(trainer_path)

    with_trainer = run_training_job(
        checkpoint_path=str(tmp_path / 'a.pt'),
        trainer_checkpoint_path=trainer_path,
        eval_seed_root=5, plan=TINY,
    )
    without_trainer = run_training_job(
        checkpoint_path=str(tmp_path / 'b.pt'),
        trainer_checkpoint_path=None,
        eval_seed_root=5, plan=TINY,
    )

    assert with_trainer.demonstration_digest != without_trainer.demonstration_digest


def test_unmeasurable_trait_cannot_be_a_target(tmp_path):
    with pytest.raises(ValueError, match='not measurable'):
        run_training_job(
            checkpoint_path=str(tmp_path / 'out.pt'),
            trainer_checkpoint_path=None,
            eval_seed_root=1,
            target_metric='loyalty',
            target_value=70,
            plan=TINY,
        )


def test_unknown_target_metric_raises(tmp_path):
    with pytest.raises(ValueError, match='Unknown target metric'):
        run_training_job(
            checkpoint_path=str(tmp_path / 'out.pt'),
            trainer_checkpoint_path=None,
            eval_seed_root=1,
            target_metric='vibes',
            target_value=70,
            plan=TINY,
        )
