"""
Demo-sized trait-training run — the proof that this is real training.

Prints the before/after with wall-clock timings so the claim "traits are
measured, not written" is checkable rather than asserted:

    docker build -f trait_training/Dockerfile.test -t kult-trait-training ml/
    docker run --rm kult-trait-training python trait_training/scripts/demo_training_run.py

Nothing here nudges the score toward the target. The final number is an
independent seeded measurement of whatever the training actually produced, and
it is free to come out lower than the baseline.
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
import time
from pathlib import Path

from trait_training.pipeline import ProgressEvent, TrainingPlan, run_training_job


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--ppo-iterations', type=int, default=24)
    parser.add_argument('--num-envs', type=int, default=32)
    parser.add_argument('--steps-per-env', type=int, default=128)
    parser.add_argument('--demo-episodes', type=int, default=40)
    parser.add_argument('--target', type=int, default=70)
    parser.add_argument('--seed-root', type=int, default=20260816)
    parser.add_argument('--json-out', type=str, default='')
    args = parser.parse_args()

    plan = TrainingPlan(
        demonstration_episodes=args.demo_episodes,
        ppo_iterations=args.ppo_iterations,
        ppo_num_envs=args.num_envs,
        ppo_steps_per_env=args.steps_per_env,
        eval_episodes_per_difficulty=10,
        seed=0,
    )

    last_stage = {'name': None}
    stage_started = {'at': time.time()}

    def on_progress(event: ProgressEvent) -> None:
        if event.stage != last_stage['name']:
            if last_stage['name'] is not None:
                print(f"    ({time.time() - stage_started['at']:.1f}s)")
            print(f"  {event.stage}", end='', flush=True)
            last_stage['name'] = event.stage
            stage_started['at'] = time.time()

        if event.stage == 'ppo':
            print(
                f"\r  ppo  iter {event.stage_step}/{event.stage_total}"
                f"  winRate={event.detail.get('winRate', 0):.2f}"
                f"  meanReturn={event.detail.get('meanReturn', 0):.1f}"
                f"  difficulty={event.detail.get('difficulty', 0):.1f}   ",
                end='', flush=True,
            )
        elif event.stage_step % max(1, event.stage_total // 4) == 0:
            print('.', end='', flush=True)

    workdir = Path(tempfile.mkdtemp())
    print(f'\nTrait training demo — target combatSkill >= {args.target}')
    print(f'PPO: {args.ppo_iterations} iterations x {args.num_envs} envs x {args.steps_per_env} steps')
    print(f'Evaluation seed root: {args.seed_root}\n')

    started = time.time()
    outcome = run_training_job(
        checkpoint_path=str(workdir / 'student.pt'),
        trainer_checkpoint_path=None,
        eval_seed_root=args.seed_root,
        target_metric='combatSkill',
        target_value=args.target,
        plan=plan,
        on_progress=on_progress,
    )
    elapsed = time.time() - started
    print(f"    ({time.time() - stage_started['at']:.1f}s)")

    base_m = outcome.baseline.measurement
    final_m = outcome.final.measurement

    print(f'\n{"=" * 62}')
    print(f'  Total wall clock: {elapsed:.1f}s')
    print(f'  PPO env steps:    {outcome.ppo_result.total_env_steps:,}')
    print(f'  Demonstrations:   {int(outcome.demonstration_stats["transitions"]):,} transitions '
          f'from {int(outcome.demonstration_stats["episodes"])} episodes')
    print(f'  BC val accuracy:  {outcome.bc_result.val_accuracy:.3f}')
    print(f'{"=" * 62}')
    print(f'  {"metric":<16}{"before":>10}{"after":>10}{"delta":>10}')
    print(f'  {"-" * 44}')

    rows = [('combatSkill', base_m.combat_skill, final_m.combat_skill)]
    before_traits, after_traits = base_m.traits.measurable(), final_m.traits.measurable()
    rows += [(name, before_traits[name], after_traits[name]) for name in sorted(after_traits)]

    for name, before, after in rows:
        delta = after - before
        print(f'  {name:<16}{before:>10}{after:>10}{delta:>+10}')

    print(f'{"=" * 62}')
    print(f'  Target {args.target}: {"MET" if outcome.target_met else "NOT MET"} '
          f'(achieved {outcome.achieved_value})')
    print(f'  Checkpoint: {outcome.checkpoint_digest}')
    print(f'  Final report digest: {outcome.final.report_digest()}')
    print(f'{"=" * 62}\n')

    if args.json_out:
        Path(args.json_out).write_text(json.dumps(outcome.summary(), indent=2))
        print(f'Wrote {args.json_out}\n')

    # Exit 0 regardless of whether the target was met: a missed target is a
    # legitimate outcome of a real training run, not a script failure.
    return 0


if __name__ == '__main__':
    sys.exit(main())
