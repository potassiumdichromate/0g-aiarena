/**
 * Negotiation orchestration.
 *
 * Every message written here is signed by the agent that authored it. This
 * service composes payloads and holds the transcript, but never a key —
 * signing is delegated to base-chain-service, which owns the encrypted agent
 * EOAs. That boundary is why a compromise of the marketplace service cannot
 * forge a counterparty's position.
 *
 * The stored transcript is treated as untrusted on every read: `loadMessages`
 * hands the raw rows to `verifyTranscript`, which rebuilds the hash chain from
 * the message contents rather than believing the stored digests. A row edited
 * directly in the database fails verification instead of silently changing
 * what the parties agreed.
 */

import { prisma } from '@ai-arena/db-client';
import {
  AGREEMENT_TYPES,
  OFFER_TYPES,
  agreementDigest,
  assertValidNext,
  buildDomain,
  buildNextOffer,
  decideProviderResponse,
  deriveState,
  formatUsdc,
  recoverOfferSigner,
  verifyTranscript,
  type A2ADomain,
  type Agreement,
  type Offer,
  type OfferKind,
  type OfferRole,
  type SignedOffer,
} from '@ai-arena/a2a-protocol';
import { computeProfile, matchAgent } from '@ai-arena/capability';

const BASE_CHAIN_SERVICE_URL = process.env.BASE_CHAIN_SERVICE_URL ?? 'http://localhost:8051';
/**
 * How long a signed agreement stays fundable.
 *
 * The expiry is baked into the EIP-712 signature and enforced on-chain, so an
 * expired agreement cannot be extended — it has to be re-signed by both agents.
 * One hour was too short: funding is a human action requiring a wallet, and an
 * agreement signed while the creator was away from their desk was dead before
 * they returned.
 *
 * A day is long enough for that, and short enough that a price agreed on stale
 * information does not stay fundable indefinitely.
 */
const AGREEMENT_TTL_SECONDS = 24 * 60 * 60;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * The EIP-712 domain. Requires the deployed escrow address: a signature is
 * bound to one contract on one chain, so there is no safe default here.
 */
function domain(): A2ADomain {
  const escrow = process.env.A2A_JOB_ESCROW_ADDRESS;
  if (!escrow) {
    throw new Error(
      'A2A_JOB_ESCROW_ADDRESS is not set. Signatures are bound to a specific escrow deployment ' +
        'and cannot be produced without knowing which one.',
    );
  }
  const chainId = Number(process.env.BASE_CHAIN_ID ?? 8453);
  return buildDomain(escrow, chainId);
}

// ── Signing (delegated) ─────────────────────────────────────────────────────

async function signTypedDataAsAgent(
  agentId: string,
  types: Record<string, ReadonlyArray<{ name: string; type: string }>>,
  value: Record<string, unknown>,
): Promise<{ signature: string; signer: string; digest: string }> {
  const response = await fetch(`${BASE_CHAIN_SERVICE_URL}/identity/agents/${agentId}/sign-typed-data`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Service-Key': process.env.INTERNAL_SERVICE_SECRET ?? '',
    },
    body: JSON.stringify({ domain: domain(), types, value }),
  });

  if (!response.ok) {
    throw new Error(`Signing failed (${response.status}): ${await response.text()}`);
  }
  return response.json() as Promise<{ signature: string; signer: string; digest: string }>;
}

// ── Transcript access ───────────────────────────────────────────────────────

async function loadMessages(negotiationId: string): Promise<SignedOffer[]> {
  const rows = await prisma.a2ANegotiationMessage.findMany({
    where: { negotiationId },
    orderBy: { seq: 'asc' },
  });

  return rows.map((row) => ({
    offer: {
      jobId: row.jobId,
      agentId: row.agentErc8004Id,
      role: row.role as OfferRole,
      kind: row.kind as OfferKind,
      priceBaseUnits: row.priceBaseUnits,
      note: row.note,
      seq: row.seq,
      prevHash: row.prevHash,
      expiresAt: row.expiresAt,
    },
    signature: row.signature,
    digest: row.digest,
    signerAddress: row.signerAddress,
  }));
}

