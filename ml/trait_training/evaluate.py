"""
Seeded evaluation — the deliverable's verification step.

Everything here is designed so a third party with the checkpoint can reproduce
the score exactly:

  - Greedy (argmax) action selection: no sampling RNG.
  - Explicit seed list and difficulty ladder, recorded in the report.
  - Traits derived by traits.py, a pure function.
  - Report hashed with byte-stable JSON; that hash is what the escrow commits.

The seed list is generated from a `seed_root` that the marketplace withholds
until the provider has submitted its checkpoint (threat T18). A provider that
knew the evaluation seeds in advance could overfit to them, which is the same
failure as training on the test set.
"""

from __future__ import annotations

import contextlib
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional

import torch

from .policy import ArenaActorCritic, greedy_policy_fn, checkpoint_digest, canonical_json_digest
from .rollout import run_episodes
from .traits import CAPABILITY_FORMULA_VERSION, CapabilityMeasurement, measure


@contextlib.contextmanager
def deterministic_inference():
    """
    Pin torch to a single thread for the duration of an evaluation.

    Multi-threaded CPU matmuls reduce in a nondeterministic order, so the same
    weights can produce logits that differ in the last bits between machines
    with different core counts. Almost always harmless — but this policy picks
    actions by argmax, and a near-tie resolved differently flips an action,
    which cascades into a different episode and a different score.

    A verifier re-running a job on different hardware MUST get the same number,
    so evaluation is pinned. Training is deliberately NOT pinned: its output is
    a checkpoint, which is then measured deterministically regardless of how
    many cores produced it.
    """
    previous = torch.get_num_threads()
    torch.set_num_threads(1)
    try:
        yield
    finally:
        torch.set_num_threads(previous)

# The standard ladder. Fixed across all jobs so scores are comparable between
# agents; a per-job ladder would make "combat skill 73" mean different things.
#
# Chosen from measurement, not intuition — see scripts/difficulty_sweep.py,
# which evaluates policies of deliberately different quality at each rung and
# reports how far apart they land:
#
#   difficulty   weak    scripted   trained     verdict
#      0.3       1.00      1.00      1.00       everyone wins — no information
#      0.5       1.00      1.00      1.00       everyone wins — no information
#      0.7       0.62      1.00      1.00       separates weak from competent
#      0.9       0.00      1.00      1.00       separates weak from competent
#      1.5       0.00      1.00      1.00       headroom
#      2.0       0.00      0.50      0.38       separates competent from excellent
#      2.5       0.00      0.25      0.00       too hard — seed-dependent, near-zero
#      3.0+      0.00      0.00      0.00       nobody wins — no information
#
# 2.5 was in the first draft of this ladder and was dropped: a competent policy
# scored 0.25 at one seed root and 0.00 at another, so the rung mostly returns
# zero and adds variance rather than signal. 2.0 is the hardest rung that a
# competent agent reliably wins some of the time.
#
# eval-v1 was [0.3, 0.5, 0.7, 0.9], which spent half its rungs where every
# competent agent wins and had no rung above 0.9 at all. Every trained agent
# therefore scored winRate 1.0, capability profiles bunched together, and a job
# asking for "combat skill >= 90" could not separate candidates — which is
# precisely what matching depends on.
#
# Raising the ceiling lowers absolute scores (a policy that scored 76 under
# eval-v1 scores lower here) and that is the point: it leaves headroom for
# genuinely better agents instead of saturating at the top.
STANDARD_DIFFICULTIES = [0.7, 0.9, 1.5, 2.0]
STANDARD_EPISODES_PER_DIFFICULTY = 10
STANDARD_MAX_STEPS = 300

# Bumped from eval-v1 with the ladder change. Scores under different protocol
# versions are NOT comparable, and a settled job must always be re-verifiable
# under the protocol it was settled with — so never edit a published version.
EVAL_PROTOCOL_VERSION = 'eval-v2'


@dataclass
class EvaluationReport:
    protocol_version: str
    formula_version: str
    seed_root: int
    seeds: List[int]
    difficulties: List[float]
    episodes_run: int
    measurement: CapabilityMeasurement
    checkpoint_digest: Optional[str]

    def to_dict(self) -> Dict[str, Any]:
        return {
            'protocolVersion': self.protocol_version,
            'formulaVersion': self.formula_version,
            'seedRoot': self.seed_root,
            'seeds': self.seeds,
            'difficulties': self.difficulties,
            'episodesRun': self.episodes_run,
            'checkpointDigest': self.checkpoint_digest,
            **self.measurement.to_dict(),
        }

    def report_digest(self) -> str:
        return canonical_json_digest(self.to_dict())


def derive_seeds(seed_root: int, count: int) -> List[int]:
    """
    Deterministic seed list from a single root.

    A plain arithmetic sequence would let a provider guess the whole ladder
    from one leaked seed, so seeds are drawn from a hash of the root. Anyone
    given the root can regenerate them; nobody can predict them without it.
    """
    import hashlib

    seeds: List[int] = []
    for index in range(count):
        digest = hashlib.sha256(f'{seed_root}:{index}'.encode('utf-8')).digest()
        seeds.append(int.from_bytes(digest[:4], 'big'))
    return seeds


def evaluate_policy(
    policy: Callable,
    seed_root: int,
    episodes_per_difficulty: int = STANDARD_EPISODES_PER_DIFFICULTY,
    difficulties: Optional[List[float]] = None,
    max_steps: int = STANDARD_MAX_STEPS,
    checkpoint_path: Optional[str] = None,
    on_episode: Optional[Callable[[int, int], None]] = None,
) -> EvaluationReport:
    """Run the standard evaluation and measure the resulting behaviour."""
    ladder = list(difficulties if difficulties is not None else STANDARD_DIFFICULTIES)
    seeds = derive_seeds(seed_root, episodes_per_difficulty)
    total = len(seeds) * len(ladder)

    with deterministic_inference():
        episodes = run_episodes(
            policy,
            seeds=seeds,
            difficulties=ladder,
            max_steps=max_steps,
            on_episode=(lambda done, _ep: on_episode(done, total)) if on_episode else None,
        )

    return EvaluationReport(
        protocol_version=EVAL_PROTOCOL_VERSION,
        formula_version=CAPABILITY_FORMULA_VERSION,
        seed_root=seed_root,
        seeds=seeds,
        difficulties=ladder,
        episodes_run=len(episodes),
        measurement=measure(episodes),
        checkpoint_digest=checkpoint_digest(checkpoint_path) if checkpoint_path else None,
    )


def evaluate_checkpoint(
    checkpoint_path: str,
    seed_root: int,
    episodes_per_difficulty: int = STANDARD_EPISODES_PER_DIFFICULTY,
    difficulties: Optional[List[float]] = None,
    on_episode: Optional[Callable[[int, int], None]] = None,
) -> EvaluationReport:
    """
    Load a checkpoint from disk and evaluate it.

    This is the entrypoint the verifier uses in Phase 7 — it deliberately takes
    a file path and a seed root and nothing else, so it can be run by anyone
    holding the published artifacts.
    """
    model = ArenaActorCritic.load(checkpoint_path)
    return evaluate_policy(
        greedy_policy_fn(model),
        seed_root=seed_root,
        episodes_per_difficulty=episodes_per_difficulty,
        difficulties=difficulties,
        checkpoint_path=checkpoint_path,
        on_episode=on_episode,
    )
