"""
PPO training for AI Arena agents using Ray RLlib.
"""
from __future__ import annotations

import argparse
import os
from typing import Dict, Any

import ray
from ray import tune
from ray.rllib.algorithms.ppo import PPOConfig
from ray.tune.registry import register_env

from environment import AIArenaBattleEnv


def env_creator(config: Dict[str, Any]) -> AIArenaBattleEnv:
    return AIArenaBattleEnv(config)


def train_ppo(
    num_iterations: int = 100,
    num_workers: int = 4,
    num_gpus: float = 0.0,
    difficulty: float = 0.5,
    checkpoint_dir: str = "./checkpoints",
    stop_reward: float = 50.0,
) -> str:
    """Run PPO training and return the best checkpoint path."""
    register_env("ai_arena_battle", env_creator)
    ray.init(ignore_reinit_error=True)

    config = (
        PPOConfig()
        .environment(
            env="ai_arena_battle",
            env_config={"difficulty": difficulty, "max_steps": 300},
        )
        .rollouts(num_rollout_workers=num_workers, rollout_fragment_length=200)
        .training(
            lr=3e-4,
            gamma=0.99,
            lambda_=0.95,
            clip_param=0.2,
            entropy_coeff=0.01,
            vf_loss_coeff=0.5,
            train_batch_size=4000,
            sgd_minibatch_size=256,
            num_sgd_iter=10,
            model={
                "fcnet_hiddens": [256, 256],
                "fcnet_activation": "relu",
                "use_lstm": False,
            },
        )
        .resources(num_gpus=num_gpus)
        .evaluation(
            evaluation_interval=10,
            evaluation_num_workers=1,
            evaluation_duration=5,
        )
    )

    os.makedirs(checkpoint_dir, exist_ok=True)

    results = tune.run(
        "PPO",
        config=config.to_dict(),
        stop={
            "training_iteration": num_iterations,
            "episode_reward_mean": stop_reward,
        },
        local_dir=checkpoint_dir,
        checkpoint_at_end=True,
        checkpoint_freq=10,
        verbose=1,
    )

    best = results.get_best_checkpoint(
        results.get_best_trial("episode_reward_mean", "max"),
        "episode_reward_mean",
        "max",
    )
    print(f"[PPO Training] Best checkpoint: {best}")
    ray.shutdown()
    return str(best)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--iterations", type=int, default=100)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--gpus", type=float, default=0.0)
    parser.add_argument("--difficulty", type=float, default=0.5)
    parser.add_argument("--checkpoint-dir", type=str, default="./checkpoints")
    parser.add_argument("--stop-reward", type=float, default=50.0)
    args = parser.parse_args()

    ckpt = train_ppo(
        num_iterations=args.iterations,
        num_workers=args.workers,
        num_gpus=args.gpus,
        difficulty=args.difficulty,
        checkpoint_dir=args.checkpoint_dir,
        stop_reward=args.stop_reward,
    )
    print(f"Training complete. Best checkpoint: {ckpt}")
