"""
Measured behaviour -> traits (cap-v1).

This module is the contract the marketplace settles against. Two rules govern
every change to it:

  1. It is a PURE FUNCTION of EpisodeMetrics. No randomness, no clock, no
     database, no network. Given the same episodes it returns the same traits,
     on any machine.
  2. Changing any weight or threshold changes what a job's target MEANS.
     Bump CAPABILITY_FORMULA_VERSION when that happens, and never mutate an
     already-published version — verification of past jobs must stay
     reproducible.

The eight traits are the ones the platform already has (Agent.traits), so a
marketplace-trained agent and a battle-evolved agent stay directly comparable.
Two of them cannot be honestly measured in this environment and are documented
as such rather than being filled with plausible noise:

  - loyalty:  no allies, no betrayal option -> not measurable here
  - deception: no feinting or hidden information -> not measurable here

Both are returned as None. Callers preserve the agent's existing values for
these; a trainer cannot move them, and a job cannot target them.
"""

from __future__ import annotations

from dataclasses import dataclass
from math import log
from typing import Dict, List, Optional

from environment import ACTION_VOCAB

from .rollout import EpisodeMetrics

CAPABILITY_FORMULA_VERSION = 'cap-v1'

# combatSkill weights. Sum to 1.0 — asserted in tests so a future edit that
# forgets to rebalance fails loudly rather than silently rescaling the metric.
COMBAT_SKILL_WEIGHTS = {
    'precision': 0.35,
    'win_rate': 0.30,
    'survivability': 0.20,
    'efficiency': 0.15,
}

# Damage per step at which `efficiency` saturates. Derived from the env: a
# landed ATTACK does 0.05-0.15 (mean 0.10) and ABILITY_1 does 0.10-0.25, so
# ~0.10/step is near the practical ceiling for sustained aggression.
EFFICIENCY_SATURATION_DPS = 0.10

# Episode length treated as "patient". max_steps is 300 and a decisive win
# lands well before then; surviving ~half the cap indicates a measured fight.
PATIENCE_SATURATION_STEPS = 150.0


@dataclass
class MeasuredTraits:
    """Traits in the platform's 0-100 scale. None = not measurable in this env."""

    aggression: int
    patience: int
    adaptability: int
    resilience: int
    creativity: int
    precision: int
    loyalty: Optional[int] = None
    deception: Optional[int] = None

    def to_dict(self) -> Dict[str, Optional[int]]:
        return {
            'aggression': self.aggression,
            'patience': self.patience,
            'adaptability': self.adaptability,
            'resilience': self.resilience,
            'creativity': self.creativity,
            'precision': self.precision,
            'loyalty': self.loyalty,
            'deception': self.deception,
        }

    def measurable(self) -> Dict[str, int]:
        return {k: v for k, v in self.to_dict().items() if v is not None}


@dataclass
class CapabilityMeasurement:
    formula_version: str
    combat_skill: int
    traits: MeasuredTraits
    components: Dict[str, float]
    counters: Dict[str, float]

    def to_dict(self) -> Dict[str, object]:
        return {
            'formulaVersion': self.formula_version,
            'combatSkill': self.combat_skill,
            'traits': self.traits.to_dict(),
            'components': self.components,
            'counters': self.counters,
        }


def _clamp_score(value: float) -> int:
    """Map a 0..1 ratio onto the platform's 0-100 integer trait scale."""
    return int(round(max(0.0, min(1.0, value)) * 100))


def _safe_ratio(numerator: float, denominator: float, default: float = 0.0) -> float:
    return numerator / denominator if denominator > 0 else default


def _normalized_action_entropy(action_counts: List[int]) -> float:
    """
    Shannon entropy of the action distribution, normalized to 0..1.

    Measures behavioural variety: an agent that only ever presses ATTACK scores
    0, one that uses its whole toolkit scores near 1. Normalizing by
    log(len(ACTION_VOCAB)) keeps it comparable if the vocabulary ever grows.
    """
    total = sum(action_counts)
    if total <= 0:
        return 0.0

    entropy = 0.0
    for count in action_counts:
        if count > 0:
            p = count / total
            entropy -= p * log(p)

    return entropy / log(len(ACTION_VOCAB))


