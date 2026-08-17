"""
End-to-end trait training job.

    baseline evaluation
        -> trainer donates demonstrations
        -> behaviour cloning
        -> PPO curriculum
        -> final evaluation
        -> delta

Progress is reported through `on_progress` as real counters from the running
job — episodes actually completed, the current measured score — never a
percentage inferred from a status string.

The job can FAIL to hit its target, and that is the point. Nothing here nudges
the number toward the goal; the final evaluation is an independent measurement
of whatever the training actually produced.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

from .bc import BCResult, train_behaviour_cloning
from .demonstrations import DemonstrationSet, collect_demonstrations, demonstration_digest
from .evaluate import EvaluationReport, evaluate_policy
from .policy import ArenaActorCritic, ScriptedPolicy, greedy_policy_fn, sampling_policy_fn, checkpoint_digest
from .ppo import PPOConfig, PPOResult, train_ppo

import torch

# Coarse share of total job time per stage, used only to render a single
# progress bar. Stage-internal progress is real; these weights just place each
# stage within the whole.
STAGE_WEIGHTS = {
    'baseline': 0.10,
    'demonstrations': 0.15,
    'behaviour_cloning': 0.15,
    'ppo': 0.50,
    'final_evaluation': 0.10,
}


@dataclass
class TrainingPlan:
    """The trainer's curriculum choices — its actual professional judgement."""

    demonstration_episodes: int = 40
    demonstration_difficulties: List[float] = field(default_factory=lambda: [0.3, 0.5, 0.7])
    bc_epochs: int = 8
    bc_learning_rate: float = 1e-3
    # Measured, not guessed: 12 iterations at 32 envs x 128 steps takes ~4.5
    # minutes on a 16-core CPU and reaches combatSkill ~76 from a cold start.
    # 30 was the initial guess and roughly tripled the runtime for no
    # measurable gain on this environment.
    ppo_iterations: int = 12
    ppo_num_envs: int = 32
    ppo_steps_per_env: int = 128
    ppo_learning_rate: float = 3e-4
    ppo_entropy_coef: float = 0.01
    ppo_difficulties: List[float] = field(default_factory=lambda: [0.3, 0.5, 0.7])
    eval_episodes_per_difficulty: int = 10
    seed: int = 0

    def to_dict(self) -> Dict[str, Any]:
        return {
            'demonstrationEpisodes': self.demonstration_episodes,
            'demonstrationDifficulties': self.demonstration_difficulties,
            'bcEpochs': self.bc_epochs,
            'bcLearningRate': self.bc_learning_rate,
            'ppoIterations': self.ppo_iterations,
            'ppoNumEnvs': self.ppo_num_envs,
            'ppoStepsPerEnv': self.ppo_steps_per_env,
            'ppoLearningRate': self.ppo_learning_rate,
            'ppoEntropyCoef': self.ppo_entropy_coef,
            'ppoDifficulties': self.ppo_difficulties,
            'evalEpisodesPerDifficulty': self.eval_episodes_per_difficulty,
            'seed': self.seed,
        }


@dataclass
class ProgressEvent:
    stage: str
    stage_step: int
    stage_total: int
    overall_fraction: float
    detail: Dict[str, Any]


ProgressFn = Callable[[ProgressEvent], None]


@dataclass
class TrainingOutcome:
    baseline: EvaluationReport
    final: EvaluationReport
    bc_result: BCResult
    ppo_result: PPOResult
    checkpoint_path: str
    checkpoint_digest: str
    demonstration_digest: str
    demonstration_stats: Dict[str, float]
    plan: TrainingPlan
    target_metric: str
    target_value: Optional[int]
    achieved_value: int
    target_met: Optional[bool]

    def summary(self) -> Dict[str, Any]:
        return {
            'targetMetric': self.target_metric,
            'targetValue': self.target_value,
            'baselineValue': _metric_of(self.baseline, self.target_metric),
            'achievedValue': self.achieved_value,
            'targetMet': self.target_met,
            'checkpointDigest': self.checkpoint_digest,
            'demonstrationDigest': self.demonstration_digest,
            'demonstrationStats': self.demonstration_stats,
            'plan': self.plan.to_dict(),
            'baselineReport': self.baseline.to_dict(),
            'finalReport': self.final.to_dict(),
            'baselineReportDigest': self.baseline.report_digest(),
            'finalReportDigest': self.final.report_digest(),
            'bc': {
                'epochs': self.bc_result.epochs,
                'finalTrainLoss': self.bc_result.final_train_loss,
                'finalValLoss': self.bc_result.final_val_loss,
                'valAccuracy': self.bc_result.val_accuracy,
                'samples': self.bc_result.samples,
            },
            'ppo': {
                'iterations': self.ppo_result.iterations,
                'totalEnvSteps': self.ppo_result.total_env_steps,
                'finalMeanReturn': self.ppo_result.final_mean_return,
                'finalWinRate': self.ppo_result.final_win_rate,
            },
        }


def _metric_of(report: EvaluationReport, metric: str) -> int:
    """Resolve a target metric name against a report. Raises on unknown names."""
    if metric in ('combatSkill', 'combat_skill'):
        return report.measurement.combat_skill

    traits = report.measurement.traits.to_dict()
    if metric in traits:
        value = traits[metric]
        if value is None:
            raise ValueError(
                f"Trait '{metric}' is not measurable in this environment and cannot be a job target"
            )
        return value

    raise ValueError(f'Unknown target metric: {metric}')


