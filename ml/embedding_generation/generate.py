"""
Agent memory and behaviour embedding generation using BGE-M3.
Produces 1024-dimensional dense vectors for Qdrant storage.
"""
from __future__ import annotations

from typing import Dict, List, Optional, Union

import numpy as np
from sentence_transformers import SentenceTransformer

MODEL_ID = "BAAI/bge-m3"
EMBED_DIM = 1024


class BGEEmbedder:
    """Singleton wrapper around BGE-M3 for batched embedding generation."""

    _instance: Optional["BGEEmbedder"] = None

    def __init__(self, device: str = "cpu"):
        print(f"[BGEEmbedder] Loading {MODEL_ID} on {device}")
        self.model = SentenceTransformer(MODEL_ID, device=device)
        self.device = device

    @classmethod
    def get_instance(cls, device: str = "cpu") -> "BGEEmbedder":
        if cls._instance is None:
            cls._instance = cls(device=device)
        return cls._instance

    def embed(self, texts: Union[str, List[str]], batch_size: int = 32) -> np.ndarray:
        """
        Generate embeddings for one or more texts.
        Returns float32 array of shape (n, EMBED_DIM).
        """
        if isinstance(texts, str):
            texts = [texts]
        embeddings = self.model.encode(
            texts,
            batch_size=batch_size,
            normalize_embeddings=True,
            show_progress_bar=len(texts) > 100,
        )
        return embeddings.astype(np.float32)

    def embed_memory(self, memory: Dict) -> np.ndarray:
        """Embed an agent memory record into a vector."""
        text = self._memory_to_text(memory)
        return self.embed(text)[0]

    def embed_episode(self, episode: Dict) -> np.ndarray:
        """Embed a battle episode summary into a vector."""
        text = self._episode_to_text(episode)
        return self.embed(text)[0]

    def embed_behaviour_profile(self, profile: Dict) -> np.ndarray:
        """Embed a behaviour profile dict into a vector."""
        text = self._profile_to_text(profile)
        return self.embed(text)[0]

    def _memory_to_text(self, m: Dict) -> str:
        parts = []
        if m.get("summary"):
            parts.append(m["summary"])
        if m.get("tags"):
            parts.append("Tags: " + ", ".join(m["tags"]))
        if m.get("emotionalValence"):
            parts.append(f"Valence: {m['emotionalValence']}")
        return " | ".join(parts) or "empty memory"

    def _episode_to_text(self, e: Dict) -> str:
        return (
            f"Battle {e.get('battleId', '?')} "
            f"outcome={e.get('outcome', '?')} "
            f"damage_dealt={e.get('damageDealt', 0):.0f} "
            f"kills={e.get('kills', 0)} "
            f"duration={e.get('durationSeconds', 0):.0f}s "
            f"archetype={e.get('archetype', 'HYBRID')}"
        )

    def _profile_to_text(self, p: Dict) -> str:
        traits = p.get("traits", {})
        return (
            f"Agent {p.get('agentId', '?')} "
            f"archetype={p.get('archetype', 'HYBRID')} "
            f"aggression={traits.get('aggression', 0):.1f} "
            f"patience={traits.get('patience', 0):.1f} "
            f"adaptability={traits.get('adaptability', 0):.1f} "
            f"riskTolerance={traits.get('riskTolerance', 0):.1f}"
        )