def aggregate_counters(episodes: List[EpisodeMetrics]) -> Dict[str, float]:
    """Sum/average raw counters across episodes. Provenance for the scores."""
    if not episodes:
        raise ValueError('Cannot measure traits from zero episodes')

    n = len(episodes)
    action_counts = [0] * len(ACTION_VOCAB)
    for ep in episodes:
        for i, c in enumerate(ep.action_counts):
            action_counts[i] += c

    return {
        'episodes': float(n),
        'wins': float(sum(1 for e in episodes if e.won)),
        'total_steps': float(sum(e.steps for e in episodes)),
        'attack_attempts': float(sum(e.attack_attempts for e in episodes)),
        'attack_hits': float(sum(e.attack_hits for e in episodes)),
        'ability_attempts': float(sum(e.ability_attempts for e in episodes)),
        'ability_hits': float(sum(e.ability_hits for e in episodes)),
        'damage_dealt': float(sum(e.damage_dealt for e in episodes)),
        'damage_taken': float(sum(e.damage_taken for e in episodes)),
        'mean_hp_retained': float(sum(e.hp_retained for e in episodes) / n),
        'mean_steps': float(sum(e.steps for e in episodes) / n),
        'flee_uses': float(sum(e.flee_uses for e in episodes)),
        'flee_while_low_hp': float(sum(e.flee_while_low_hp for e in episodes)),
        'heal_uses': float(sum(e.heal_uses for e in episodes)),
        'heal_while_useful': float(sum(e.heal_while_useful for e in episodes)),
        'defend_uses': float(sum(e.defend_uses for e in episodes)),
        'idle_uses': float(sum(e.idle_uses for e in episodes)),
        'action_entropy': _normalized_action_entropy(action_counts),
        'mean_reward': float(sum(e.total_reward for e in episodes) / n),
    }


def measure(episodes: List[EpisodeMetrics]) -> CapabilityMeasurement:
    """Derive traits and combatSkill from measured episodes. Pure."""
    c = aggregate_counters(episodes)

    offensive_attempts = c['attack_attempts'] + c['ability_attempts']
    offensive_hits = c['attack_hits'] + c['ability_hits']

    # ── Components (each 0..1) ────────────────────────────────────────────────
    precision = _safe_ratio(offensive_hits, offensive_attempts)
    win_rate = _safe_ratio(c['wins'], c['episodes'])
    survivability = max(0.0, min(1.0, c['mean_hp_retained']))
    efficiency = min(1.0, _safe_ratio(c['damage_dealt'], c['total_steps']) / EFFICIENCY_SATURATION_DPS)

    combat_skill = (
        COMBAT_SKILL_WEIGHTS['precision'] * precision
        + COMBAT_SKILL_WEIGHTS['win_rate'] * win_rate
        + COMBAT_SKILL_WEIGHTS['survivability'] * survivability
        + COMBAT_SKILL_WEIGHTS['efficiency'] * efficiency
    )

    # ── Traits ────────────────────────────────────────────────────────────────
    # aggression: share of steps spent attacking rather than waiting.
    aggression = _safe_ratio(offensive_attempts, c['total_steps'])

    # patience: willingness to fight a long engagement rather than trading
    # everything immediately.
    patience = min(1.0, c['mean_steps'] / PATIENCE_SATURATION_STEPS)

    # adaptability: were the situational actions used at the right moments?
    # Unused tools score 0 rather than a free pass — an agent that never flees
    # and never heals has not demonstrated adaptability.
    situational_uses = c['flee_uses'] + c['heal_uses']
    situational_correct = c['flee_while_low_hp'] + c['heal_while_useful']
    adaptability = _safe_ratio(situational_correct, situational_uses)

    # resilience: damage absorbed while still winning. Taking hits and winning
    # anyway is resilient; taking no hits is precision, credited elsewhere.
    damage_per_episode = _safe_ratio(c['damage_taken'], c['episodes'])
    resilience = win_rate * min(1.0, 0.5 + damage_per_episode)

    # creativity: behavioural variety.
    creativity = c['action_entropy']

    return CapabilityMeasurement(
        formula_version=CAPABILITY_FORMULA_VERSION,
        combat_skill=_clamp_score(combat_skill),
        traits=MeasuredTraits(
            aggression=_clamp_score(aggression),
            patience=_clamp_score(patience),
            adaptability=_clamp_score(adaptability),
            resilience=_clamp_score(resilience),
            creativity=_clamp_score(creativity),
            precision=_clamp_score(precision),
            loyalty=None,
            deception=None,
        ),
        components={
            'precision': precision,
            'winRate': win_rate,
            'survivability': survivability,
            'efficiency': efficiency,
        },
        counters=c,
    )
