"""Behaviour Worker - consumes telemetry batches and extracts behavioural features."""
import asyncio
import json
import logging
import os
import signal

import nats

from feature_extractor import BehaviourFeatureExtractor
from trait_calculator import TraitCalculator
from archetype_classifier import ArchetypeClassifier

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
logger = logging.getLogger(__name__)

NATS_URL = os.environ.get('NATS_URL', 'nats://localhost:4222')
SUBJECT_TELEMETRY_BATCH = 'telemetry.batch.received'
SUBJECT_TELEMETRY_PROCESSED = 'telemetry.processed'

running = True


async def process_batch(msg, nc, extractor, trait_calc, classifier):
    try:
        data = json.loads(msg.data.decode())
        agent_id = data.get('agentId')
        session_id = data.get('sessionId')
        events = data.get('events', [])

        if not events:
            return

        features = extractor.extract(events)
        traits = trait_calc.calculate(features)
        archetype = classifier.classify(features, traits)

        await nc.publish(SUBJECT_TELEMETRY_PROCESSED, json.dumps({
            'agentId': agent_id,
            'sessionId': session_id,
            'features': features,
            'traits': traits,
            'archetype': archetype,
            'content': json.dumps({'features': features, 'traits': traits}),
            'occurredAt': events[-1].get('timestamp') if events else None,
        }).encode())

        logger.info(f"Processed {len(events)} events for agent {agent_id}, archetype: {archetype}")

    except Exception as e:
        logger.error(f"Error processing batch: {e}", exc_info=True)


async def main():
    global running

    extractor = BehaviourFeatureExtractor()
    trait_calc = TraitCalculator()
    classifier = ArchetypeClassifier()

    nc = await nats.connect(NATS_URL)

    async def handler(msg):
        await process_batch(msg, nc, extractor, trait_calc, classifier)

    sub = await nc.subscribe(SUBJECT_TELEMETRY_BATCH, cb=handler)
    logger.info(f"Behaviour worker subscribed to {SUBJECT_TELEMETRY_BATCH}")

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
