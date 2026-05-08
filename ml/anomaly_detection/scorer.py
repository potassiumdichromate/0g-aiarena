"""
Anomaly detection scorer for detecting bot-like or cheating behaviour in battle telemetry.
Uses Isolation Forest + statistical z-score methods.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

import numpy as np
from sklearn.ensemble import IsolationForest
from sklearn.preprocessing import StandardScaler


FEATURE_NAMES = [
    "actions_per_second",
    "kill_death_ratio",
    "ability_usage_rate",
    "avg_action_latency_ms",
    "action_variance",
    "avg_damage_dealt",
    "total_damage_dealt",
    "avg_distance_moved",
    "position_entropy",
    "session_duration_s",
    "total_events",
]


@dataclass
class AnomalyResult:
    agent_id: str
    anomaly_score: float       # 0.0 (normal) to 1.0 (highly anomalous)
    is_anomaly: bool
    z_scores: Dict[str, float]
    flags: List[str]


class BehaviourAnomalyScorer:
    """
    Scores agent behaviour vectors for anomaly detection.
    Combines Isolation Forest scores with human-interpretable z-score flags.
    """

    def __init__(
        self,
        contamination: float = 0.05,
        n_estimators: int = 200,
        threshold: float = 0.6,
    ):
        self.contamination = contamination
        self.threshold = threshold
        self.iso_forest = IsolationForest(
            n_estimators=n_estimators,
            contamination=contamination,
            random_state=42,
        )
        self.scaler = StandardScaler()
        self._fitted = False

    def fit(self, feature_matrix: np.ndarray) -> None:
        """Fit on a matrix of shape (n_agents, n_features)."""
        scaled = self.scaler.fit_transform(feature_matrix)
        self.iso_forest.fit(scaled)
        self._fitted = True
        print(f"[AnomalyScorer] Fitted on {feature_matrix.shape[0]} samples")

    def score(self, features: np.ndarray, agent_id: str = "unknown") -> AnomalyResult:
        """Score a single feature vector. Returns AnomalyResult."""
        if not self._fitted:
            raise RuntimeError("Scorer must be fitted before scoring.")

        vec = features.reshape(1, -1)
        scaled = self.scaler.transform(vec)
        # decision_function: negative = anomaly
        raw_score = float(self.iso_forest.decision_function(scaled)[0])
        # Normalise to [0, 1] where 1 = anomaly
        anomaly_score = max(0.0, min(1.0, -raw_score + 0.5))

        z_scores = self._compute_z_scores(scaled[0])
        flags = self._generate_flags(features, z_scores)

        return AnomalyResult(
            agent_id=agent_id,
            anomaly_score=anomaly_score,
            is_anomaly=anomaly_score >= self.threshold,
            z_scores=z_scores,
            flags=flags,
        )

    def score_batch(
        self, feature_matrix: np.ndarray, agent_ids: List[str]
    ) -> List[AnomalyResult]:
        return [
            self.score(feature_matrix[i], agent_ids[i])
            for i in range(len(agent_ids))
        ]

    def _compute_z_scores(self, scaled_vec: np.ndarray) -> Dict[str, float]:
        return {
            FEATURE_NAMES[i]: float(scaled_vec[i])
            for i in range(min(len(FEATURE_NAMES), len(scaled_vec)))
        }

    def _generate_flags(self, features: np.ndarray, z_scores: Dict[str, float]) -> List[str]:
        """Generate human-readable anomaly flags based on z-scores and domain thresholds."""
        flags = []

        # Bot indicators
        if features[0] > 8.0:  # actions_per_second > 8 is superhuman
            flags.append("SUPERHUMAN_APS")
        if features[3] < 10.0:  # avg latency < 10ms is inhuman
            flags.append("INHUMAN_LATENCY")
        if features[4] < 0.1:  # extremely low action variance → scripted bot
            flags.append("LOW_ACTION_VARIANCE")
        if features[8] < 0.2:  # extremely low position entropy → static farming
            flags.append("STATIC_POSITIONING")

        # Outlier z-scores
        for fname, z in z_scores.items():
            if abs(z) > 3.5:
                flags.append(f"OUTLIER_{fname.upper()}")

        return flags
