"""
Battle telemetry feature extractor.
Converts raw telemetry event sequences into structured numerical features.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import numpy as np


@dataclass
class TelemetryEvent:
    event_type: str  # COMBAT_ACTION, POSITION_UPDATE, HEALTH_CHANGE, ABILITY_USE, KILL
    timestamp_ms: float
    agent_id: str
    payload: Dict[str, Any] = field(default_factory=dict)


@dataclass
class AgentFeatures:
    agent_id: str
    session_duration_s: float
    total_events: int
    actions_per_second: float
    kill_death_ratio: float
    ability_usage_rate: float
    avg_action_latency_ms: float
    action_variance: float
    avg_damage_dealt: float
    total_damage_dealt: float
    avg_distance_moved: float
    position_entropy: float


def _compute_position_entropy(positions: List[Dict]) -> float:
    """Shannon entropy over discretised arena grid (10x10)."""
    if len(positions) < 2:
        return 0.0
    xs = [p.get("x", 0.0) / 100.0 for p in positions]
    zs = [p.get("z", 0.0) / 100.0 for p in positions]
    grid_counts = {}
    for x, z in zip(xs, zs):
        cell = (int(x * 10), int(z * 10))
        grid_counts[cell] = grid_counts.get(cell, 0) + 1
    total = sum(grid_counts.values())
    entropy = 0.0
    for count in grid_counts.values():
        p = count / total
        if p > 0:
            entropy -= p * np.log2(p)
    return entropy


class BattleFeatureExtractor:
    """Extracts features from a sequence of telemetry events for one agent."""

    def extract(
        self,
        events: List[TelemetryEvent],
        agent_id: str,
    ) -> AgentFeatures:
        agent_events = [e for e in events if e.agent_id == agent_id]
        if not agent_events:
            return self._zero_features(agent_id)

        agent_events.sort(key=lambda e: e.timestamp_ms)
        t_start = agent_events[0].timestamp_ms
        t_end = agent_events[-1].timestamp_ms
        duration_s = max((t_end - t_start) / 1000.0, 1e-6)
        total = len(agent_events)

        # Action events
        actions = [e for e in agent_events if e.event_type == "COMBAT_ACTION"]
        aps = len(actions) / duration_s

        # Action latencies
        latencies = []
        for i in range(1, len(actions)):
            latencies.append(actions[i].timestamp_ms - actions[i - 1].timestamp_ms)
        avg_latency = float(np.mean(latencies)) if latencies else 0.0

        # Action variance (entropy of action distribution)
        action_types = [e.payload.get("action", "IDLE") for e in actions]
        action_counts: Dict[str, int] = {}
        for a in action_types:
            action_counts[a] = action_counts.get(a, 0) + 1
        if action_counts:
            freqs = np.array(list(action_counts.values()), dtype=float)
            freqs /= freqs.sum()
            action_variance = float(-np.sum(freqs * np.log2(freqs + 1e-9)))
        else:
            action_variance = 0.0

        # Damage
        damage_events = [e for e in agent_events if e.event_type == "HEALTH_CHANGE"]
        damages = [abs(float(e.payload.get("delta", 0.0))) for e in damage_events if e.payload.get("target") != agent_id]
        total_damage = sum(damages)
        avg_damage = float(np.mean(damages)) if damages else 0.0

        # Kill/death
        kill_events = [e for e in agent_events if e.event_type == "KILL" and e.payload.get("killer_id") == agent_id]
        death_events = [e for e in agent_events if e.event_type == "KILL" and e.payload.get("victim_id") == agent_id]
        kills = len(kill_events)
        deaths = len(death_events)
        kd = kills / max(deaths, 1)

        # Ability usage
        ability_events = [e for e in agent_events if e.event_type == "ABILITY_USE"]
        ability_rate = len(ability_events) / duration_s

        # Position stats
        position_events = [e for e in agent_events if e.event_type == "POSITION_UPDATE"]
        positions = [e.payload for e in position_events]
        avg_distance = 0.0
        if len(positions) >= 2:
            dists = []
            for i in range(1, len(positions)):
                dx = positions[i].get("x", 0) - positions[i - 1].get("x", 0)
                dz = positions[i].get("z", 0) - positions[i - 1].get("z", 0)
                dists.append(np.sqrt(dx ** 2 + dz ** 2))
            avg_distance = float(np.mean(dists))

        pos_entropy = _compute_position_entropy(positions)

        return AgentFeatures(
            agent_id=agent_id,
            session_duration_s=duration_s,
            total_events=total,
            actions_per_second=aps,
            kill_death_ratio=kd,
            ability_usage_rate=ability_rate,
            avg_action_latency_ms=avg_latency,
            action_variance=action_variance,
            avg_damage_dealt=avg_damage,
            total_damage_dealt=total_damage,
            avg_distance_moved=avg_distance,
            position_entropy=pos_entropy,
        )

    def _zero_features(self, agent_id: str) -> AgentFeatures:
        return AgentFeatures(
            agent_id=agent_id,
            session_duration_s=0.0,
            total_events=0,
            actions_per_second=0.0,
            kill_death_ratio=0.0,
            ability_usage_rate=0.0,
            avg_action_latency_ms=0.0,
            action_variance=0.0,
            avg_damage_dealt=0.0,
            total_damage_dealt=0.0,
            avg_distance_moved=0.0,
            position_entropy=0.0,
        )

    def to_vector(self, features: AgentFeatures) -> np.ndarray:
        """Convert AgentFeatures to a normalised float32 vector."""
        return np.array([
            min(features.actions_per_second / 10.0, 1.0),
            min(features.kill_death_ratio / 5.0, 1.0),
            min(features.ability_usage_rate / 2.0, 1.0),
            min(features.avg_action_latency_ms / 1000.0, 1.0),
            min(features.action_variance / 3.0, 1.0),
            min(features.avg_damage_dealt / 100.0, 1.0),
            min(features.total_damage_dealt / 5000.0, 1.0),
            min(features.avg_distance_moved / 10.0, 1.0),
            min(features.position_entropy / 4.0, 1.0),
            min(features.session_duration_s / 600.0, 1.0),
            min(features.total_events / 3000.0, 1.0),
        ], dtype=np.float32)
