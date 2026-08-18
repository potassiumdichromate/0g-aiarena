"""
Runs a trait-training job and streams real progress back to Postgres.

Replaces the fabrication that was here before:

  - rl_trainer.run_ppo_training     trained CartPole-v1, slept 2s, returned a
                                    hardcoded episode_reward_mean of 250.3
  - behaviour_cloning.run_bc_training  had every real line commented out, slept
                                    2s, returned a hardcoded loss/accuracy

Both are left in place untouched (they are still referenced by the LORA_FINETUNE
path in training_job.py, which is a separate 0G Compute concern) but nothing in
the trait-training flow calls them.

Job dispatch is a DB CLAIM, not a NATS subscription. This repo already learned
that NATS delivery is unreliable on Render's starter plan — agent.service.ts
mints INFTs over direct HTTP for exactly that reason. NATS is still published
to for anything that wants to observe, but correctness never depends on it.
"""

from __future__ import annotations

import json
import logging
import os
import socket
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any, Dict, Optional

import psycopg
from psycopg.types.json import Jsonb

from trait_training.pipeline import ProgressEvent, TrainingPlan, run_training_job

logger = logging.getLogger(__name__)

WORKER_ID = f'{socket.gethostname()}-{uuid.uuid4().hex[:8]}'

# Serve only paid marketplace work.
#
# autonomous-loop.ts has been auto-queueing background training for every
# autonomous agent with nothing consuming it, leaving a backlog of over a
# thousand jobs. At roughly 25 minutes each on a starter dyno that is weeks of
# compute, and a marketplace job entering that queue is starved regardless of
# its priority — one whose escrow carries a six-hour deadline would time out
# and refund while the worker ground through backlog.
#
# Paid work has a deadline and a counterparty; background training has neither.
# Set TRAINING_MARKETPLACE_ONLY=false on a separate worker to drain the backlog.
MARKETPLACE_ONLY = os.environ.get('TRAINING_MARKETPLACE_ONLY', 'true').lower() != 'false'

# Heartbeats are what let the service distinguish "running" from "dead". Too
# frequent and every PPO iteration becomes a write; too rare and a dead worker
# holds its job for ages. One per stage step, rate-limited to this interval.
HEARTBEAT_MIN_INTERVAL_S = 2.0


def _connect() -> psycopg.Connection:
    dsn = os.environ.get('DATABASE_URL')
    if not dsn:
        raise RuntimeError('DATABASE_URL is not set')
    return psycopg.connect(dsn, autocommit=True)


def claim_next_job(conn: psycopg.Connection) -> Optional[Dict[str, Any]]:
    """
    Atomically claim one queued trait-training job.

    `FOR UPDATE SKIP LOCKED` is what makes several workers safe to run at once:
    each takes a different row instead of contending for the same one. The
    UPDATE and the SELECT are one statement so there is no window in which two
    workers both believe they own the job.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE "TrainingJob" AS j
               SET status      = 'RUNNING',
                   "claimedBy" = %s,
                   "claimedAt" = NOW(),
                   "heartbeatAt" = NOW(),
                   "startedAt" = COALESCE(j."startedAt", NOW()),
                   stage       = 'claimed',
                   progress    = 0
             WHERE j.id = (
                   SELECT c.id
                     FROM "TrainingJob" c
                    WHERE c.status = 'QUEUED'
                      AND c.type IN ('BEHAVIOUR_CLONING', 'REINFORCEMENT_LEARNING')
                      AND (NOT %s OR c.config -> 'marketplaceJobId' IS NOT NULL)
                    ORDER BY c.priority ASC, c."createdAt" ASC
                    FOR UPDATE SKIP LOCKED
                    LIMIT 1
             )
            RETURNING j.id, j."agentId", j.type, j.config
            """,
            (WORKER_ID, MARKETPLACE_ONLY),
        )
        row = cur.fetchone()

    if row is None:
        return None
    return {'id': row[0], 'agentId': row[1], 'type': row[2], 'config': row[3] or {}}


def requeue_stale_jobs(conn: psycopg.Connection, stale_after_seconds: int = 300) -> int:
    """
    Return jobs whose worker died back to the queue.

    Without this a crashed worker strands its job in RUNNING forever, and the
    marketplace job waiting on it can only ever time out.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE "TrainingJob"
               SET status = 'QUEUED', "claimedBy" = NULL, "claimedAt" = NULL,
                   stage = NULL, progress = NULL,
                   "errorLog" = COALESCE("errorLog", '') || 'requeued: worker heartbeat went stale; '
             WHERE status = 'RUNNING'
               AND "heartbeatAt" IS NOT NULL
               AND "heartbeatAt" < NOW() - make_interval(secs => %s)
            """,
            (stale_after_seconds,),
        )
        return cur.rowcount or 0


def _plan_from_config(config: Dict[str, Any]) -> TrainingPlan:
    """
    Build the curriculum from the job config.

    Every field is the trainer's lever. Defaults are the demo-sized budget;
    a marketplace job overrides them with whatever the provider agent chose,
    which is precisely the skill it is being paid for.
    """
    plan = TrainingPlan()
    mapping = {
        'demonstrationEpisodes': 'demonstration_episodes',
        'demonstrationDifficulties': 'demonstration_difficulties',
        'bcEpochs': 'bc_epochs',
        'bcLearningRate': 'bc_learning_rate',
        'ppoIterations': 'ppo_iterations',
        'ppoNumEnvs': 'ppo_num_envs',
        'ppoStepsPerEnv': 'ppo_steps_per_env',
        'ppoLearningRate': 'ppo_learning_rate',
        'ppoEntropyCoef': 'ppo_entropy_coef',
        'ppoDifficulties': 'ppo_difficulties',
        'evalEpisodesPerDifficulty': 'eval_episodes_per_difficulty',
        'seed': 'seed',
    }
    for wire_name, attr in mapping.items():
        if wire_name in config and config[wire_name] is not None:
            setattr(plan, attr, config[wire_name])
    return plan