def _emit(on_progress: Optional[ProgressFn], stage: str, step: int, total: int, detail: Dict[str, Any]) -> None:
    if on_progress is None:
        return

    completed_weight = 0.0
    for name, weight in STAGE_WEIGHTS.items():
        if name == stage:
            break
        completed_weight += weight

    fraction = completed_weight + STAGE_WEIGHTS[stage] * (step / total if total else 1.0)
    on_progress(ProgressEvent(stage, step, total, min(1.0, fraction), detail))


def run_training_job(
    *,
    checkpoint_path: str,
    trainer_checkpoint_path: Optional[str],
    eval_seed_root: int,
    target_metric: str = 'combatSkill',
    target_value: Optional[int] = None,
    plan: Optional[TrainingPlan] = None,
    student_checkpoint_path: Optional[str] = None,
    on_progress: Optional[ProgressFn] = None,
    should_stop: Optional[Callable[[], bool]] = None,
) -> TrainingOutcome:
    """
    Execute one complete trait-training job.

    `trainer_checkpoint_path` is Agent B's own policy — the asset it sells. When
    absent (cold start, no trained provider yet) a deterministic scripted policy
    stands in, and that is recorded in the outcome so the evidence bundle never
    implies a trained trainer was used.
    """
    plan = plan or TrainingPlan()
    torch.manual_seed(plan.seed)

    # ── Student model: continue an existing policy, or start fresh ────────────
    if student_checkpoint_path:
        model = ArenaActorCritic.load(student_checkpoint_path)
    else:
        model = ArenaActorCritic()

    # ── Stage 1: baseline ────────────────────────────────────────────────────
    # Measured BEFORE any training, on the same ladder as the final evaluation,
    # so the delta is a like-for-like comparison.
    baseline = evaluate_policy(
        greedy_policy_fn(model),
        seed_root=eval_seed_root,
        episodes_per_difficulty=plan.eval_episodes_per_difficulty,
        on_episode=lambda done, total: _emit(
            on_progress, 'baseline', done, total, {'phase': 'baseline evaluation'}
        ),
    )

    # ── Stage 2: trainer donates demonstrations ──────────────────────────────
    if trainer_checkpoint_path:
        trainer_model = ArenaActorCritic.load(trainer_checkpoint_path)
        trainer_generator = torch.Generator().manual_seed(plan.seed + 1)
        trainer_policy = sampling_policy_fn(trainer_model, trainer_generator, temperature=1.0)
        trainer_kind = 'policy'
    else:
        trainer_policy = ScriptedPolicy(aggression=1.0)
        trainer_kind = 'scripted-baseline'

    demos: DemonstrationSet = collect_demonstrations(
        trainer_policy,
        episodes=plan.demonstration_episodes,
        difficulties=plan.demonstration_difficulties,
        seed=plan.seed + 500,
        on_progress=lambda done, total: _emit(
            on_progress, 'demonstrations', done, total,
            {'phase': 'trainer donating demonstrations', 'trainerKind': trainer_kind},
        ),
    )

    # ── Stage 3: behaviour cloning ───────────────────────────────────────────
    bc_result = train_behaviour_cloning(
        model,
        demos,
        epochs=plan.bc_epochs,
        learning_rate=plan.bc_learning_rate,
        seed=plan.seed + 2,
        on_epoch=lambda step, total, entry: _emit(
            on_progress, 'behaviour_cloning', step, total, {'phase': 'imitating trainer', **entry}
        ),
    )

    # ── Stage 4: PPO curriculum ──────────────────────────────────────────────
    ppo_result = train_ppo(
        model,
        PPOConfig(
            total_iterations=plan.ppo_iterations,
            num_envs=plan.ppo_num_envs,
            steps_per_env=plan.ppo_steps_per_env,
            learning_rate=plan.ppo_learning_rate,
            entropy_coef=plan.ppo_entropy_coef,
            difficulties=tuple(plan.ppo_difficulties),
            seed=plan.seed + 3,
        ),
        on_iteration=lambda step, total, entry: _emit(
            on_progress, 'ppo', step, total, {'phase': 'self-play refinement', **entry}
        ),
        should_stop=should_stop,
    )

    model.save(
        checkpoint_path,
        metadata={
            'plan': plan.to_dict(),
            'trainerKind': trainer_kind,
            'demonstrationDigest': demonstration_digest(demos),
        },
    )

    # ── Stage 5: final evaluation ────────────────────────────────────────────
    # Loaded back from disk on purpose: this evaluates the artifact that will
    # actually be delivered, not the in-memory model that produced it.
    final_model = ArenaActorCritic.load(checkpoint_path)
    final = evaluate_policy(
        greedy_policy_fn(final_model),
        seed_root=eval_seed_root,
        episodes_per_difficulty=plan.eval_episodes_per_difficulty,
        checkpoint_path=checkpoint_path,
        on_episode=lambda done, total: _emit(
            on_progress, 'final_evaluation', done, total, {'phase': 'final evaluation'}
        ),
    )

    achieved = _metric_of(final, target_metric)

    return TrainingOutcome(
        baseline=baseline,
        final=final,
        bc_result=bc_result,
        ppo_result=ppo_result,
        checkpoint_path=checkpoint_path,
        checkpoint_digest=checkpoint_digest(checkpoint_path),
        demonstration_digest=demonstration_digest(demos),
        demonstration_stats={
            'episodes': float(demos.episodes),
            'transitions': float(len(demos)),
            'meanReturn': demos.mean_return,
            'winRate': demos.win_rate,
        },
        plan=plan,
        target_metric=target_metric,
        target_value=target_value,
        achieved_value=achieved,
        target_met=None if target_value is None else achieved >= target_value,
    )
