/**
 * Negotiation: a hash-chained transcript of signed offers.
 *
 * Rules the transcript enforces, each of which exists because the alternative
 * is a way to cheat:
 *
 *   - Every message is signed by the agent that authored it, so we cannot
 *     fabricate a counterparty's position.
 *   - Every message carries the digest of the one before it, so no message can
 *     be inserted, removed, reordered or edited without breaking the chain
 *     (T5). Verification recomputes the whole chain rather than trusting
 *     stored hashes.
 *   - Turns alternate. An agent cannot bid against itself to manufacture the
 *     appearance of movement.
 *   - Every price sits inside the job's on-chain budget range. The final price
 *     is re-checked by the contract, but rejecting early gives a real error
 *     message instead of a revert.
 *   - ACCEPT takes the price of the offer it accepts, never a price of its
 *     own. Otherwise "accepting" would be a silent counter.
 */

import {
  type A2ADomain,
  type Offer,
  type OfferKind,
  type OfferRole,
  ZERO_HASH,
  offerDigest,
} from './eip712';

export interface SignedOffer {
  offer: Offer;
  signature: string;
  /** Digest of `offer`, recomputed on verification — never trusted as given. */
  digest: string;
  /** Address that signed. Recorded so a later key rotation stays auditable. */
  signerAddress: string;
}

export type NegotiationState = 'OPEN' | 'AGREED' | 'DECLINED' | 'EXPIRED';

export interface NegotiationView {
  state: NegotiationState;
  /** Whose turn it is. Null once the negotiation is closed. */
  turn: OfferRole | null;
  lastOffer: SignedOffer | null;
  agreedPriceBaseUnits: string | null;
  /** Digest of the final message — commits the entire chain. */
  transcriptHash: string;
  messageCount: number;
}

export const MAX_NEGOTIATION_MESSAGES = 20;

export interface VerificationIssue {
  seq: number;
  reason: string;
}

/**
 * Recompute and validate the chain.
 *
 * Deliberately takes the full ordered list and rebuilds from scratch: a
 * checker that trusted each message's stored `digest` or `prevHash` would pass
 * a transcript whose contents had been edited underneath those fields, which
 * is exactly the tampering it exists to catch.
 */
export function verifyTranscript(
  domain: A2ADomain,
  messages: SignedOffer[],
): { valid: boolean; issues: VerificationIssue[]; transcriptHash: string } {
  const issues: VerificationIssue[] = [];
  let expectedPrev = ZERO_HASH;
  let lastDigest = ZERO_HASH;

  messages.forEach((message, index) => {
    const { offer } = message;

    if (offer.seq !== index) {
      issues.push({ seq: offer.seq, reason: `out of order: expected seq ${index}, got ${offer.seq}` });
    }

    if (offer.prevHash !== expectedPrev) {
      issues.push({
        seq: offer.seq,
        reason: `broken chain: prevHash ${offer.prevHash} does not match the previous message's digest ${expectedPrev}`,
      });
    }

    const recomputed = offerDigest(domain, offer);
    if (recomputed !== message.digest) {
      issues.push({
        seq: offer.seq,
        reason: 'message content does not match its recorded digest — the stored offer was altered',
      });
    }

    expectedPrev = recomputed;
    lastDigest = recomputed;
  });

  return { valid: issues.length === 0, issues, transcriptHash: lastDigest };
}

/** Derive the current state from the transcript. Pure — no stored status. */
export function deriveState(messages: SignedOffer[], nowSeconds: number): NegotiationView {
  if (messages.length === 0) {
    return {
      state: 'OPEN',
      turn: 'CREATOR',
      lastOffer: null,
      agreedPriceBaseUnits: null,
      transcriptHash: ZERO_HASH,
      messageCount: 0,
    };
  }

  const last = messages[messages.length - 1];
  const transcriptHash = last.digest;

  if (last.offer.kind === 'DECLINE') {
    return {
      state: 'DECLINED', turn: null, lastOffer: last,
      agreedPriceBaseUnits: null, transcriptHash, messageCount: messages.length,
    };
  }

  if (last.offer.kind === 'ACCEPT') {
    return {
      state: 'AGREED', turn: null, lastOffer: last,
      // The accepted price is carried on the ACCEPT itself, which
      // `assertValidNext` has already forced to equal the offer it accepts.
      agreedPriceBaseUnits: last.offer.priceBaseUnits, transcriptHash, messageCount: messages.length,
    };
  }

  if (last.offer.expiresAt > 0 && nowSeconds > last.offer.expiresAt) {
    return {
      state: 'EXPIRED', turn: null, lastOffer: last,
      agreedPriceBaseUnits: null, transcriptHash, messageCount: messages.length,
    };
  }

  return {
    state: 'OPEN',
    turn: last.offer.role === 'CREATOR' ? 'PROVIDER' : 'CREATOR',
    lastOffer: last,
    agreedPriceBaseUnits: null,
    transcriptHash,
    messageCount: messages.length,
  };
}

