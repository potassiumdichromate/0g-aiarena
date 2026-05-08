"""
Reward shaping utilities for AI Arena RL training.
Provides dense reward signals to accelerate convergence.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Dict


@dataclass
class RewardConfig:
    kill_reward: float = 10.0
    death_penalty: float = -10.0
    damage_dealt_scale: float = 5.0
    damage_received_scale: float = -2.0
    step_penalty: float = -0.01
    survival_bonus_per_step: float = 0.005
    aggression_bonus: float = 0.1
    idle_penalty: float = -0.05
    low_health_flee_bonus: float = 0.03
    health_threshold_for_flee: float = 0.25
    ability_use_bonus: float = 0.15


def compute_reward(
    action: str,
    prev_agent_hp: float,
    curr_agent_hp: float,
    prev_enemy_hp: float,
    curr_enemy_hp: float,
    step: int,
    terminated: bool,
    won: bool,
    config: RewardConfig | None = None,
) -> float:
    """Compute shaped reward for a single step transition."""
    cfg = config or RewardConfig()
    r = cfg.step_penalty

    # Damage dealt
    dmg_dealt = max(0.0, prev_enemy_hp - curr_enemy_hp)
    r += dmg_dealt * cfg.damage_dealt_scale

    # Damage received
    dmg_received = max(0.0, prev_agent_hp - curr_agent_hp)
    r += dmg_received * cfg.damage_received_scale

    # Survival bonus
    r += cfg.survival_bonus_per_step

    # Action-specific bonuses
    if action == "ATTACK" and dmg_dealt > 0:
        r += cfg.aggression_bonus
    elif action == "IDLE":
        r += cfg.idle_penalty
    elif action in ("ABILITY_1", "ABILITY_2"):
        r += cfg.ability_use_bonus
    elif action == "FLEE" and curr_agent_hp < cfg.health_threshold_for_flee:
        r += cfg.low_health_flee_bonus

    # Terminal rewards
    if terminated:
        r += cfg.kill_reward if won else cfg.death_penalty

    return float(r)


class CumulativeRewardTracker:
    """Tracks reward statistics across an episode for curriculum learning."""

    def __init__(self):
        self.reset()

    def reset(self):
        self._total = 0.0
        self._steps = 0
        self._damage_dealt = 0.0
        self._damage_received = 0.0
        self._kills = 0

    def record(self, reward: float, dmg_dealt: float = 0.0, dmg_received: float = 0.0):
        self._total += reward
        self._steps += 1
        self._damage_dealt += dmg_dealt
        self._damage_received += dmg_received

    def record_kill(self):
        self._kills += 1

    def summary(self) -> Dict[str, float]:
        return {
            "total_reward": self._total,
            "mean_reward": self._total / max(1, self._steps),
            "steps": self._steps,
            "damage_dealt": self._damage_dealt,
            "damage_received": self._damage_received,
            "kills": self._kills,
            "kd_ratio": self._kills / max(1, self._damage_received),
        }
