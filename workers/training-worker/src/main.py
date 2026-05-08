"""Training Worker - subscribes to NATS training.queued events and executes GPU training jobs."""
import asyncio
import json
import logging
import os
import signal
from typing import Optional

import nats
from nats.aio.client import Client as NATSClient

from training_job import TrainingJob
from config import TrainingConfig

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
logger = logging.getLogger(__name__)

NATS_URL = os.environ.get('NATS_URL', 'nats://localhost:4222')
SUBJECT_TRAINING_QUEUED = 'training.queued'
SUBJECT_TRAINING_COMPLETED = 'training.completed'
SUBJECT_TRAINING_FAILED = 'training.failed'

nc: Optional[NATSClient] = None
running = True


async def handle_training_job(msg):
    """Process a queued training job."""
    try:
        data = json.loads(msg.data.decode())
        job_id = data.get('jobId')
        agent_id = data.get('agentId')
        priority = data.get('priority', 5)

        logger.info(f"Received training job {job_id} for agent {agent_id} (priority {priority})")

        config = TrainingConfig(
            agent_id=agent_id,
            job_id=job_id,
            model_base='meta-llama/Llama-2-7b-chat-hf',
            training_type='BEHAVIOUR_CLONING',
            max_steps=1000,
            batch_size=4,
            learning_rate=2e-4,
        )

        job = TrainingJob(config)
        result = await job.execute()

        # Publish completion event
        await nc.publish(SUBJECT_TRAINING_COMPLETED, json.dumps({
            'jobId': job_id,
            'agentId': agent_id,
            'modelId': result.get('model_id'),
            'checkpointPath': result.get('checkpoint_path'),
            'metrics': result.get('metrics', {}),
            'occurredAt': result.get('completed_at'),
        }).encode())

        logger.info(f"Training job {job_id} completed successfully")

    except Exception as e:
        logger.error(f"Training job failed: {e}", exc_info=True)
        if data:
            await nc.publish(SUBJECT_TRAINING_FAILED, json.dumps({
                'jobId': data.get('jobId'),
                'agentId': data.get('agentId'),
                'error': str(e),
            }).encode())


async def main():
    global nc, running

    logger.info(f"Connecting to NATS at {NATS_URL}")
    nc = await nats.connect(NATS_URL)
    logger.info("Connected to NATS")

    sub = await nc.subscribe(SUBJECT_TRAINING_QUEUED, cb=handle_training_job)
    logger.info(f"Subscribed to {SUBJECT_TRAINING_QUEUED}")

    def shutdown(signum, frame):
        global running
        running = False

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    logger.info("Training worker ready, waiting for jobs...")

    while running:
        await asyncio.sleep(1)

    logger.info("Shutting down training worker...")
    await sub.unsubscribe()
    await nc.close()


if __name__ == '__main__':
    asyncio.run(main())
