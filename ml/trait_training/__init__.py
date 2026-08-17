"""
Trait training — the real work Agent B performs for Agent A.

A trained policy is run through a SEEDED evaluation in AIArenaBattleEnv, its
behaviour is measured, and traits are derived from those measurements. Traits
are never assigned: "combat skill 52 -> 73" means the agent demonstrably
behaves differently, and anyone with the checkpoint and the seeds can
reproduce the number.

Pipeline (see pipeline.py):

    trainer policy --demonstrations--> behaviour cloning --> PPO curriculum
                                                                  |
                                             seeded evaluation <--+
                                                     |
                                            measured traits + combatSkill

Why the trainer's capability matters economically: step 1 is the trainer
rolling out ITS OWN policy. A trainer with a weak policy donates weak
demonstrations and produces a weak student. That is the service being bought.

--- Layout note ---
ml/behaviour_cloning and ml/reinforcement_learning are not importable packages
(their modules use flat imports like `from dataset import ...`, which assume
their own directory is on sys.path). Rather than restructure them — which would
break both the existing Ray RLlib entrypoint and the worker — we put them on
sys.path here. Confined to this one file on purpose.
"""

import sys
from pathlib import Path

_ML_ROOT = Path(__file__).resolve().parent.parent
for _sibling in ('behaviour_cloning', 'reinforcement_learning'):
    _path = str(_ML_ROOT / _sibling)
    if _path not in sys.path:
        sys.path.insert(0, _path)

CAPABILITY_FORMULA_VERSION = 'cap-v1'

__all__ = ['CAPABILITY_FORMULA_VERSION']
