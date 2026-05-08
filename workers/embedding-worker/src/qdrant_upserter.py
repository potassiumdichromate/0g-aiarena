"""Upserts embeddings to Qdrant vector database."""
import logging
import os
import uuid
from typing import List

from qdrant_client import QdrantClient
from qdrant_client.models import Distance, VectorParams, PointStruct

logger = logging.getLogger(__name__)

QDRANT_URL = os.environ.get('QDRANT_URL', 'http://localhost:6333')
QDRANT_API_KEY = os.environ.get('QDRANT_API_KEY')

COLLECTION_AGENT_MEMORIES = 'agent_memories'
VECTOR_SIZE = 1024


class QdrantUpserter:
    def __init__(self):
        self.client = QdrantClient(url=QDRANT_URL, api_key=QDRANT_API_KEY)

    async def ensure_collections(self) -> None:
        try:
            self.client.get_collection(COLLECTION_AGENT_MEMORIES)
        except Exception:
            logger.info(f"Creating collection: {COLLECTION_AGENT_MEMORIES}")
            self.client.create_collection(
                collection_name=COLLECTION_AGENT_MEMORIES,
                vectors_config=VectorParams(size=VECTOR_SIZE, distance=Distance.COSINE),
            )

    async def upsert(
        self,
        agent_id: str,
        session_id: str,
        vector: List[float],
        content: str,
        metadata: dict = None,
    ) -> None:
        point = PointStruct(
            id=str(uuid.uuid4()),
            vector=vector,
            payload={
                'agentId': agent_id,
                'sessionId': session_id,
                'content': content[:500],  # Truncate payload
                'type': 'TELEMETRY',
                **(metadata or {}),
            },
        )
        self.client.upsert(collection_name=COLLECTION_AGENT_MEMORIES, points=[point], wait=True)
        logger.debug(f"Upserted point for agent {agent_id}")
