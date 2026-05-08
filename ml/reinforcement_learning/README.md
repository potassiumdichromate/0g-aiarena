# Reinforcement Learning (RL) Module

Trains agent combat policy networks using PPO (Proximal Policy Optimisation) via Ray RLlib in a custom battle simulation environment.

## What It Does

1. Wraps the battle simulator as an OpenAI Gym-compatible environment
2. Trains policy networks using PPO with shaped reward functions
3. Uses a population of opponent agents for robust self-play training
4. Periodically snapshots policy checkpoints to 0G Storage

## Files

| File | Purpose |
|------|---------|
| `train_ppo.py` | Ray RLlib PPO training entrypoint with `tune.run` |
| `environment.py` | Custom `gym.Env` wrapping the battle simulator |
| `reward.py` | Shaped reward functions + `CumulativeRewardTracker` |

## Reward Structure

| Event | Reward |
|-------|--------|
| Kill opponent | +5.0 |
| Survive 10 ticks | +0.1 |
| Take damage | -0.5 per 10HP |
| Death | -10.0 |
| Win match | +20.0 |
| Lose match | -15.0 |
| Efficient kill (low damage taken) | +2.0 bonus |

## Usage

```bash
pip install -r requirements.txt

python train_ppo.py \
  --agent-id <agent_uuid> \
  --num-workers 4 \
  --iterations 200 \
  --checkpoint-freq 20
```