export interface NextOfferCheck {
  messages: SignedOffer[];
  next: Offer;
  budgetMinBaseUnits: string;
  budgetMaxBaseUnits: string;
  nowSeconds: number;
}

/**
 * Validate a proposed next message against the transcript.
 *
 * Throws with a specific message rather than returning a boolean: every one of
 * these is a distinct thing the caller did wrong, and collapsing them to
 * "invalid offer" makes an autonomous agent's failures undebuggable.
 */
export function assertValidNext(check: NextOfferCheck): void {
  const { messages, next, nowSeconds } = check;
  const view = deriveState(messages, nowSeconds);

  if (view.state !== 'OPEN') {
    throw new Error(`Negotiation is ${view.state} and accepts no further messages`);
  }
  if (messages.length >= MAX_NEGOTIATION_MESSAGES) {
    // Unbounded haggling is a griefing vector: it pins a job open and costs
    // the counterparty compute on every round.
    throw new Error(`Negotiation exceeded ${MAX_NEGOTIATION_MESSAGES} messages without agreement`);
  }
  if (next.seq !== messages.length) {
    throw new Error(`Expected seq ${messages.length}, got ${next.seq}`);
  }

  const expectedPrev = messages.length === 0 ? ZERO_HASH : messages[messages.length - 1].digest;
  if (next.prevHash !== expectedPrev) {
    throw new Error('prevHash does not match the current end of the transcript');
  }
  if (view.turn && next.role !== view.turn) {
    throw new Error(`It is ${view.turn}'s turn — ${next.role} cannot speak twice in a row`);
  }
  if (next.expiresAt > 0 && next.expiresAt <= nowSeconds) {
    throw new Error('Offer expires in the past');
  }

  const first = messages.length === 0;
  if (first && next.kind !== 'PROPOSE') {
    throw new Error('A negotiation must open with PROPOSE');
  }
  if (!first && next.kind === 'PROPOSE') {
    throw new Error('PROPOSE is only valid as the opening message — use COUNTER');
  }

  if (next.kind === 'DECLINE') {
    if (next.priceBaseUnits !== '0') throw new Error('DECLINE must not name a price');
    return;
  }

  const price = BigInt(next.priceBaseUnits);
  const min = BigInt(check.budgetMinBaseUnits);
  const max = BigInt(check.budgetMaxBaseUnits);

  if (price < min || price > max) {
    throw new Error(
      `Price ${next.priceBaseUnits} is outside the job's budget range ${check.budgetMinBaseUnits}-${check.budgetMaxBaseUnits}`,
    );
  }

  if (next.kind === 'ACCEPT') {
    const accepted = view.lastOffer;
    if (!accepted) throw new Error('Nothing to accept');
    if (next.priceBaseUnits !== accepted.offer.priceBaseUnits) {
      // Otherwise ACCEPT is a counter wearing a different label, and
      // `deriveState` would report a price the counterparty never agreed to.
      throw new Error(
        `ACCEPT must match the offered price ${accepted.offer.priceBaseUnits}, got ${next.priceBaseUnits}`,
      );
    }
  }
}

