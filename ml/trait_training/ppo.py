"""
Compact PPO over a synchronous vector of AIArenaBattleEnv instances.

Why not Ray RLlib (ml/reinforcement_learning/train_ppo.py, left untouched):
the whole pipeline must share ONE policy format so the evaluator provably loads
what training produced. RLlib checkpoints its own internal model, which is not
BCPolicyNetwork, so BC weights cannot flow into it. See policy.py.

Why vectorized: the actor is a 4-layer transformer over 32 tokens. Stepping one
environment at a time means one forward pass per environment step, which is
what would make CPU training slow. Stepping N environments in lockstep turns
that into one BATCHED forward per N steps, which is what keeps a demo-sized
budget in single-digit minutes on CPU.

The curriculum — which difficulties, in what order, for how long — is the
trainer's choice. It is a real lever: too steep and the student never gets
reward signal, too shallow and it never learns to handle a real opponent.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Dict, List, Optional

import numpy as np
import torch
import torch.nn as nn

from environment import AIArenaBattleEnv
from .policy import ArenaActorCritic


@dataclass
class PPOConfig:
    total_iterations: int = 30
    num_envs: int = 32
    steps_per_env: int = 128
    epochs_per_iteration: int = 4
    minibatch_size: int = 512

    learning_rate: float = 3e-4
    gamma: float = 0.99
    gae_lambda: float = 0.95
    clip_range: float = 0.2
    entropy_coef: float = 0.01
    value_coef: float = 0.5
    max_grad_norm: float = 0.5

    max_steps: int = 300
    # Curriculum: difficulty ladder walked across iterations.
    difficulties: tuple = (0.3, 0.5, 0.7)
    seed: int = 0


@dataclass
class PPOResult:
    iterations: int
    total_env_steps: int
    final_mean_return: float
    final_win_rate: float
    history: List[Dict[str, float]]


class SyncVectorEnv:
    """Minimal synchronous vector env. Auto-resets a finished sub-env in place."""

    def __init__(self, num_envs: int, difficulty: float, max_steps: int, seed: int):
        self.num_envs = num_envs
        self.max_steps = max_steps
        self._seed = seed
        self._episode_counter = 0
        self.envs = [AIArenaBattleEnv({'difficulty': difficulty, 'max_steps': max_steps}) for _ in range(num_envs)]
        self.episode_returns = np.zeros(num_envs, dtype=np.float64)
        # Completed-episode stats drained once per iteration.
        self.finished_returns: List[float] = []
        self.finished_wins: List[bool] = []

    def reset(self) -> np.ndarray:
        observations = []
        for i, env in enumerate(self.envs):
            obs, _ = env.reset(seed=self._seed + i)
            observations.append(obs)
        self._episode_counter = self.num_envs
        return np.stack(observations).astype(np.float32)

    def step(self, actions: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        observations = np.zeros((self.num_envs, self.envs[0].observation_space.shape[0]), dtype=np.float32)
        rewards = np.zeros(self.num_envs, dtype=np.float32)
        dones = np.zeros(self.num_envs, dtype=np.float32)

        for i, env in enumerate(self.envs):
            obs, reward, terminated, truncated, info = env.step(int(actions[i]))
            self.episode_returns[i] += float(reward)

            if terminated or truncated:
                self.finished_returns.append(float(self.episode_returns[i]))
                self.finished_wins.append(float(info['enemy_hp']) <= 0 and float(info['agent_hp']) > 0)
                self.episode_returns[i] = 0.0
                dones[i] = 1.0
                # Fresh seed per episode so the policy is not fitted to a fixed
                # set of starting positions.
                obs, _ = env.reset(seed=self._seed + 100_000 + self._episode_counter)
                self._episode_counter += 1

            observations[i] = obs
            rewards[i] = reward

        return observations, rewards, dones

    def drain_stats(self) -> tuple[float, float]:
        if not self.finished_returns:
            return 0.0, 0.0
        mean_return = float(np.mean(self.finished_returns))
        win_rate = float(np.mean([1.0 if w else 0.0 for w in self.finished_wins]))
        self.finished_returns.clear()
        self.finished_wins.clear()
        return mean_return, win_rate


def train_ppo(
    model: ArenaActorCritic,
    config: PPOConfig,
    on_iteration: Optional[Callable[[int, int, Dict[str, float]], None]] = None,
    should_stop: Optional[Callable[[], bool]] = None,
) -> PPOResult:
    """Refine `model` with PPO. Mutates the model in place."""
    torch.manual_seed(config.seed)
    optimizer = torch.optim.Adam(model.parameters(), lr=config.learning_rate)
    generator = torch.Generator().manual_seed(config.seed)

    history: List[Dict[str, float]] = []
    total_env_steps = 0
    mean_return = 0.0
    win_rate = 0.0

    for iteration in range(config.total_iterations):
        if should_stop is not None and should_stop():
            break

        # Walk the curriculum: spend equal time at each difficulty, ascending.
        difficulty = config.difficulties[
            min(
                len(config.difficulties) - 1,
                iteration * len(config.difficulties) // max(1, config.total_iterations),
            )
        ]

        vec = SyncVectorEnv(
            num_envs=config.num_envs,
            difficulty=float(difficulty),
            max_steps=config.max_steps,
            seed=config.seed + iteration * 1000,
        )
        obs = vec.reset()

        obs_buf = torch.zeros(config.steps_per_env, config.num_envs, model.state_dim)
        act_buf = torch.zeros(config.steps_per_env, config.num_envs, dtype=torch.long)
        logp_buf = torch.zeros(config.steps_per_env, config.num_envs)
        rew_buf = torch.zeros(config.steps_per_env, config.num_envs)
        done_buf = torch.zeros(config.steps_per_env, config.num_envs)
        val_buf = torch.zeros(config.steps_per_env, config.num_envs)

        # ── Rollout ───────────────────────────────────────────────────────────
        model.eval()
        for step in range(config.steps_per_env):
            obs_tensor = torch.from_numpy(obs)
            with torch.no_grad():
                logits, values = model(obs_tensor)
                distribution = torch.distributions.Categorical(logits=logits)
                actions = distribution.sample()

            obs_buf[step] = obs_tensor
            act_buf[step] = actions
            logp_buf[step] = distribution.log_prob(actions)
            val_buf[step] = values

            obs, rewards, dones = vec.step(actions.numpy())
            rew_buf[step] = torch.from_numpy(rewards)
            done_buf[step] = torch.from_numpy(dones)
            total_env_steps += config.num_envs

        with torch.no_grad():
            _, last_values = model(torch.from_numpy(obs))

        # ── GAE(lambda) ───────────────────────────────────────────────────────
        advantages = torch.zeros_like(rew_buf)
        last_gae = torch.zeros(config.num_envs)
        for step in reversed(range(config.steps_per_env)):
            next_values = last_values if step == config.steps_per_env - 1 else val_buf[step + 1]
            # done_buf[step] marks the transition that ENDED an episode, so the
            # bootstrap past it must be cut.
            not_done = 1.0 - done_buf[step]
            delta = rew_buf[step] + config.gamma * next_values * not_done - val_buf[step]
            last_gae = delta + config.gamma * config.gae_lambda * not_done * last_gae
            advantages[step] = last_gae

        returns = advantages + val_buf

        b_obs = obs_buf.reshape(-1, model.state_dim)
        b_act = act_buf.reshape(-1)
        b_logp = logp_buf.reshape(-1)
        b_adv = advantages.reshape(-1)
        b_ret = returns.reshape(-1)
        b_adv = (b_adv - b_adv.mean()) / (b_adv.std() + 1e-8)

        # ── Optimize ──────────────────────────────────────────────────────────
        model.train()
        batch_size = b_obs.shape[0]
        policy_loss_val = value_loss_val = entropy_val = 0.0
        updates = 0

        for _ in range(config.epochs_per_iteration):
            order = torch.randperm(batch_size, generator=generator)
            for start in range(0, batch_size, config.minibatch_size):
                index = order[start:start + config.minibatch_size]

                logits, values = model(b_obs[index])
                distribution = torch.distributions.Categorical(logits=logits)
                new_logp = distribution.log_prob(b_act[index])
                entropy = distribution.entropy().mean()

                ratio = torch.exp(new_logp - b_logp[index])
                unclipped = ratio * b_adv[index]
                clipped = torch.clamp(ratio, 1 - config.clip_range, 1 + config.clip_range) * b_adv[index]
                policy_loss = -torch.min(unclipped, clipped).mean()
                value_loss = nn.functional.mse_loss(values, b_ret[index])

                loss = policy_loss + config.value_coef * value_loss - config.entropy_coef * entropy

                optimizer.zero_grad()
                loss.backward()
                torch.nn.utils.clip_grad_norm_(model.parameters(), config.max_grad_norm)
                optimizer.step()

                policy_loss_val += float(policy_loss.item())
                value_loss_val += float(value_loss.item())
                entropy_val += float(entropy.item())
                updates += 1

        iteration_return, iteration_win_rate = vec.drain_stats()
        # Episodes here run up to 300 steps but a rollout is only 128, so some
        # iterations legitimately finish zero episodes. Carry the last known
        # value rather than reporting a misleading 0.
        if iteration_return != 0.0 or iteration_win_rate != 0.0:
            mean_return, win_rate = iteration_return, iteration_win_rate

        entry = {
            'iteration': float(iteration + 1),
            'difficulty': float(difficulty),
            'meanReturn': mean_return,
            'winRate': win_rate,
            'policyLoss': policy_loss_val / max(1, updates),
            'valueLoss': value_loss_val / max(1, updates),
            'entropy': entropy_val / max(1, updates),
            'envSteps': float(total_env_steps),
        }
        history.append(entry)
        if on_iteration is not None:
            on_iteration(iteration + 1, config.total_iterations, entry)

    return PPOResult(
        iterations=len(history),
        total_env_steps=total_env_steps,
        final_mean_return=mean_return,
        final_win_rate=win_rate,
        history=history,
    )