async function requireJob(jobId: string) {
  const job = await prisma.a2AJob.findUnique({ where: { id: jobId } });
  if (!job) throw new Error('Job not found');
  return job;
}

// ── Opening a negotiation ───────────────────────────────────────────────────

/**
 * A provider opens a thread on a job.
 *
 * Eligibility is re-derived server-side from the provider's capability profile
 * before the thread is allowed. The provider's own claim about its combat
 * skill is never accepted — that check is the whole point of matching.
 */
export async function openNegotiation(params: { jobId: string; providerAgentId: string }) {
  const job = await requireJob(params.jobId);
  if (job.status !== 'POSTED' && job.status !== 'NEGOTIATING') {
    throw new Error(`Job is ${job.status} and is not accepting proposals`);
  }

  const identity = await prisma.agentBaseIdentity.findUnique({
    where: { agentId: params.providerAgentId },
  });
  if (!identity?.erc8004AgentId) {
    throw new Error('Provider agent has no Base identity — register it before proposing');
  }

  // Recomputed server-side from real battle history and evaluation snapshots.
  // The provider's own claim about its capability is never an input here.
  const profile = await computeProfile(prisma, params.providerAgentId, job.gameId);
  if (!profile) throw new Error(`Agent ${params.providerAgentId} not found`);

  const match = matchAgent(profile, job.providerRequirements as never);
  if (!match.eligible) {
    throw new Error(`Agent does not meet this job's requirements: ${match.failureSummary}`);
  }

  const existing = await prisma.a2ANegotiation.findUnique({
    where: { jobId_providerAgentId: { jobId: params.jobId, providerAgentId: params.providerAgentId } },
  });
  if (existing) return present(existing, await loadMessages(existing.id));

  const negotiation = await prisma.a2ANegotiation.create({
    data: {
      jobId: params.jobId,
      providerAgentId: params.providerAgentId,
      providerErc8004Id: identity.erc8004AgentId,
      providerWallet: identity.eoaAddress,
    },
  });

  if (job.status === 'POSTED') {
    await prisma.a2AJob.update({ where: { id: job.id }, data: { status: 'NEGOTIATING' } });
  }

  return present(negotiation, []);
}

// ── Appending a message ─────────────────────────────────────────────────────

/**
 * Append one signed offer.
 *
 * Order of operations matters: validate against the current transcript FIRST,
 * sign second, persist third. Signing before validating would leave a valid
 * signature over a message we then refuse — which an agent could replay later
 * to claim a position it was never allowed to take.
 */
