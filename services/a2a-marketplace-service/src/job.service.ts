/**
 * Job creation: prompt -> parsed requirements -> author confirmation -> Base.
 *
 * Two steps on purpose. The parsed document, not the prose, is what the escrow
 * settles against, so the author sees and accepts the interpretation before it
 * becomes an on-chain commitment. A one-shot "post this prompt" endpoint would
 * mean a misread threshold silently becomes the contract.
 *
 * This service owns job MEANING. It holds no chain key — posting is delegated
 * to base-chain-service, which holds the only Base signer.
 */

import { prisma } from '@ai-arena/db-client';
import {
  CONFIRMATION_THRESHOLD,
  buildRequirementDocument,
  computeJobId,
  extractDeterministic,
  formatUsdc,
  mergeExtractions,
  requirementsCanonicalJson,
  requirementsHash,
  verifyRequirementsHash,
  type ExtractedRequirements,
  type RequirementPredicate,
} from '@ai-arena/a2a-protocol';
import { getZeroGConfig, ZeroGComputeClient, ZeroGStorageClient } from '@ai-arena/zerog-client';

const storage = new ZeroGStorageClient(getZeroGConfig());
const compute = new ZeroGComputeClient(getZeroGConfig());

const BASE_CHAIN_SERVICE_URL = process.env.BASE_CHAIN_SERVICE_URL ?? 'http://localhost:8051';
const LLM_TIMEOUT_MS = 8_000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Timeout: ${label}`)), ms)),
  ]);
}

// ── Parsing ─────────────────────────────────────────────────────────────────

/**
 * Parse a prompt. Deterministic extraction always runs; the 0G Compute pass is
 * an optional enhancement that is reconciled against it.
 *
 * If 0G Compute is slow or down, job creation still works — a posting flow
 * that dies with an inference endpoint is a bad product, and the deterministic
 * parser is a complete answer on its own.
 */
export async function parsePrompt(prompt: string): Promise<ExtractedRequirements> {
  const deterministic = extractDeterministic(prompt);

  try {
    const parsed = await withTimeout(
      compute.extractJobRequirements(prompt),
      LLM_TIMEOUT_MS,
      'requirement extraction',
    );

    return mergeExtractions(
      prompt,
      {
        gameId: parsed.gameId,
        target: parsed.target as RequirementPredicate | null,
        providerRequirements: parsed.providerRequirements as RequirementPredicate[],
      },
      deterministic,
    );
  } catch (err) {
    console.warn('[a2a] 0G extraction unavailable, using deterministic parse:', (err as Error).message);
    return {
      ...deterministic,
      warnings: [...deterministic.warnings, 'Model-assisted parsing was unavailable; used pattern matching only.'],
    };
  }
}

// ── Draft ───────────────────────────────────────────────────────────────────

export interface CreateDraftInput {
  creatorAgentId: string;
  prompt: string;
  budgetMin: string;
  budgetMax: string;
  gameId?: string;
  target?: RequirementPredicate;
  providerRequirements?: RequirementPredicate[];
  executionWindowSeconds?: number;
}

/**
 * Parse and stage a job. Nothing is written on-chain here.
 *
 * Explicit `gameId`/`target`/`providerRequirements` override the parse, which
 * is how the confirmation UI submits corrections.
 */
export async function createDraft(input: CreateDraftInput) {
  const identity = await prisma.agentBaseIdentity.findUnique({
    where: { agentId: input.creatorAgentId },
  });
  if (!identity?.erc8004AgentId) {
    throw new Error(
      'Creator agent has no Base identity yet. Register it first: POST /v1/a2a/identity/agents/:id/register',
    );
  }

  const extraction = await parsePrompt(input.prompt);

  const gameId = input.gameId ?? extraction.gameId;
  const target = input.target ?? extraction.target;
  const providerRequirements = input.providerRequirements ?? extraction.providerRequirements;

  if (!gameId) throw new Error('Could not determine the game — please choose one explicitly.');
  if (!target) throw new Error('Could not determine a completion condition — please state a target explicitly.');

  const document = buildRequirementDocument({
    prompt: input.prompt,
    gameId,
    target,
    providerRequirements,
    budgetMin: input.budgetMin,
    budgetMax: input.budgetMax,
    executionWindowSeconds: input.executionWindowSeconds,
    creatorAgentId: identity.erc8004AgentId,
  });

  const hash = requirementsHash(document);
  const canonicalJson = requirementsCanonicalJson(document);
  const jobId = computeJobId({
    creatorAgentId: identity.erc8004AgentId,
    requirementsHash: hash,
    nonce: document.nonce,
  });

  const job = await prisma.a2AJob.create({
    data: {
      id: jobId,
      status: 'DRAFT',
      creatorAgentId: input.creatorAgentId,
      creatorErc8004Id: identity.erc8004AgentId,
      creatorWallet: identity.ownerWallet,
      gameId: document.gameId,
      prompt: document.prompt,
      requirementsJson: canonicalJson,
      requirementsHash: hash,
      targetMetric: document.target.metric,
      targetOp: document.target.op,
      targetValue: document.target.value,
      providerRequirements: document.providerRequirements as never,
      budgetMinBaseUnits: document.budget.minBaseUnits,
      budgetMaxBaseUnits: document.budget.maxBaseUnits,
      executionWindowSeconds: document.executionWindowSeconds,
      parseMethod: extraction.method,
      parseConfidence: extraction.confidence,
      parseWarnings: extraction.warnings as never,
    },
  });

  return {
    job: present(job),
    interpretation: {
      gameId: document.gameId,
      target: document.target,
      providerRequirements: document.providerRequirements,
      method: extraction.method,
      confidence: extraction.confidence,
      warnings: extraction.warnings,
      // Below the threshold the UI must treat this as a draft to edit, not a
      // proposal to accept.
      needsReview: extraction.confidence < CONFIRMATION_THRESHOLD || extraction.warnings.length > 0,
    },
  };
}

// ── Confirm and post ────────────────────────────────────────────────────────

/**
 * Publish a confirmed draft to Base.
 *
 * Order matters: the canonical bytes go to 0G Storage BEFORE the hash is
 * committed on-chain. Committing first would leave a window where the chain
 * references a document nobody can fetch.
 */
export async function confirmAndPost(jobId: string) {
  const job = await prisma.a2AJob.findUnique({ where: { id: jobId } });
  if (!job) throw new Error('Job not found');
  if (job.status !== 'DRAFT' && job.status !== 'FAILED') {
    throw new Error(`Job is ${job.status} and can no longer be posted`);
  }

  // Guard against a stored document that no longer hashes to its recorded
  // value — that would make the on-chain commitment unverifiable from day one.
  const check = verifyRequirementsHash(job.requirementsJson, job.requirementsHash);
  if (!check.valid) {
    throw new Error(`Stored requirements do not match their hash: ${check.reason}`);
  }

  let requirementsRootHash = job.requirementsRootHash;
  if (!requirementsRootHash) {
    try {
      const upload = await storage.uploadBuffer(Buffer.from(job.requirementsJson, 'utf8'));
      requirementsRootHash = upload.rootHash;
      await prisma.storageIndex.upsert({
        where: { logicalPath: `a2a/jobs/${jobId}/requirements/v1` },
        update: { rootHash: requirementsRootHash },
        create: {
          logicalPath: `a2a/jobs/${jobId}/requirements/v1`,
          rootHash: requirementsRootHash,
          mimeType: 'application/json',
          sizeBytes: Buffer.byteLength(job.requirementsJson, 'utf8'),
          uploadedBy: 'a2a-marketplace-service',
          tags: ['a2a', 'job-requirements', jobId],
        },
      });
    } catch (err) {
      // Non-fatal: the canonical bytes are already durable in Postgres and
      // served over HTTP. 0G Storage is a second, content-addressed copy.
      console.warn('[a2a] 0G Storage upload failed, continuing:', (err as Error).message);
    }
  }

  await prisma.a2AJob.update({
    where: { id: jobId },
    data: { status: 'POSTING', requirementsRootHash, lastError: null },
  });

  try {
    const response = await fetch(`${BASE_CHAIN_SERVICE_URL}/jobs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Key': process.env.INTERNAL_SERVICE_SECRET ?? '',
      },
      body: JSON.stringify({
        jobId: job.id,
        creatorAgentId: job.creatorErc8004Id,
        creatorWallet: job.creatorWallet,
        requirementsHash: job.requirementsHash,
        budgetMinBaseUnits: job.budgetMinBaseUnits,
        budgetMaxBaseUnits: job.budgetMaxBaseUnits,
        executionWindowSeconds: job.executionWindowSeconds,
      }),
    });

    if (!response.ok) {
      throw new Error(`base-chain-service responded ${response.status}: ${await response.text()}`);
    }

    const result = (await response.json()) as { txHash: string; blockNumber: number; explorer: string };

    const posted = await prisma.a2AJob.update({
      where: { id: jobId },
      data: {
        status: 'POSTED',
        postTxHash: result.txHash || null,
        postBlock: result.blockNumber ? BigInt(result.blockNumber) : null,
        onChainAt: new Date(),
      },
    });

    return { job: present(posted), explorer: result.explorer };
  } catch (err) {
    await prisma.a2AJob.update({
      where: { id: jobId },
      data: { status: 'FAILED', lastError: (err as Error).message },
    });
    throw err;
  }
}

