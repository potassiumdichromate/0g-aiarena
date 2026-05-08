"""Calculates behavioural traits (0-100) from extracted features."""
import logging
from typing import Dict

logger = logging.getLogger(__name__)


def _clamp(value: float, min_val=0.0, max_val=100.0) -> float:
    return max(min_val, min(max_val, value))


class TraitCalculator:
    """Maps raw features to agent personality trait scores (0-100)."""

    def calculate(self, features: Dict[str, float]) -> Dict[str, float]:
        aggression = self._calc_aggression(features)
        patience = self._calc_patience(features)
        adaptability = self._calc_adaptability(features)
        risk_tolerance = self._calc_risk_tolerance(features)
        teamwork = self._calc_teamwork(features)
        creativity = self._calc_creativity(features)
        endurance = self._calc_endurance(features)
        precision = self._calc_precision(features)

        return {
            'aggression': aggression,
            'patience': patience,
            'adaptability': adaptability,
            'riskTolerance': risk_tolerance,
            'teamwork': teamwork,
            'creativity': creativity,
            'endurance': endurance,
            'precision': precision,
        }

    def _calc_aggression(self, f: Dict) -> float:
        # High APS + KD ratio → high aggression
        aps_score = min(f.get('actions_per_second', 0) * 20, 60)
        kd_score = min(f.get('kill_death_ratio', 0) * 15, 40)
        return _clamp(aps_score + kd_score)

    def _calc_patience(self, f: Dict) -> float:
        # Low APS + high latency variance → high patience (waits for right moment)
        aps = f.get('actions_per_second', 0)
        patience_base = max(0, 60 - aps * 10)
        variance_bonus = min(f.get('action_variance', 0) / 1000, 40)
        return _clamp(patience_base + variance_bonus)

    def _calc_adaptability(self, f: Dict) -> float:
        # High ability usage + position entropy → adaptable
        ability_rate = f.get('ability_usage_rate', 0) * 50
        entropy_score = min(f.get('position_entropy', 0) * 20, 50)
        return _clamp(ability_rate + entropy_score)

    def _calc_risk_tolerance(self, f: Dict) -> float:
        # KD ratio (willing to fight) + high damage per action
        kd = f.get('kill_death_ratio', 1.0)
        if kd > 1.5:
            base = 70
        elif kd > 1.0:
            base = 50
        elif kd > 0.5:
            base = 30
        else:
            base = 10
        damage_bonus = min(f.get('avg_damage_dealt', 0) / 10, 30)
        return _clamp(base + damage_bonus)

    def _calc_teamwork(self, f: Dict) -> float:
        # Low solo-kill focus + ability support usage → teamwork
        # Placeholder: moderate teamwork by default
        ability_rate = f.get('ability_usage_rate', 0.5)
        return _clamp(40 + ability_rate * 30)

    def _calc_creativity(self, f: Dict) -> float:
        # High position entropy + diverse ability usage → creativity
        entropy = min(f.get('position_entropy', 0) * 25, 70)
        ability_diversity = min(f.get('ability_usage_rate', 0) * 40, 30)
        return _clamp(entropy + ability_diversity)

    def _calc_endurance(self, f: Dict) -> float:
        # Long sessions + low death count → endurance
        duration = min(f.get('session_duration_s', 0) / 6, 60)
        death_penalty = max(0, 40 - f.get('death_count', 0) * 5)
        return _clamp(duration + death_penalty)

    def _calc_precision(self, f: Dict) -> float:
        # Low action latency + high damage → precision
        latency_score = max(0, 50 - f.get('avg_action_latency_ms', 200) / 4)
        damage_score = min(f.get('avg_damage_dealt', 0) / 5, 50)
        return _clamp(latency_score + damage_score)
