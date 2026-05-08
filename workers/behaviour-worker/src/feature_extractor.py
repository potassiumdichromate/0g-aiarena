"""BehaviourFeatureExtractor - extracts numerical features from raw telemetry events."""
import logging
from typing import Any, Dict, List

import numpy as np

logger = logging.getLogger(__name__)


class BehaviourFeatureExtractor:
    """Extracts behavioural features from a sequence of telemetry events."""

    def extract(self, events: List[Dict[str, Any]]) -> Dict[str, float]:
        if not events:
            return self._empty_features()

        actions = [e for e in events if e.get('eventType') == 'COMBAT_ACTION']
        kills = [e for e in events if e.get('eventType') == 'KILL']
        deaths = [e for e in events if e.get('eventType') == 'DEATH']
        ability_uses = [e for e in events if e.get('eventType') == 'ABILITY_USE']

        total_events = len(events)
        duration_ms = self._get_duration(events)
        duration_s = max(duration_ms / 1000, 1)

        features: Dict[str, float] = {
            # Combat metrics
            'actions_per_second': len(actions) / duration_s,
            'kill_death_ratio': len(kills) / max(len(deaths), 1),
            'ability_usage_rate': len(ability_uses) / max(len(actions), 1),
            'kill_count': float(len(kills)),
            'death_count': float(len(deaths)),

            # Timing metrics
            'avg_action_latency_ms': self._avg_action_latency(actions),
            'action_variance': self._action_timing_variance(actions),

            # Damage metrics
            'avg_damage_dealt': self._avg_damage(actions),
            'total_damage_dealt': self._total_damage(actions),

            # Positional metrics
            'avg_distance_moved': self._avg_distance_moved(events),
            'position_entropy': self._position_entropy(events),

            # Duration
            'session_duration_s': duration_s,
            'total_events': float(total_events),
        }

        return features

    def _get_duration(self, events: List[Dict]) -> float:
        timestamps = [e.get('timestamp', 0) for e in events]
        if len(timestamps) < 2:
            return 1000.0
        return float(max(timestamps) - min(timestamps))

    def _avg_action_latency(self, actions: List[Dict]) -> float:
        latencies = [e.get('payload', {}).get('latencyMs', 0) for e in actions]
        return float(np.mean(latencies)) if latencies else 0.0

    def _action_timing_variance(self, actions: List[Dict]) -> float:
        timestamps = sorted([e.get('timestamp', 0) for e in actions])
        if len(timestamps) < 2:
            return 0.0
        intervals = np.diff(timestamps)
        return float(np.var(intervals))

    def _avg_damage(self, actions: List[Dict]) -> float:
        damages = [e.get('payload', {}).get('damageDealt', 0) for e in actions if e.get('payload', {}).get('damageDealt')]
        return float(np.mean(damages)) if damages else 0.0

    def _total_damage(self, actions: List[Dict]) -> float:
        return float(sum(e.get('payload', {}).get('damageDealt', 0) or 0 for e in actions))

    def _avg_distance_moved(self, events: List[Dict]) -> float:
        positions = [e.get('payload', {}).get('position') for e in events if e.get('eventType') == 'POSITION_UPDATE']
        if len(positions) < 2:
            return 0.0
        distances = []
        for i in range(1, len(positions)):
            if positions[i] and positions[i-1]:
                dx = positions[i].get('x', 0) - positions[i-1].get('x', 0)
                dy = positions[i].get('y', 0) - positions[i-1].get('y', 0)
                dz = positions[i].get('z', 0) - positions[i-1].get('z', 0)
                distances.append(float(np.sqrt(dx**2 + dy**2 + dz**2)))
        return float(np.mean(distances)) if distances else 0.0

    def _position_entropy(self, events: List[Dict]) -> float:
        positions = [e.get('payload', {}).get('position') for e in events if e.get('eventType') == 'POSITION_UPDATE']
        if not positions:
            return 0.0
        xs = [p.get('x', 0) for p in positions if p]
        if not xs:
            return 0.0
        hist, _ = np.histogram(xs, bins=10, density=True)
        hist = hist[hist > 0]
        return float(-np.sum(hist * np.log(hist + 1e-10)))

    def _empty_features(self) -> Dict[str, float]:
        return {k: 0.0 for k in [
            'actions_per_second', 'kill_death_ratio', 'ability_usage_rate',
            'kill_count', 'death_count', 'avg_action_latency_ms', 'action_variance',
            'avg_damage_dealt', 'total_damage_dealt', 'avg_distance_moved',
            'position_entropy', 'session_duration_s', 'total_events',
        ]}