// ── Reads ───────────────────────────────────────────────────────────────────

export async function getJob(jobId: string) {
  const job = await prisma.a2AJob.findUnique({ where: { id: jobId } });
  if (!job) return null;

  // Independent verification, computed on every read rather than cached: the
  // whole point is that it reflects the stored bytes right now.
  const verification = verifyRequirementsHash(job.requirementsJson, job.requirementsHash);

  let onChain: unknown = null;
  try {
    const response = await fetch(`${BASE_CHAIN_SERVICE_URL}/jobs/${jobId}`);
    if (response.ok) onChain = await response.json();
  } catch {
    // Chain read is best-effort; the off-chain record still stands alone.
  }

  return { job: present(job), verification, onChain };
}

/**
 * List jobs by lifecycle scope.
 *
 * Previously this returned only POSTED and NEGOTIATING, so a job disappeared
 * from the board the moment it was funded — the creator had no way to see work
 * in progress, and no record at all of anything that had settled. The
 * interesting half of the lifecycle was invisible.
 */
export async function listJobs(params: {
  gameId?: string;
  limit?: number;
  scope?: 'open' | 'active' | 'completed' | 'all';
}) {
  const BY_SCOPE = {
    open: ['POSTED', 'NEGOTIATING'],
    active: ['ESCROWED', 'EXECUTING', 'DELIVERED'],
    completed: ['SETTLED', 'REFUNDED', 'DISPUTED', 'CANCELLED'],
  } as const;

  const scope = params.scope ?? 'open';
  const statuses = scope === 'all'
    ? [...BY_SCOPE.open, ...BY_SCOPE.active, ...BY_SCOPE.completed]
    : BY_SCOPE[scope];

  const jobs = await prisma.a2AJob.findMany({
    where: {
      status: { in: statuses as never },
      ...(params.gameId ? { gameId: params.gameId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(params.limit ?? 50, 100),
  });

  // Counts for the tab badges, so an empty tab is distinguishable from a tab
  // the user has not looked at.
  const grouped = await prisma.a2AJob.groupBy({ by: ['status'], _count: true });
  const countFor = (list: readonly string[]) =>
    grouped.filter((g) => list.includes(g.status)).reduce((n, g) => n + g._count, 0);

  return {
    jobs: jobs.map(present),
    scope,
    counts: {
      open: countFor(BY_SCOPE.open),
      active: countFor(BY_SCOPE.active),
      completed: countFor(BY_SCOPE.completed),
    },
  };
}

/** @deprecated use listJobs — kept so existing callers keep working. */
export async function listOpenJobs(params: { gameId?: string; limit?: number }) {
  return listJobs({ ...params, scope: 'open' });
}

/** The exact canonical bytes whose hash is on-chain. Served verbatim. */
export async function getRequirementsDocument(jobId: string): Promise<string | null> {
  const job = await prisma.a2AJob.findUnique({
    where: { id: jobId },
    select: { requirementsJson: true },
  });
  return job?.requirementsJson ?? null;
}

type JobRow = Awaited<ReturnType<typeof prisma.a2AJob.findUniqueOrThrow>>;

function present(job: JobRow) {
  return {
    id: job.id,
    status: job.status,
    gameId: job.gameId,
    prompt: job.prompt,
    creatorAgentId: job.creatorAgentId,
    creatorErc8004Id: job.creatorErc8004Id,
    requirementsHash: job.requirementsHash,
    requirementsRootHash: job.requirementsRootHash,
    target: { metric: job.targetMetric, op: job.targetOp, value: job.targetValue },
    providerRequirements: job.providerRequirements,
    budget: {
      minBaseUnits: job.budgetMinBaseUnits,
      maxBaseUnits: job.budgetMaxBaseUnits,
      // Base units are the source of truth; these are for display only.
      min: formatUsdc(job.budgetMinBaseUnits),
      max: formatUsdc(job.budgetMaxBaseUnits),
      currency: 'USDC',
    },
    executionWindowSeconds: job.executionWindowSeconds,
    parse: {
      method: job.parseMethod,
      confidence: job.parseConfidence,
      warnings: job.parseWarnings,
    },
    // The later half of the lifecycle. Omitting these left a DELIVERED job

    // looking empty in the UI while the chain already held its result hash.

    agreedPrice: job.agreedPriceBaseUnits

      ? { baseUnits: job.agreedPriceBaseUnits, display: formatUsdc(job.agreedPriceBaseUnits), currency: 'USDC' }

      : null,

    providerAgentId: job.providerAgentId,

    providerErc8004Id: job.providerErc8004Id,

    agreementHash: job.agreementHash,

    deliverableHash: job.deliverableHash,

    verifiedValue: job.verifiedValue,

    verdict: job.verdictAccepted === null || job.verdictAccepted === undefined

      ? null

      : { accepted: job.verdictAccepted, reason: job.verdictReason, reportHash: job.verdictReportHash },

    tx: {

      post: job.postTxHash,

      fund: job.fundTxHash,

      executing: job.executingTxHash,

      deliver: job.deliverTxHash,

      verdict: job.verdictTxHash,

      reputation: job.reputationTxHash,

    },

    fundedAt: job.fundedAt,

    deliveredAt: job.deliveredAt,

    settledAt: job.settledAt,

    postTxHash: job.postTxHash,
    postBlock: job.postBlock ? job.postBlock.toString() : null,
    explorer: job.postTxHash ? `https://basescan.org/tx/${job.postTxHash}` : null,
    lastError: job.lastError,
    createdAt: job.createdAt,
  };
}
