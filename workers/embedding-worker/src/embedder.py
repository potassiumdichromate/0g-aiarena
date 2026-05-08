"""BGE-M3 embedding generation."""
import logging
import os
from typing import List

import numpy as np

logger = logging.getLogger(__name__)

MODEL_NAME = os.environ.get('EMBEDDING_MODEL', 'BAAI/bge-m3')


class Embedder:
    def __init__(self):
        self.model = None
        self._load_model()

    def _load_model(self):
        try:
            from sentence_transformers import SentenceTransformer
            logger.info(f"Loading embedding model: {MODEL_NAME}")
            self.model = SentenceTransformer(MODEL_NAME)
            logger.info("Embedding model loaded successfully")
        except Exception as e:
            logger.warning(f"Could not load embedding model: {e}. Using random vectors.")
            self.model = None

    def embed(self, text: str) -> List[float]:
        """Generate embedding for a single text."""
        if self.model is not None:
            vector = self.model.encode(text, normalize_embeddings=True)
            return vector.tolist()
        else:
            # Fallback: random unit vector (for testing)
            vector = np.random.randn(1024).astype(np.float32)
            vector = vector / np.linalg.norm(vector)
            return vector.tolist()

    def embed_batch(self, texts: List[str]) -> List[List[float]]:
        """Generate embeddings for a batch of texts."""
        if self.model is not None:
            vectors = self.model.encode(texts, normalize_embeddings=True, batch_size=32)
            return [v.tolist() for v in vectors]
        else:
            return [self.embed(t) for t in texts]
