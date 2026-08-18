"""
Independent verification of a delivered marketplace job.

This is the step that decides whether a provider gets paid, so it is
deliberately NOT a re-read of anything the provider produced. It loads the
delivered checkpoint and re-runs the seeded evaluation itself, under a seed
root the provider could not have known while training.

Three properties, each of which exists because its absence is exploitable:

  1. **Fresh seed root.** Generated here, at verification time, and recorded in
     the snapshot. A provider that overfits to the seeds it trained against
     still fails, because it never saw these (threat T18). Recording the root
     keeps the run reproducible by anyone afterwards — unpredictable in advance
     is not the same as secret.

  2. **Checkpoint digest is checked against the on-chain commitment.** The
     provider committed a deliverableHash when it delivered. If the artifact on
     disk hashes to something else, it swapped the file after committing, and
     verification fails rather than measuring the wrong model.

  3. **The provider never supplies the score.** evaluation-service refuses to
     settle on a FINAL snapshot (the provider's own measurement) and only
     accepts a VERIFICATION one, which only this module writes.
"""

from __future__ import annotations

import json
import logging
import os
import secrets
from pathlib import Path
from typing import Any, Dict, Optional

import psycopg
from psycopg.types.json import Jsonb

from trait_training.evaluate import evaluate_checkpoint
from trait_training.policy import checkpoint_digest

logger = logging.getLogger(__name__)

WORKER_ID = os.environ.get('RENDER_INSTANCE_ID') or os.environ.get('HOSTNAME') or 'local'

# Episodes per difficulty for verification. Matches the training-time default
# so the two measurements are directly comparable — a verification run over a
# different episode count would not be a like-for-like check.
VERIFY_EPISODES_PER_DIFFICULTY = int(os.environ.get('VERIFY_EPISODES_PER_DIFFICULTY', '10'))


def claim_next_verification(conn: psycopg.Connection) -> Optional[Dict[str, Any]]:
    """
    Atomically claim one delivered job awaiting verification.

    Same FOR UPDATE SKIP LOCKED pattern as training claims, so multiple workers
    are safe. `verificationClaimedBy` is set in the same statement as the
    select, leaving no window where two workers both think they own the job.
    """
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE "A2AJob" AS j
               SET "verificationClaimedBy" = %s,
                   "verificationClaimedAt" = NOW()
             WHERE j.id = (
                   SELECT c.id
                     FROM "A2AJob" c
                    WHERE c.status = 'DELIVERED'
                      AND c."verificationSnapshotId" IS NULL
                      AND (
                            c."verificationClaimedAt" IS NULL
                            -- A claim older than 15 minutes belonged to a
                            -- worker that died mid-verification.
                         OR c."verificationClaimedAt" < NOW() - INTERVAL '15 minutes'
                      )
                    ORDER BY c."deliveredAt" ASC NULLS LAST
                    FOR UPDATE SKIP LOCKED
                    LIMIT 1
             )
            RETURNING j.id, j."providerAgentId", j."creatorAgentId", j."trainingJobId",
                      j."deliverableHash", j."targetMetric", j."targetValue", j."gameId"
            """,
            (WORKER_ID,),
        )
        row = cur.fetchone()

    if row is None:
        return None

    return {
        'id': row[0],
        'providerAgentId': row[1],
        'creatorAgentId': row[2],
        'trainingJobId': row[3],
        'deliverableHash': row[4],
        'targetMetric': row[5],
        'targetValue': row[6],
        'gameId': row[7],
    }


def _report_digest(report: Dict[str, Any]) -> str:
    import hashlib
    encoded = json.dumps(report, sort_keys=True, separators=(',', ':')).encode('utf-8')
    return f'sha256:{hashlib.sha256(encoded).hexdigest()}'


def _persist_verification_snapshot(
    conn: psycopg.Connection, agent_id: str, training_job_id: Optional[str], report: Dict[str, Any],
) -> str:
    """Write the VERIFICATION snapshot and return its id."""
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO "AgentCapabilitySnapshot"
              (id, "agentId", "trainingJobId", kind, "formulaVersion", "protocolVersion",
               "combatSkill", traits, components, counters, "seedRoot", seeds, difficulties,
               "episodesRun", "checkpointDigest", "reportDigest", "createdAt")
            VALUES (gen_random_uuid()::text, %s, %s, 'VERIFICATION'::"CapabilitySnapshotKind", %s, %s,
                    %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW())
            RETURNING id
            """,
            (
                agent_id, training_job_id,
                report['formulaVersion'], report['protocolVersion'], report['combatSkill'],
                Jsonb(report['traits']), Jsonb(report['components']), Jsonb(report['counters']),
                str(report['seedRoot']), Jsonb(report['seeds']), Jsonb(report['difficulties']),
                report['episodesRun'], report.get('checkpointDigest'),
                _report_digest(report),
            ),
        )
        return cur.fetchone()[0]


