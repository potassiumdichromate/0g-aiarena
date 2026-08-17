"""
Policy used across the whole pipeline.

ONE policy format spans demonstrations -> behaviour cloning -> PPO ->
evaluation. That is a hard requirement, not a preference: the trainer donates
weights-derived demonstrations, BC initializes from them, PPO refines the same
network, and the evaluator must load exactly what PPO produced. Two formats
would mean the thing evaluated is not provably the thing trained.

This is why PPO here is a compact local implementation rather than Ray RLlib
(ml/reinforcement_learning/train_ppo.py, left untouched): RLlib checkpoints its
own internal model, which is not BCPolicyNetwork, so BC weights cannot flow
into it and the evaluator could not load its output. Ray also costs ~1GB of
dependencies and multi-second cluster startup for a 32-feature, 7-action
environment.

The actor is BCPolicyNetwork verbatim — the existing transformer in
ml/behaviour_cloning/model.py. PPO additionally needs a state-value estimate,
which is added as a SEPARATE small MLP head rather than by modifying
BCPolicyNetwork, so BC checkpoints stay loadable by the original class.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Dict, Optional

import numpy as np
import torch
import torch.nn as nn

from model import BCPolicyNetwork
from dataset import NUM_ACTIONS, STATE_DIM

CHECKPOINT_FORMAT_VERSION = 'arena-policy-v1'


class ValueHead(nn.Module):
    """State-value estimate V(s). Small MLP straight off the raw observation."""

    def __init__(self, state_dim: int = STATE_DIM, hidden: int = 128):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(state_dim, hidden),
            nn.Tanh(),
            nn.Linear(hidden, hidden),
            nn.Tanh(),
            nn.Linear(hidden, 1),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x).squeeze(-1)


class ArenaActorCritic(nn.Module):
    """BCPolicyNetwork actor + independent value head."""

    def __init__(self, state_dim: int = STATE_DIM, num_actions: int = NUM_ACTIONS, **actor_kwargs: Any):
        super().__init__()
        self.state_dim = state_dim
        self.num_actions = num_actions
        self.actor = BCPolicyNetwork(state_dim=state_dim, num_actions=num_actions, **actor_kwargs)
        self.critic = ValueHead(state_dim=state_dim)

    def forward(self, obs: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        return self.actor(obs), self.critic(obs)

    def logits(self, obs: torch.Tensor) -> torch.Tensor:
        return self.actor(obs)

    # ── Checkpointing ────────────────────────────────────────────────────────

    def save(self, path: str, metadata: Optional[Dict[str, Any]] = None) -> None:
        torch.save(
            {
                'format': CHECKPOINT_FORMAT_VERSION,
                'config': {'state_dim': self.state_dim, 'num_actions': self.num_actions},
                'actor': self.actor.state_dict(),
                'critic': self.critic.state_dict(),
                'metadata': metadata or {},
            },
            path,
        )

    @classmethod
    def load(cls, path: str, device: str = 'cpu') -> 'ArenaActorCritic':
        ckpt = torch.load(path, map_location=device, weights_only=False)
        fmt = ckpt.get('format')
        if fmt != CHECKPOINT_FORMAT_VERSION:
            raise ValueError(f'Unsupported checkpoint format {fmt!r}, expected {CHECKPOINT_FORMAT_VERSION!r}')

        model = cls(**ckpt['config'])
        model.actor.load_state_dict(ckpt['actor'])
        model.critic.load_state_dict(ckpt['critic'])
        model.to(device)
        model.eval()
        return model


def checkpoint_digest(path: str) -> str:
    """
    SHA-256 of the checkpoint bytes.

    This is what gets committed on-chain as part of the deliverable: the escrow
    records a hash of the exact artifact evaluated, so a provider cannot submit
    one model, get it verified, and hand over another.
    """
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return f'sha256:{digest.hexdigest()}'


def canonical_json_digest(payload: Dict[str, Any]) -> str:
    """SHA-256 over byte-stable JSON — used for evaluation reports."""
    encoded = json.dumps(payload, sort_keys=True, separators=(',', ':')).encode('utf-8')
    return f'sha256:{hashlib.sha256(encoded).hexdigest()}'


# ── Action selection ─────────────────────────────────────────────────────────


def greedy_policy_fn(model: ArenaActorCritic):
    """
    Deterministic argmax policy — what EVALUATION always uses.

    Sampling would make a score depend on RNG state, so two honest parties
    could compute different results for the same checkpoint and seeds. Greedy
    removes that entirely: the evaluation is a pure function of (weights, seed).
    """
    model.eval()

    def act(obs: np.ndarray) -> int:
        with torch.no_grad():
            tensor = torch.from_numpy(np.asarray(obs, dtype=np.float32)).unsqueeze(0)
            return int(model.logits(tensor).argmax(dim=-1).item())

    return act


def sampling_policy_fn(model: ArenaActorCritic, generator: torch.Generator, temperature: float = 1.0):
    """Stochastic policy for exploration during TRAINING and demonstrations only."""
    model.eval()

    def act(obs: np.ndarray) -> int:
        with torch.no_grad():
            tensor = torch.from_numpy(np.asarray(obs, dtype=np.float32)).unsqueeze(0)
            probs = torch.softmax(model.logits(tensor) / temperature, dim=-1)
            return int(torch.multinomial(probs, 1, generator=generator).item())

    return act


class ScriptedPolicy:
    """
    Deterministic hand-written baseline.

    Serves two real purposes: it is the cold-start opponent a brand-new agent
    is compared against, and it gives the test suite a policy with known
    behaviour so the measurement harness can be verified without training
    anything.
    """

    def __init__(self, aggression: float = 1.0):
        self.aggression = aggression

    def __call__(self, obs: np.ndarray) -> int:
        from .rollout import ATTACK, ABILITY_1, ABILITY_2, FLEE, DEFEND

        agent_hp, enemy_hp, distance = float(obs[0]), float(obs[1]), float(obs[2])
        cooldown_1, cooldown_2 = float(obs[3]), float(obs[4])

        if agent_hp < 0.25 and cooldown_2 <= 0:
            return ABILITY_2
        if agent_hp < 0.15:
            return FLEE
        if cooldown_1 <= 0 and distance < 0.15:
            return ABILITY_1
        if distance < 0.15:
            return ATTACK
        return ATTACK if self.aggression > 0.5 else DEFEND