class ProgressReporter:
    """Writes real worker progress to the job row, rate-limited."""

    def __init__(self, conn: psycopg.Connection, job_id: str):
        self.conn = conn
        self.job_id = job_id
        self._last_write = 0.0

    def __call__(self, event: ProgressEvent) -> None:
        now = time.monotonic()
        is_stage_end = event.stage_step >= event.stage_total
        if not is_stage_end and (now - self._last_write) < HEARTBEAT_MIN_INTERVAL_S:
            return
        self._last_write = now

        # Surface whatever live metric the stage produces, so the UI can show
        # the score moving mid-run instead of a spinner.
        detail = {k: v for k, v in event.detail.items() if isinstance(v, (int, float, str, bool))}

        with self.conn.cursor() as cur:
            cur.execute(
                """
                UPDATE "TrainingJob"
                   SET stage = %s, "stageStep" = %s, "stageTotal" = %s,
                       progress = %s, "currentMetric" = %s, "heartbeatAt" = NOW()
                 WHERE id = %s
                """,
                (
                    event.stage, event.stage_step, event.stage_total,
                    round(event.overall_fraction, 4), Jsonb(detail), self.job_id,
                ),
            )

    def cancelled(self) -> bool:
        """True if someone cancelled the job while it was running."""
        with self.conn.cursor() as cur:
            cur.execute('SELECT status FROM "TrainingJob" WHERE id = %s', (self.job_id,))
            row = cur.fetchone()
        return row is not None and row[0] == 'CANCELLED'


def _persist_snapshot(
    conn: psycopg.Connection, agent_id: str, job_id: str, kind: str, report: Dict[str, Any],
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO "AgentCapabilitySnapshot"
              (id, "agentId", "trainingJobId", kind, "formulaVersion", "protocolVersion",
               "combatSkill", traits, components, counters, "seedRoot", seeds, difficulties,
               "episodesRun", "checkpointDigest", "reportDigest", "createdAt")
            VALUES (gen_random_uuid()::text, %s, %s, %s::"CapabilitySnapshotKind", %s, %s,
                    %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW())
            """,
            (
                agent_id, job_id, kind,
                report['formulaVersion'], report['protocolVersion'], report['combatSkill'],
                Jsonb(report['traits']), Jsonb(report['components']), Jsonb(report['counters']),
                str(report['seedRoot']), Jsonb(report['seeds']), Jsonb(report['difficulties']),
                report['episodesRun'], report.get('checkpointDigest'),
                _report_digest(report),
            ),
        )


def _report_digest(report: Dict[str, Any]) -> str:
    import hashlib
    encoded = json.dumps(report, sort_keys=True, separators=(',', ':')).encode('utf-8')
    return f'sha256:{hashlib.sha256(encoded).hexdigest()}'


def _persist_artifact(conn: psycopg.Connection, training_job_id: str, path: Path, digest: str) -> None:
    """
    Store the trained checkpoint so it outlives this instance.

    Render's disk is ephemeral. A deploy between training and verification
    destroyed the artifact, and verification then had nothing to measure —
    which stalls settlement on a job whose escrow is already funded.
    """
    data = path.read_bytes()
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO "TrainingArtifact" (id, "trainingJobId", digest, "sizeBytes", bytes, "createdAt")
            VALUES (gen_random_uuid()::text, %s, %s, %s, %s, NOW())
            ON CONFLICT ("trainingJobId") DO UPDATE
               SET digest = EXCLUDED.digest,
                   "sizeBytes" = EXCLUDED."sizeBytes",
                   bytes = EXCLUDED.bytes
            """,
            (training_job_id, digest, len(data), data),
        )
    logger.info('Stored artifact for job %s (%s, %.1f KB)', training_job_id, digest[:19], len(data) / 1024)


def execute_job(conn: psycopg.Connection, job: Dict[str, Any], checkpoint_dir: Path) -> Dict[str, Any]:
    """Run one claimed job to completion and record its results."""
    config = job['config'] if isinstance(job['config'], dict) else json.loads(job['config'])
    reporter = ProgressReporter(conn, job['id'])

    outcome = run_training_job(
        checkpoint_path=str(checkpoint_dir / f"{job['id']}.pt"),
        trainer_checkpoint_path=config.get('trainerCheckpointPath'),
        student_checkpoint_path=config.get('studentCheckpointPath'),
        eval_seed_root=int(config.get('evalSeedRoot', 0)),
        target_metric=config.get('targetMetric', 'combatSkill'),
        target_value=config.get('targetValue'),
        plan=_plan_from_config(config),
        on_progress=reporter,
        should_stop=reporter.cancelled,
    )

    summary = outcome.summary()

    # Persist before marking COMPLETED: a job reported complete whose artifact
    # was never stored cannot be verified, and its escrow would sit until it
    # timed out.
    _persist_artifact(conn, job['id'], Path(outcome.checkpoint_path), outcome.checkpoint_digest)
    _persist_snapshot(conn, job['agentId'], job['id'], 'BASELINE', outcome.baseline.to_dict())
    _persist_snapshot(conn, job['agentId'], job['id'], 'FINAL', outcome.final.to_dict())

    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE "TrainingJob"
               SET status = 'COMPLETED', "completedAt" = NOW(), metrics = %s,
                   stage = 'complete', progress = 1, "heartbeatAt" = NOW()
             WHERE id = %s
            """,
            (Jsonb(summary), job['id']),
        )

    return summary
