# trait_training

Real trait training for the A2A marketplace. Agent B trains Agent A's traits by
**donating its own learned policy as demonstrations**; traits are then
**measured** from behaviour in a seeded evaluation, never assigned.

See [`docs/architecture/A2A_MARKETPLACE_BASE.md`](../../docs/architecture/A2A_MARKETPLACE_BASE.md).

## What this replaces

| Was | Now |
|---|---|
| `workers/training-worker/src/rl_trainer.py` — trained **CartPole-v1**, slept 2s, returned hardcoded `episode_reward_mean: 250.3` | Real PPO on `AIArenaBattleEnv` |
| `workers/training-worker/src/behaviour_cloning.py` — every real line commented out, slept 2s, returned hardcoded `loss: 0.342, accuracy: 0.876` | Real cross-entropy BC with a held-out split |
| `TrainingPage.tsx: progressFromStatus()` — QUEUED→18%, RUNNING→64% | Worker-reported `progress`, `stage`, and live metrics |

Both stub trainers are left in place untouched — they are still referenced by
the separate `LORA_FINETUNE` (0G Compute) path — but nothing in trait training
calls them.

## Pipeline

```
baseline evaluation
  → trainer donates demonstrations   (its own policy, sampled)
  → behaviour cloning                (student imitates trainer)
  → PPO curriculum                   (trainer chooses the difficulty ladder)
  → final evaluation                 (seeded, greedy, reproducible)
  → delta
```

The trainer can **fail**. Nothing nudges the score toward the target; the final
evaluation independently measures whatever training produced, and a job whose
target is not met settles as a refund.

## Why the trainer's capability is economically real

`tests/test_trainer_quality_matters.py` is the executable form of the
marketplace premise. A teacher that only idles, and one that attacks from out
of range, both produce measurably worse students than a competent teacher
through the identical pipeline. If those tests ever fail, paying more for a
better trainer is irrational and the job requirements are decoration.

## Measured results (16-core CPU, no GPU)

Cold start (randomly initialised policy), demo budget of 12 PPO iterations ×
32 envs × 128 steps:

| metric | before | after |
|---|---:|---:|
| **combatSkill** | 0 | **76** |
| precision | 0 | 63 |
| resilience | 0 | 78 |
| aggression | 0 | 100 |
| patience | 31 | 11 |
| creativity | 14 | 10 |

**~4.5 minutes wall clock.** No GPU, no Ray, no 0G fine-tuning CLI.

A baseline of 0 is expected rather than suspicious: greedy action selection on
an untrained network picks a constant action, so it never attacks and scores 0
on every offensive component.

> **The numbers above were measured under `eval-v1`** (ladder `[0.3, 0.5, 0.7,
> 0.9]`). That ladder was replaced in Phase 3 — see below — so re-measure before
> quoting them.

## The ladder was fixed in Phase 3 (eval-v2)

`eval-v1` had a real flaw: a trained policy won 40/40 across the whole ladder,
so `winRate` contributed a flat 0.30 to every competent agent and capability
profiles bunched together — which breaks matching, since a job asking for
"combat skill >= 90" could not separate candidates.

`scripts/difficulty_sweep.py` measured three quality tiers at ten difficulties
and found that 0.3/0.5 are won by everyone, 3.0+ by nobody, and competent
agents only separate at 2.0. `eval-v2` is **`[0.7, 0.9, 1.5, 2.0]`**. Absolute
scores are lower, deliberately: that is headroom for genuinely better agents.

2.5 was in the first draft and dropped — a competent policy scored 0.25 at one
seed root and 0.00 at another, so it added variance rather than signal.

Note this bumped `EVAL_PROTOCOL_VERSION`, not `CAPABILITY_FORMULA_VERSION`: the
ladder is part of the evaluation protocol, the weights are the formula. Keeping
them separate is what made this change expressible without invalidating the
trait weights.

## Honest limitations

- **Trained policies are one-note.** `adaptability` and `creativity` land near 0
  because the winning strategy is "attack when in range" — the agent never needs
  to flee or heal. That is a faithful measurement of a degenerate-but-effective
  policy, not a bug in the metric.
- **`loyalty` and `deception` are not measurable here** (no allies, no hidden
  information). They return `None`, are preserved from the agent's existing
  values, and cannot be job targets — `run_training_job` raises on an attempt.
- **BC does most of the work** against a good scripted teacher; PPO refines. In
  the marketplace that is the point — the teacher's quality is the product.

## Reproducibility

The escrow settles against these numbers, so reproducibility is load-bearing:

- **Greedy (argmax) action selection** during evaluation — no sampling RNG.
- **Hash-derived seeds** from a `seed_root`, so one leaked seed does not reveal
  the ladder (threat T18). The root is withheld until the checkpoint is
  submitted.
- **Threads pinned to 1 during evaluation only**
  (`evaluate.deterministic_inference`). Multi-threaded CPU matmuls reduce in
  nondeterministic order, and a near-tie resolved differently flips an argmax,
  which cascades into a different score. Training is deliberately *not* pinned —
  its output is a checkpoint, measured deterministically afterwards. Pinning
  training too made it ~8× slower on a 16-core host for no benefit.
- **`traits.measure()` is a pure function** — no clock, no RNG, no I/O.
- **Checkpoint and report digests** (`sha256:…`) are what get committed
  on-chain, so the artifact delivered is provably the artifact measured.

Bump `CAPABILITY_FORMULA_VERSION` on any formula change and never mutate a
published version — verification of already-settled jobs must keep working.

## Running it

```bash
docker build -f ml/trait_training/Dockerfile.test -t kult-trait-training ml/
```

```bash
docker run --rm kult-trait-training
```

```bash
docker run --rm kult-trait-training python trait_training/scripts/demo_training_run.py
```

38 tests, no network or database required.

## Layout

| File | Role |
|---|---|
| `rollout.py` | Instrumented episode runner → `EpisodeMetrics`. Does not modify `AIArenaBattleEnv` |
| `traits.py` | `EpisodeMetrics[]` → traits + combatSkill (`cap-v1`). Pure |
| `policy.py` | `ArenaActorCritic` (reuses `BCPolicyNetwork` verbatim) + value head, digests |
| `demonstrations.py` | Trainer rolls out its own policy and donates trajectories |
| `bc.py` | Behaviour cloning |
| `ppo.py` | Compact PPO over a synchronous vector env |
| `evaluate.py` | Seeded evaluation → `EvaluationReport` |
| `pipeline.py` | End-to-end job with real progress events |

### Why not Ray RLlib

`ml/reinforcement_learning/train_ppo.py` (real, untouched) uses Ray. It is not
used here because the whole pipeline must share **one** policy format so the
evaluator provably loads what training produced — RLlib checkpoints its own
internal model, which is not `BCPolicyNetwork`, so BC weights cannot flow into
it. Ray also adds ~1GB of dependencies and multi-second cluster startup for a
32-feature, 7-action environment.
