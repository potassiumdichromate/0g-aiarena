"""Classifies agent combat archetype from features and traits."""
import logging
from typing import Dict

logger = logging.getLogger(__name__)

ARCHETYPES = ['BERSERKER', 'TACTICIAN', 'SUPPORT', 'ASSASSIN', 'DEFENDER', 'HYBRID']


class ArchetypeClassifier:
    def classify(self, features: Dict[str, float], traits: Dict[str, float]) -> str:
        aggression = traits.get('aggression', 50)
        patience = traits.get('patience', 50)
        adaptability = traits.get('adaptability', 50)
        risk = traits.get('riskTolerance', 50)
        teamwork = traits.get('teamwork', 50)
        precision = traits.get('precision', 50)

        scores = {
            'BERSERKER': aggression * 0.5 + risk * 0.3 + (100 - patience) * 0.2,
            'TACTICIAN': patience * 0.4 + adaptability * 0.3 + precision * 0.3,
            'SUPPORT': teamwork * 0.6 + (100 - aggression) * 0.4,
            'ASSASSIN': precision * 0.4 + risk * 0.3 + aggression * 0.3,
            'DEFENDER': (100 - risk) * 0.4 + patience * 0.3 + teamwork * 0.3,
            'HYBRID': adaptability * 0.4 + (aggression + patience + teamwork) / 3 * 0.6,
        }

        archetype = max(scores, key=scores.get)
        logger.debug(f"Archetype scores: {scores}, selected: {archetype}")
        return archetype