def _fail_verification(conn: psycopg.Connection, job_id: str, reason: str) -> None:
    """
    Record why verification could not proceed.

    The job is deliberately left in DELIVERED rather than being failed outright:
    the escrow's timeout refund is the creator's guaranteed exit, and marking a
    terminal state off-chain would not move the money anyway. Releasing the
    claim lets a later run retry after the underlying problem is fixed.
    """
    logger.error('Verification failed for job %s: %s', job_id, reason)
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE "A2AJob"
               SET "lastError" = %s,
                   "verificationClaimedBy" = NULL,
                   "verificationClaimedAt" = NULL
             WHERE id = %s
            """,
            (f'verification: {reason}', job_id),
        )


def _restore_artifact(conn: psycopg.Connection, training_job_id: str, dest: Path) -> bool:
    """
    Fetch the delivered checkpoint from storage onto this worker.

    Verification routinely runs on a different instance than training — the
    two are separated by minutes and often by a deploy — so the artifact must
    be retrieved rather than assumed present.
    """
    with conn.cursor() as cur:
        cur.execute(
            'SELECT bytes FROM "TrainingArtifact" WHERE "trainingJobId" = %s',
            (training_job_id,),
        )
        row = cur.fetchone()

    if row is None:
        return False

    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(bytes(row[0]))
    logger.info('Restored artifact for job %s (%.1f KB)', training_job_id, dest.stat().st_size / 1024)
    return True


def execute_verification(
    conn: psycopg.Connection, job: Dict[str, Any], checkpoint_dir: Path,
) -> Optional[Dict[str, Any]]:
    """
    Re-run the evaluation on a delivered checkpoint and record the result.

    Returns the snapshot summary, or None when verification could not run — in
    which case the reason is written to A2AJob.lastError and the claim released.
    """
    job_id = job['id']
    training_job_id = job['trainingJobId']

    if not training_job_id:
        _fail_verification(conn, job_id, 'no trainingJobId — nothing was ever executed for this job')
        return None

    checkpoint_path = checkpoint_dir / f'{training_job_id}.pt'
    if not checkpoint_path.exists() and not _restore_artifact(conn, training_job_id, checkpoint_path):
        _fail_verification(
            conn, job_id,
            f'no stored artifact for training job {training_job_id}. The checkpoint was '
            'never persisted, so the delivered work cannot be re-evaluated.',
        )
        return None

    # The artifact must be the one that was committed on-chain.
    actual_digest = checkpoint_digest(str(checkpoint_path))
    committed = job.get('deliverableHash')
    if committed and committed != actual_digest:
        _fail_verification(
            conn, job_id,
            f'checkpoint digest {actual_digest} does not match the committed deliverableHash '
            f'{committed} — the artifact changed after delivery',
        )
        return None

    # Fresh, unpredictable, and recorded. The provider trained against a
    # different root and could not have overfitted to this one.
    seed_root = secrets.randbelow(2 ** 31)
    logger.info(
        'Verifying job %s: checkpoint %s, seed root %d (independent of training)',
        job_id, checkpoint_path.name, seed_root,
    )

    report = evaluate_checkpoint(
        str(checkpoint_path),
        seed_root=seed_root,
        episodes_per_difficulty=VERIFY_EPISODES_PER_DIFFICULTY,
    )
    report_dict = report.to_dict()

    snapshot_id = _persist_verification_snapshot(
        conn, job['creatorAgentId'], training_job_id, report_dict,
    )

    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE "A2AJob"
               SET "verificationSnapshotId" = %s,
                   "verificationClaimedBy" = NULL,
                   "verificationClaimedAt" = NULL,
                   "lastError" = NULL
             WHERE id = %s
            """,
            (snapshot_id, job_id),
        )

    measured = report.measurement.combat_skill
    if job['targetMetric'] != 'combatSkill':
        traits = report.measurement.traits.to_dict()
        measured = traits.get(job['targetMetric'])

    logger.info(
        'Job %s verified: %s measured %s against target %s (snapshot %s). '
        'evaluation-service will settle.',
        job_id, job['targetMetric'], measured, job['targetValue'], snapshot_id,
    )

    return {
        'jobId': job_id,
        'snapshotId': snapshot_id,
        'seedRoot': seed_root,
        'targetMetric': job['targetMetric'],
        'targetValue': job['targetValue'],
        'measuredValue': measured,
        # Advisory only. The verdict is the escrow's, rendered by
        # evaluation-service, which re-reads this snapshot and holds the key.
        'wouldPass': measured is not None and job['targetValue'] is not None
                     and measured >= job['targetValue'],
    }
