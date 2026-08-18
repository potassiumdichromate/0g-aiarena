"""
Training Worker — executes real trait-training jobs.

What changed and why
--------------------
This worker previously subscribed to the NATS subject `training.queued`, built
a TrainingConfig with a hardcoded `meta-llama/Llama-2-7b-chat-hf` (ignoring the
baseModel and datasetRootHash in the event), and handed it to trainers that
slept two seconds and returned invented metrics. It was never deployed, so no
training job created from the product has ever executed.

It now:

  1. Claims jobs from Postgres with `FOR UPDATE SKIP LOCKED` instead of relying
     on NATS delivery. This repo already established that NATS is unreliable on
     Render's starter plan (agent.service.ts mints INFTs over direct HTTP for
     the same reason), and a dropped message here would strand a paid
     marketplace job. NATS is still used as a wake-up hint when available, but
     correctness never depends on it.
  2. Runs the real pipeline in ml/trait_training: the trainer donates
     demonstrations from its own policy, the student learns by behaviour
     cloning, PPO refines it on the trainer's curriculum, and a seeded
     evaluation measures the result.
  3. Requeues jobs whose worker died, so a crash cannot strand a job forever.

The LORA_FINETUNE path (0G Compute fine-tuning, a separate concern) still goes
through training_job.py and is untouched.
"""

from __future__ import annotations

import logging
import os
import signal
import sys
import tempfile
import time
from pathlib import Path

from verification_runner import claim_next_verification, execute_verification
from trait_training_runner import (
    MARKETPLACE_ONLY,
    WORKER_ID,
    claim_next_job,
    execute_job,
    requeue_stale_jobs,
)

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
logger = logging.getLogger(__name__)

POLL_INTERVAL_S = float(os.environ.get('TRAINING_POLL_INTERVAL_S', '5'))
STALE_AFTER_S = int(os.environ.get('TRAINING_STALE_AFTER_S', '300'))
# How often an idle worker says it is alive. Without this the log goes silent
# after startup, and "the worker is not running" is indistinguishable from
# "the worker is running and sees no work" — which is exactly the question
# asked when a job sits at QUEUED.
IDLE_HEARTBEAT_S = int(os.environ.get('TRAINING_IDLE_HEARTBEAT_S', '60'))
CHECKPOINT_DIR = Path(os.environ.get('TRAINING_CHECKPOINT_DIR', tempfile.gettempdir())) / 'kult-checkpoints'

_running = True


def _shutdown(signum, _frame):
    global _running
    logger.info('Received signal %s — finishing current job then exiting', signum)
    _running = False


def main() -> int:
    global _running

    signal.signal(signal.SIGINT, _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)

    CHECKPOINT_DIR.mkdir(parents=True, exist_ok=True)

    # psycopg is imported lazily inside the runner so this fails with a clear
    # message rather than an import traceback.
    import psycopg  # noqa: F401
    from trait_training_runner import _connect

    logger.info('Training worker %s starting (poll %.1fs, checkpoints %s)',
                WORKER_ID, POLL_INTERVAL_S, CHECKPOINT_DIR)

    conn = _connect()
    last_sweep = 0.0
    last_heartbeat = 0.0

    while _running:
        try:
            # Periodic sweep, not every tick — it is a full-table UPDATE.
            if time.monotonic() - last_sweep > STALE_AFTER_S:
                requeued = requeue_stale_jobs(conn, STALE_AFTER_S)
                if requeued:
                    logger.warning('Requeued %d job(s) with stale heartbeats', requeued)
                last_sweep = time.monotonic()

            if time.monotonic() - last_heartbeat > IDLE_HEARTBEAT_S:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        SELECT count(*) FILTER (WHERE status = 'QUEUED'),
                               count(*) FILTER (WHERE status = 'RUNNING'),
                               count(*) FILTER (
                                 WHERE status = 'QUEUED'
                                   AND config -> 'marketplaceJobId' IS NOT NULL
                               )
                          FROM "TrainingJob"
                         WHERE type IN ('BEHAVIOUR_CLONING', 'REINFORCEMENT_LEARNING')
                        """
                    )
                    queued, running, marketplace = cur.fetchone()
                logger.info(
                    'Worker %s alive — %s queued (%s marketplace), %s running%s',
                    WORKER_ID, queued, marketplace, running,
                    '' if not MARKETPLACE_ONLY else ' — serving marketplace jobs only',
                )
                last_heartbeat = time.monotonic()

            job = claim_next_job(conn)

            if job is None:
                # Nothing to train. Verify a delivered marketplace job instead —
                # it is seconds of work, and a job sitting unverified is a
                # provider waiting to be paid.
                pending = claim_next_verification(conn)
                if pending is not None:
                    try:
                        result = execute_verification(conn, pending, CHECKPOINT_DIR)
                        conn.commit()
                        if result:
                            logger.info(
                                "Verified job %s: %s = %s (target %s)",
                                result["jobId"], result["targetMetric"],
                                result["measuredValue"], result["targetValue"],
                            )
                    except Exception:
                        conn.rollback()
                        logger.exception("Verification pass failed for job %s", pending["id"])
                    continue
            if job is None:
                time.sleep(POLL_INTERVAL_S)
                continue

            logger.info('Claimed job %s for agent %s', job['id'], job['agentId'])
            started = time.time()

            try:
                summary = execute_job(conn, job, CHECKPOINT_DIR)
                logger.info(
                    'Job %s completed in %.1fs — %s %s -> %s (target %s: %s)',
                    job['id'], time.time() - started,
                    summary['targetMetric'], summary['baselineValue'], summary['achievedValue'],
                    summary['targetValue'], summary['targetMet'],
                )
            except Exception as exc:  # noqa: BLE001 — one job must not kill the worker
                logger.exception('Job %s failed', job['id'])
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        UPDATE "TrainingJob"
                           SET status = 'FAILED', "completedAt" = NOW(),
                               "errorLog" = %s, "heartbeatAt" = NOW()
                         WHERE id = %s
                        """,
                        (str(exc)[:2000], job['id']),
                    )

        except Exception:  # noqa: BLE001 — survive DB blips
            logger.exception('Worker loop error — reconnecting in %.1fs', POLL_INTERVAL_S)
            time.sleep(POLL_INTERVAL_S)
            try:
                conn = _connect()
            except Exception:
                logger.exception('Reconnect failed')

    logger.info('Training worker %s stopped', WORKER_ID)
    return 0


if __name__ == '__main__':
    sys.exit(main())
