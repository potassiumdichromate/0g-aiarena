"""
Instrumented episode rollout.

Measures what an agent actually DID, purely from observable transitions.
AIArenaBattleEnv is deliberately not modified — it is shared with the existing
Ray RLlib entrypoint, and an evaluation harness that needs a patched
environment is not one an outside party can reproduce.

Hit detection: the env's info dict reports agent_hp/enemy_hp after each step,
so an ATTACK that reduced enemy_hp landed and one that did not, missed. That
mirrors `_apply_action`'s own `dist < 0.3` rule without depending on it.
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any, Callable, Dict, List, Optional

import numpy as np

from environment import AIArenaBattleEnv, ACTION_VOCAB

ATTACK = ACTION_VOCAB.index('ATTACK')
DEFEND = ACTION_VOCAB.index('DEFEND')
FLEE = ACTION_VOCAB.index('FLEE')
ABILITY_1 = ACTION_VOCAB.index('ABILITY_1')
ABILITY_2 = ACTION_VOCAB.index('ABILITY_2')
IDLE = ACTION_VOCAB.index('IDLE')

# An agent below this HP fraction is "in danger" — used to judge whether FLEE
# and the ABILITY_2 heal were used at sensible moments rather than at random.
LOW_HP_THRESHOLD = 0.3
HEAL_USEFUL_THRESHOLD = 0.7

# Chooses an action from an observation. Kept as a plain callable so the
# harness never depends on torch — a scripted baseline is a valid policy here.
PolicyFn = Callable[[np.ndarray], int]


@dataclass
class EpisodeMetrics:
    """Observable behaviour of one episode. No derived scores — see traits.py."""

    seed: int
    difficulty: float
    steps: int
    won: bool
    total_reward: float

    attack_attempts: int = 0
    attack_hits: int = 0
    ability_attempts: int = 0
    ability_hits: int = 0

    damage_dealt: float = 0.0
    damage_taken: float = 0.0
    hp_retained: float = 0.0

    flee_uses: int = 0
    flee_while_low_hp: int = 0
    heal_uses: int = 0
    heal_while_useful: int = 0
    defend_uses: int = 0
    idle_uses: int = 0

    action_counts: List[int] = field(default_factory=lambda: [0] * len(ACTION_VOCAB))

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


def run_episode(
    policy: PolicyFn,
    seed: int,
    difficulty: float,
    max_steps: int = 300,
) -> EpisodeMetrics:
    """Run one fully deterministic episode, given a deterministic policy."""
    env = AIArenaBattleEnv({'difficulty': difficulty, 'max_steps': max_steps})
    obs, _ = env.reset(seed=seed)

    metrics = EpisodeMetrics(
        seed=seed, difficulty=difficulty, steps=0, won=False, total_reward=0.0,
    )

    prev_agent_hp = 1.0
    prev_enemy_hp = 1.0

    while True:
        action = int(policy(obs))
        obs, reward, terminated, truncated, info = env.step(action)

        agent_hp = float(info['agent_hp'])
        enemy_hp = float(info['enemy_hp'])
        dealt = max(0.0, prev_enemy_hp - enemy_hp)
        taken = max(0.0, prev_agent_hp - agent_hp)

        metrics.steps += 1
        metrics.total_reward += float(reward)
        metrics.damage_dealt += dealt
        metrics.damage_taken += taken
        metrics.action_counts[action] += 1

        if action == ATTACK:
            metrics.attack_attempts += 1
            if dealt > 0:
                metrics.attack_hits += 1
        elif action == ABILITY_1:
            # A cooldown-blocked ability still counts as an attempt: spending a
            # turn on an unavailable ability is exactly the imprecision we want
            # `precision` to capture.
            metrics.ability_attempts += 1
            if dealt > 0:
                metrics.ability_hits += 1
        elif action == FLEE:
            metrics.flee_uses += 1
            # Judged against HP *before* the step — what the agent could see
            # when it decided.
            if prev_agent_hp < LOW_HP_THRESHOLD:
                metrics.flee_while_low_hp += 1
        elif action == ABILITY_2:
            metrics.heal_uses += 1
            if prev_agent_hp < HEAL_USEFUL_THRESHOLD:
                metrics.heal_while_useful += 1
        elif action == DEFEND:
            metrics.defend_uses += 1
        elif action == IDLE:
            metrics.idle_uses += 1

        prev_agent_hp = agent_hp
        prev_enemy_hp = enemy_hp

        if terminated or truncated:
            metrics.won = enemy_hp <= 0 and agent_hp > 0
            metrics.hp_retained = max(0.0, agent_hp)
            break

    return metrics


def run_episodes(
    policy: PolicyFn,
    seeds: List[int],
    difficulties: List[float],
    max_steps: int = 300,
    on_episode: Optional[Callable[[int, EpisodeMetrics], None]] = None,
) -> List[EpisodeMetrics]:
    """
    Run the full cross-product of seeds x difficulties.

    The cross-product (rather than zipping) is what makes the evaluation a
    *ladder*: every difficulty is faced with the same seeds, so a score cannot
    improve merely by being handed easier draws.
    """
    results: List[EpisodeMetrics] = []
    for difficulty in difficulties:
        for seed in seeds:
            episode = run_episode(policy, seed=seed, difficulty=difficulty, max_steps=max_steps)
            results.append(episode)
            if on_episode is not None:
                on_episode(len(results), episode)
    return results