/** Build the next unsigned offer with the chain fields filled in correctly. */
export function buildNextOffer(params: {
  messages: SignedOffer[];
  jobId: string;
  agentId: string;
  role: OfferRole;
  kind: OfferKind;
  priceBaseUnits: string;
  note?: string;
  ttlSeconds?: number;
  nowSeconds: number;
}): Offer {
  const prevHash =
    params.messages.length === 0 ? ZERO_HASH : params.messages[params.messages.length - 1].digest;

  return {
    jobId: params.jobId,
    agentId: params.agentId,
    role: params.role,
    kind: params.kind,
    priceBaseUnits: params.kind === 'DECLINE' ? '0' : params.priceBaseUnits,
    note: params.note ?? '',
    seq: params.messages.length,
    prevHash,
    expiresAt: params.nowSeconds + (params.ttlSeconds ?? 3600),
  };
}

// ── Provider policy ─────────────────────────────────────────────────────────

export interface ProviderPolicy {
  /** Lowest price this provider will work for, in USDC base units. */
  floorBaseUnits: string;
  /** Opening ask as a fraction of the job's maximum. 1.0 asks for the ceiling. */
  openingFraction?: number;
  /** How far to move toward the counterparty each round, 0-1. */
  concessionRate?: number;
}

export type PolicyDecision =
  | { kind: 'ACCEPT'; priceBaseUnits: string; reason: string }
  | { kind: 'COUNTER'; priceBaseUnits: string; reason: string }
  | { kind: 'DECLINE'; reason: string };

/**
 * Decide the provider's next move.
 *
 * A real economic decision, not a rubber stamp: a provider whose floor sits
 * above the job's ceiling declines and earns nothing, which is what makes the
 * budget range meaningful rather than decorative.
 *
 * Deterministic on purpose — given the same transcript and policy it always
 * decides the same way, so a disputed negotiation can be replayed.
 */
export function decideProviderResponse(params: {
  messages: SignedOffer[];
  policy: ProviderPolicy;
  budgetMinBaseUnits: string;
  budgetMaxBaseUnits: string;
}): PolicyDecision {
  const { policy } = params;
  const floor = BigInt(policy.floorBaseUnits);
  const max = BigInt(params.budgetMaxBaseUnits);
  const openingFraction = policy.openingFraction ?? 1.0;
  const concessionRate = Math.min(1, Math.max(0, policy.concessionRate ?? 0.5));

  if (floor > max) {
    return {
      kind: 'DECLINE',
      reason: `Floor ${policy.floorBaseUnits} exceeds the job's maximum ${params.budgetMaxBaseUnits}`,
    };
  }

  const last = params.messages[params.messages.length - 1];
  if (!last) {
    return {
      kind: 'COUNTER',
      priceBaseUnits: scale(max, openingFraction).toString(),
      reason: 'Opening ask',
    };
  }

  const offered = BigInt(last.offer.priceBaseUnits);

  if (offered >= floor) {
    return {
      kind: 'ACCEPT',
      priceBaseUnits: offered.toString(),
      reason: `Offered ${offered} meets the floor of ${floor}`,
    };
  }

  // Below the floor. Concede from the last ask toward the counterparty, but
  // never below the floor — that is the whole point of having one.
  const previousAsk = findLastOwnAsk(params.messages) ?? scale(max, openingFraction);
  const gap = previousAsk > floor ? previousAsk - floor : 0n;
  const conceded = previousAsk - scale(gap, concessionRate);
  const nextAsk = conceded < floor ? floor : conceded;

  if (nextAsk <= offered) {
    // Concession has converged to at or below what is already on the table.
    return { kind: 'ACCEPT', priceBaseUnits: offered.toString(), reason: 'Converged' };
  }

  return {
    kind: 'COUNTER',
    priceBaseUnits: nextAsk.toString(),
    reason: `Offered ${offered} is below the floor of ${floor}; countering at ${nextAsk}`,
  };
}

function findLastOwnAsk(messages: SignedOffer[]): bigint | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const { offer } = messages[i];
    if (offer.role === 'PROVIDER' && offer.kind !== 'DECLINE') return BigInt(offer.priceBaseUnits);
  }
  return null;
}

/** Multiply a bigint by a 0-1 fraction without going through float. */
function scale(value: bigint, fraction: number): bigint {
  const PRECISION = 10_000n;
  return (value * BigInt(Math.round(fraction * 10_000))) / PRECISION;
}
