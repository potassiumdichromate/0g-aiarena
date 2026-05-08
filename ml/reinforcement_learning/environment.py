"""
AI Arena battle environment for reinforcement learning.
Implements the OpenAI Gym interface for PPO training with Ray RLlib.
"""
from __future__ import annotations

import random
from typing import Any, Dict, Optional, Tuple

import numpy as np
import gymnasium as gym
from gymnasium import spaces


ACTION_VOCAB = ["ATTACK", "DEFEND", "FLEE", "SUPPORT", "ABILITY_1", "ABILITY_2", "IDLE"]
STATE_DIM = 32


class AIArenaBattleEnv(gym.Env):
    """
    Simulated 1v1 battle environment for training RL agents.

    Observation space: 32-float vector covering health, position, cooldowns, etc.
    Action space: discrete over ACTION_VOCAB
    """

    metadata = {"render_modes": ["human", "rgb_array"], "render_fps": 10}

    def __init__(self, config: Optional[Dict] = None):
        super().__init__()
        cfg = config or {}
        self.max_steps = cfg.get("max_steps", 300)
        self.agent_id = cfg.get("agent_id", "agent_0")
        self.difficulty = cfg.get("difficulty", 0.5)  # 0=easy, 1=hard

        self.observation_space = spaces.Box(
            low=0.0, high=1.0, shape=(STATE_DIM,), dtype=np.float32
        )
        self.action_space = spaces.Discrete(len(ACTION_VOCAB))

        self._step = 0
        self._agent_hp = 1.0
        self._enemy_hp = 1.0
        self._agent_pos = np.array([0.5, 0.0, 0.5], dtype=np.float32)
        self._enemy_pos = np.array([0.5, 0.0, 0.5], dtype=np.float32)
        self._cooldowns = np.zeros(2, dtype=np.float32)
        self._rng = np.random.default_rng()

    def reset(
        self,
        *,
        seed: Optional[int] = None,
        options: Optional[Dict] = None,
    ) -> Tuple[np.ndarray, Dict]:
        super().reset(seed=seed)
        if seed is not None:
            self._rng = np.random.default_rng(seed)

        self._step = 0
        self._agent_hp = 1.0
        self._enemy_hp = 1.0
        self._agent_pos = self._rng.uniform(0.1, 0.9, 3).astype(np.float32)
        self._agent_pos[1] = 0.0
        self._enemy_pos = self._rng.uniform(0.1, 0.9, 3).astype(np.float32)
        self._enemy_pos[1] = 0.0
        self._cooldowns = np.zeros(2, dtype=np.float32)

        return self._get_obs(), {}

    def step(self, action: int) -> Tuple[np.ndarray, float, bool, bool, Dict]:
        self._step += 1
        action_name = ACTION_VOCAB[action]
        reward = self._apply_action(action_name)
        self._simulate_enemy()
        self._cooldowns = np.maximum(0.0, self._cooldowns - 0.1)

        terminated = self._agent_hp <= 0 or self._enemy_hp <= 0
        truncated = self._step >= self.max_steps

        info = {
            "agent_hp": float(self._agent_hp),
            "enemy_hp": float(self._enemy_hp),
            "action": action_name,
            "step": self._step,
        }

        if terminated:
            reward += 10.0 if self._enemy_hp <= 0 else -10.0

        return self._get_obs(), reward, terminated, truncated, info

    def _apply_action(self, action: str) -> float:
        dist = float(np.linalg.norm(self._agent_pos - self._enemy_pos))
        reward = -0.01  # step penalty

        if action == "ATTACK":
            if dist < 0.3:
                dmg = self._rng.uniform(0.05, 0.15)
                self._enemy_hp = max(0.0, self._enemy_hp - dmg)
                reward += dmg * 5.0
            else:
                reward -= 0.05  # missed attack
        elif action == "DEFEND":
            reward += 0.02  # slight survival bonus
        elif action == "FLEE":
            direction = self._agent_pos - self._enemy_pos
            norm = np.linalg.norm(direction)
            if norm > 1e-6:
                self._agent_pos += (direction / norm) * 0.1
            self._agent_pos = np.clip(self._agent_pos, 0.0, 1.0)
            reward += 0.01 if self._agent_hp < 0.3 else -0.02
        elif action == "SUPPORT":
            reward += 0.01
        elif action == "ABILITY_1" and self._cooldowns[0] <= 0:
            dmg = self._rng.uniform(0.1, 0.25)
            self._enemy_hp = max(0.0, self._enemy_hp - dmg)
            self._cooldowns[0] = 3.0
            reward += dmg * 6.0
        elif action == "ABILITY_2" and self._cooldowns[1] <= 0:
            heal = self._rng.uniform(0.05, 0.15)
            self._agent_hp = min(1.0, self._agent_hp + heal)
            self._cooldowns[1] = 5.0
            reward += heal * 3.0
        elif action == "IDLE":
            reward -= 0.03

        return float(reward)

    def _simulate_enemy(self):
        """Simple scripted enemy that tries to approach and attack."""
        direction = self._agent_pos - self._enemy_pos
        norm = np.linalg.norm(direction)
        dist = float(norm)

        if dist > 0.3:
            if norm > 1e-6:
                self._enemy_pos += (direction / norm) * 0.05 * self.difficulty
        else:
            dmg = self._rng.uniform(0.02, 0.08) * self.difficulty
            self._agent_hp = max(0.0, self._agent_hp - dmg)

    def _get_obs(self) -> np.ndarray:
        obs = np.zeros(STATE_DIM, dtype=np.float32)
        obs[0] = self._agent_hp
        obs[1] = self._enemy_hp
        dist = float(np.linalg.norm(self._agent_pos - self._enemy_pos))
        obs[2] = min(dist / 2.0, 1.0)
        obs[3] = self._cooldowns[0] / 5.0
        obs[4] = self._cooldowns[1] / 5.0
        obs[5] = self._step / self.max_steps
        obs[6:9] = self._agent_pos
        obs[9:12] = self._enemy_pos
        return obs

    def render(self):
        print(
            f"Step {self._step:3d} | AgentHP={self._agent_hp:.2f} "
            f"EnemyHP={self._enemy_hp:.2f} "
            f"Pos={self._agent_pos.round(2)}"
        )
