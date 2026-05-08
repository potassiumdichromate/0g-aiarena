"""Embedding Worker - generates embeddings for telemetry and memory items."""
import asyncio
import json
import logging
import os
import signal
from typing import Optional

import nats
from nats.aio.client import Client as NATSClient

from embedder import Embedder
from qdrant_upserter import QdrantUpserter

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
logger = logging.getLogger(__name__)

NATS_URL = os.environ.get('NATS_URL', 'nats://localhost:4222')
SUBJECT_TELEMETRY_PROCESSED = 'telemetry.processed'

nc: Optional[NATSClient] = None
running = True

embedder: Optional[Embedder] = None
upserter: Optional[QdrantUpserter] = None


async def handle_telemetry_processed(msg):
    try:
        data = json.loads(msg.data.decode())
        agent_id = data.get('agentId')
        session_id = data.get('sessionId')
        content = data.get('content', '')

        if not content:
            return

        logger.info(f"Generating embedding for agent {agent_id}, session {session_id}")
        vector = embedder.embed(content)
        await upserter.upsert(agent_id=agent_id, session_id=session_id, vector=vector, content=content)
        logger.info(f"Embedding upserted for agent {agent_id}")

    except Exception as e:
        logger.error(f"Error processing telemetry embedding: {e}", exc_info=True)


async def main():
    global nc, running, embedder, upserter

    embedder = Embedder()
    upserter = QdrantUpserter()
    await upserter.ensure_collections()

    logger.info(f"Connecting to NATS at {NATS_URL}")
    nc = await nats.connect(NATS_URL)

    sub = await nc.subscribe(SUBJECT_TELEMETRY_PROCESSED, cb=handle_telemetry_processed)
    logger.info(f"Embedding worker ready, subscribed to {SUBJECT_TELEMETRY_PROCESSED}")

    def shutdown(signum, frame):
        global running
        running = False

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    while running:
        await asyncio.sleep(1)

    await sub.unsubscribe()
    await nc.close()


if __name__ == '__main__':
    asyncio.run(main())