export async function appendOffer(params: {
  negotiationId: string;
  role: OfferRole;
  kind: OfferKind;
  priceBaseUnits?: string;
  note?: string;
  ttlSeconds?: number;
}) {
  const negotiation = await prisma.a2ANegotiation.findUniqueOrThrow({
    where: { id: params.negotiationId },
  });
  const job = await requireJob(negotiation.jobId);
  const messages = await loadMessages(negotiation.id);

  // Reject work built on a transcript that no longer verifies.
  const verification = verifyTranscript(domain(), messages);
  if (!verification.valid) {
    throw new Error(
      `Existing transcript failed verification and cannot be extended: ${verification.issues
        .map((i) => `#${i.seq} ${i.reason}`)
        .join('; ')}`,
    );
  }

  const signerAgentId = params.role === 'CREATOR' ? job.creatorAgentId : negotiation.providerAgentId;
  const signerErc8004Id =
    params.role === 'CREATOR' ? job.creatorErc8004Id : negotiation.providerErc8004Id;

  const offer: Offer = buildNextOffer({
    messages,
    jobId: job.id,
    agentId: signerErc8004Id,
    role: params.role,
    kind: params.kind,
    priceBaseUnits: params.priceBaseUnits ?? '0',
    note: params.note,
    ttlSeconds: params.ttlSeconds,
    nowSeconds: nowSeconds(),
  });

  assertValidNext({
    messages,
    next: offer,
    budgetMinBaseUnits: job.budgetMinBaseUnits,
    budgetMaxBaseUnits: job.budgetMaxBaseUnits,
    nowSeconds: nowSeconds(),
  });

  const signed = await signTypedDataAsAgent(signerAgentId, OFFER_TYPES as never, offer as never);

  await prisma.a2ANegotiationMessage.create({
    data: {
      negotiationId: negotiation.id,
      jobId: job.id,
      seq: offer.seq,
      role: offer.role,
      kind: offer.kind,
      priceBaseUnits: offer.priceBaseUnits,
      note: offer.note,
      prevHash: offer.prevHash,
      digest: signed.digest,
      signature: signed.signature,
      signerAddress: signed.signer,
      agentErc8004Id: offer.agentId,
      expiresAt: offer.expiresAt,
    },
  });

  const updated = await loadMessages(negotiation.id);
  const view = deriveState(updated, nowSeconds());

  const refreshed = await prisma.a2ANegotiation.update({
    where: { id: negotiation.id },
    data: {
      state: view.state,
      agreedPriceBaseUnits: view.agreedPriceBaseUnits,
      transcriptHash: view.transcriptHash,
    },
  });

  return present(refreshed, updated);
}

/**
 * Let the provider agent decide and play its own move.
 *
 * This is the autonomous path: the policy is deterministic, so a disputed
 * negotiation can be replayed and the same decision reproduced.
 */
export async function providerRespond(params: {
  negotiationId: string;
  floorBaseUnits: string;
  openingFraction?: number;
  concessionRate?: number;
}) {
  const negotiation = await prisma.a2ANegotiation.findUniqueOrThrow({
    where: { id: params.negotiationId },
  });
  const job = await requireJob(negotiation.jobId);
  const messages = await loadMessages(negotiation.id);

  const decision = decideProviderResponse({
    messages,
    policy: {
      floorBaseUnits: params.floorBaseUnits,
      openingFraction: params.openingFraction,
      concessionRate: params.concessionRate,
    },
    budgetMinBaseUnits: job.budgetMinBaseUnits,
    budgetMaxBaseUnits: job.budgetMaxBaseUnits,
  });

  if (decision.kind === 'DECLINE') {
    const result = await appendOffer({
      negotiationId: negotiation.id, role: 'PROVIDER', kind: 'DECLINE', note: decision.reason,
    });
    return { decision, negotiation: result };
  }

  const result = await appendOffer({
    negotiationId: negotiation.id,
    role: 'PROVIDER',
    kind: messages.length === 0 ? 'PROPOSE' : decision.kind,
    priceBaseUnits: decision.priceBaseUnits,
    note: decision.reason,
  });

  return { decision, negotiation: result };
}

// ── Agreement ───────────────────────────────────────────────────────────────

/**
 * Both agents sign the agreed terms.
 *
 * The agreement binds the transcript hash, so the negotiation that produced
 * the price cannot be swapped afterwards. Phase 6's
 * fundWithAuthorization re-verifies both signatures on-chain before any USDC
 * moves — these signatures are the authority for the payment, not a receipt
 * for one.
 */
export async function signAgreement(negotiationId: string) {
  const negotiation = await prisma.a2ANegotiation.findUniqueOrThrow({ where: { id: negotiationId } });
  const job = await requireJob(negotiation.jobId);
  const messages = await loadMessages(negotiationId);

  const verification = verifyTranscript(domain(), messages);
  if (!verification.valid) {
    throw new Error(
      `Transcript failed verification: ${verification.issues.map((i) => `#${i.seq} ${i.reason}`).join('; ')}`,
    );
  }

  const view = deriveState(messages, nowSeconds());
  if (view.state !== 'AGREED' || !view.agreedPriceBaseUnits) {
    throw new Error(`Negotiation is ${view.state} — there is no agreed price to sign`);
  }

  const agreement: Agreement = {
    jobId: job.id,
    creatorAgentId: job.creatorErc8004Id,
    providerAgentId: negotiation.providerErc8004Id,
    providerWallet: negotiation.providerWallet,
    agreedPrice: view.agreedPriceBaseUnits,
    requirementsHash: job.requirementsHash,
    executionWindow: job.executionWindowSeconds,
    transcriptHash: view.transcriptHash,
    expiry: nowSeconds() + AGREEMENT_TTL_SECONDS,
  };

  const creator = await signTypedDataAsAgent(job.creatorAgentId, AGREEMENT_TYPES as never, agreement as never);
  const provider = await signTypedDataAsAgent(
    negotiation.providerAgentId, AGREEMENT_TYPES as never, agreement as never,
  );

  const expected = agreementDigest(domain(), agreement);
  if (creator.digest !== expected || provider.digest !== expected) {
    // Both signers must have signed the identical digest. A mismatch means the
    // signing service saw different bytes than we composed.
    throw new Error('Signature digests do not match the composed agreement');
  }

  const updated = await prisma.a2ANegotiation.update({
    where: { id: negotiationId },
    data: {
      agreementHash: expected,
      agreementExpiry: agreement.expiry,
      creatorSignature: creator.signature,
      providerSignature: provider.signature,
    },
  });

  return {
    negotiation: present(updated, messages),
    agreement,
    agreementHash: expected,
    signatures: { creator: creator.signature, provider: provider.signature },
  };
}

// ── Reads ───────────────────────────────────────────────────────────────────

export async function getNegotiation(negotiationId: string) {
  const negotiation = await prisma.a2ANegotiation.findUnique({ where: { id: negotiationId } });
  if (!negotiation) return null;
  return present(negotiation, await loadMessages(negotiationId));
}

export async function listForJob(jobId: string) {
  const rows = await prisma.a2ANegotiation.findMany({
    where: { jobId },
    orderBy: { createdAt: 'asc' },
  });
  return {
    negotiations: await Promise.all(rows.map(async (r) => present(r, await loadMessages(r.id)))),
  };
}

type NegotiationRow = Awaited<ReturnType<typeof prisma.a2ANegotiation.findUniqueOrThrow>>;

function present(negotiation: NegotiationRow, messages: SignedOffer[]) {
  // Verification runs on every read, deliberately: a cached "valid" flag would
  // not reflect a row edited after the fact.
  let verification: { valid: boolean; issues: unknown[]; transcriptHash: string };
  let view;
  try {
    const d = domain();
    verification = verifyTranscript(d, messages);
    view = deriveState(messages, nowSeconds());
  } catch (err) {
    verification = { valid: false, issues: [{ reason: (err as Error).message }], transcriptHash: '' };
    view = null;
  }

  return {
    id: negotiation.id,
    jobId: negotiation.jobId,
    providerAgentId: negotiation.providerAgentId,
    providerErc8004Id: negotiation.providerErc8004Id,
    providerWallet: negotiation.providerWallet,
    state: view?.state ?? negotiation.state,
    turn: view?.turn ?? null,
    agreedPrice: negotiation.agreedPriceBaseUnits
      ? {
          baseUnits: negotiation.agreedPriceBaseUnits,
          display: formatUsdc(negotiation.agreedPriceBaseUnits),
          currency: 'USDC',
        }
      : null,
    transcriptHash: negotiation.transcriptHash,
    agreementHash: negotiation.agreementHash,
    agreementExpiry: negotiation.agreementExpiry,
    signatures: {
      creator: negotiation.creatorSignature,
      provider: negotiation.providerSignature,
    },
    verification,
    messages: messages.map((m) => ({
      seq: m.offer.seq,
      role: m.offer.role,
      kind: m.offer.kind,
      price:
        m.offer.kind === 'DECLINE'
          ? null
          : { baseUnits: m.offer.priceBaseUnits, display: formatUsdc(m.offer.priceBaseUnits) },
      note: m.offer.note,
      prevHash: m.offer.prevHash,
      digest: m.digest,
      signature: m.signature,
      signerAddress: m.signerAddress,
      expiresAt: m.offer.expiresAt,
    })),
    createdAt: negotiation.createdAt,
  };
}
