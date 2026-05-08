"""
Feature extraction pipeline: reads raw telemetry batches and produces feature vectors.
"""
from __future__ import annotations

import json
from typing import Dict, List

import numpy as np

from extractor import AgentFeatures, BattleFeatureExtractor, TelemetryEvent


def parse_telemetry_batch(raw_batch: Dict) -> List[TelemetryEvent]:
    """Parse a raw telemetry JSON batch into TelemetryEvent list."""
    events = []
    for raw in raw_batch.get("events", []):
        events.append(TelemetryEvent(
            event_type=raw.get("eventType", "UNKNOWN"),
            timestamp_ms=float(raw.get("timestampMs", 0)),
            agent_id=raw.get("agentId", ""),
            payload=raw.get("payload", {}),
        ))
    return events


class FeatureExtractionPipeline:
    """End-to-end pipeline for processing telemetry files into feature matrices."""

    def __init__(self):
        self.extractor = BattleFeatureExtractor()

    def process_batch(self, batch_json: Dict) -> Dict[str, np.ndarray]:
        """Process a single telemetry batch. Returns {agent_id: feature_vector}."""
        events = parse_telemetry_batch(batch_json)
        agent_ids = {e.agent_id for e in events if e.agent_id}
        result = {}
        for aid in agent_ids:
            features = self.extractor.extract(events, aid)
            result[aid] = self.extractor.to_vector(features)
        return result

    def process_file(self, path: str) -> Dict[str, np.ndarray]:
        """Process a telemetry JSON file."""
        with open(path) as f:
            data = json.load(f)
        return self.process_batch(data)

    def process_files(self, paths: List[str]) -> Dict[str, List[np.ndarray]]:
        """Process multiple files and aggregate per agent."""
        aggregated: Dict[str, List[np.ndarray]] = {}
        for path in paths:
            vectors = self.process_file(path)
            for aid, vec in vectors.items():
                aggregated.setdefault(aid, []).append(vec)
        return aggregated

    def mean_features(self, paths: List[str]) -> Dict[str, np.ndarray]:
        """Return mean feature vector per agent across multiple sessions."""
        aggregated = self.process_files(paths)
        return {aid: np.mean(vecs, axis=0) for aid, vecs in aggregated.items()}


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("Usage: python pipeline.py <telemetry_file.json> [...]")
        sys.exit(1)

    pipeline = FeatureExtractionPipeline()
    means = pipeline.mean_features(sys.argv[1:])
    for aid, vec in means.items():
        print(f"Agent {aid}: {vec.round(4)}")
