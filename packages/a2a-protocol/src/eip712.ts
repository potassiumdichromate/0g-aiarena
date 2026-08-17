/**
 * EIP-712 typed data for A2A negotiation and agreement.
 *
 * Two primary types share one domain:
 *
 *   Offer     — a negotiation message. Signed by an agent, never verified
 *               on-chain, but signed anyway so the transcript is provably
 *               authored rather than merely stored by us.
 *   Agreement — the final terms. Signed by BOTH agents and verified INSIDE
 *               A2AJobEscrow.fundWithAuthorization before any USDC moves.
 *
 * The Agreement struct here and the contract's AGREEMENT_TYPEHASH must match
 * byte for byte. If they drift, every funding attempt reverts with a signature
 * error that looks like a wallet problem and is not. `AGREEMENT_TYPE_STRING`
 * below is the exact preimage the contract hashes, and a test asserts the
 * typehash both sides derive from it is identical.
 *
 * Why each field is in the Agreement:
 *
 *   jobId             ties the signature to one job
 *   creatorAgentId /  bind both parties by ERC-8004 identity, so a signature
 *   providerAgentId   cannot be replayed by a different agent
 *   providerWallet    the payout destination, fixed at signing time — the
 *                     contract will not pay anywhere else (T1)
 *   agreedPrice       the number both parties actually signed. The frontend
 *                     cannot alter it: a different price is a different digest
 *   requirementsHash  binds the terms to the exact requirements document
 *   executionWindow   the delivery deadline is part of the deal, not a
 *                     server-side setting applied afterwards
 *   transcriptHash    binds the agreement to the negotiation that produced it,
 *                     so a transcript cannot be swapped after the fact (T5)
 *   expiry            a signed agreement left unfunded goes stale rather than
 *                     staying fundable forever
 */

import { TypedDataEncoder, verifyTypedData, getAddress } from 'ethers';

export const EIP712_DOMAIN_NAME = 'KULT A2A Job Escrow';
export const EIP712_DOMAIN_VERSION = '1';
export const BASE_MAINNET_CHAIN_ID = 8453;

export interface A2ADomain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: string;
}

/**
 * Build the domain.
 *
 * chainId and verifyingContract are what make a signature non-replayable
 * across chains and across deployments (T6) — a signature produced for a
 * testnet rehearsal is worthless against the mainnet contract.
 */
export function buildDomain(verifyingContract: string, chainId: number = BASE_MAINNET_CHAIN_ID): A2ADomain {
  return {
    name: EIP712_DOMAIN_NAME,
    version: EIP712_DOMAIN_VERSION,
    chainId,
    verifyingContract: getAddress(verifyingContract),
  };
}

// ── Agreement ───────────────────────────────────────────────────────────────

export const AGREEMENT_TYPES = {
  Agreement: [
    { name: 'jobId', type: 'bytes32' },
    { name: 'creatorAgentId', type: 'uint256' },
    { name: 'providerAgentId', type: 'uint256' },
    { name: 'providerWallet', type: 'address' },
    { name: 'agreedPrice', type: 'uint128' },
    { name: 'requirementsHash', type: 'bytes32' },
    { name: 'executionWindow', type: 'uint32' },
    { name: 'transcriptHash', type: 'bytes32' },
    { name: 'expiry', type: 'uint64' },
  ],
} as const;

/** The exact preimage the Solidity AGREEMENT_TYPEHASH must hash. */
export const AGREEMENT_TYPE_STRING =
  'Agreement(bytes32 jobId,uint256 creatorAgentId,uint256 providerAgentId,' +
  'address providerWallet,uint128 agreedPrice,bytes32 requirementsHash,' +
  'uint32 executionWindow,bytes32 transcriptHash,uint64 expiry)';

export interface Agreement {
  jobId: string;
  creatorAgentId: string;
  providerAgentId: string;
  providerWallet: string;
  /** USDC base units (6dp) as a decimal string — never a float. */
  agreedPrice: string;
  requirementsHash: string;
  executionWindow: number;
  transcriptHash: string;
  /** Unix seconds. */
  expiry: number;
}

/** The EIP-712 digest. This is the `agreementHash` stored on-chain. */
export function agreementDigest(domain: A2ADomain, agreement: Agreement): string {
  return TypedDataEncoder.hash(domain, AGREEMENT_TYPES as never, agreement);
}

/**
 * Recover the signer of an agreement.
 *
 * Returns null rather than throwing on a malformed signature: a bad signature
 * is an expected input here, not an exceptional one, and callers branch on it.
 */
export function recoverAgreementSigner(
  domain: A2ADomain,
  agreement: Agreement,
  signature: string,
): string | null {
  try {
    return getAddress(verifyTypedData(domain, AGREEMENT_TYPES as never, agreement, signature));
  } catch {
    return null;
  }
}

// ── Offer (negotiation message) ─────────────────────────────────────────────

export const OFFER_TYPES = {
  Offer: [
    { name: 'jobId', type: 'bytes32' },
    { name: 'agentId', type: 'uint256' },
    { name: 'role', type: 'string' },
    { name: 'kind', type: 'string' },
    { name: 'priceBaseUnits', type: 'uint128' },
    { name: 'note', type: 'string' },
    { name: 'seq', type: 'uint32' },
    { name: 'prevHash', type: 'bytes32' },
    { name: 'expiresAt', type: 'uint64' },
  ],
} as const;

export type OfferRole = 'CREATOR' | 'PROVIDER';
export type OfferKind = 'PROPOSE' | 'COUNTER' | 'ACCEPT' | 'DECLINE';

export interface Offer {
  jobId: string;
  agentId: string;
  role: OfferRole;
  kind: OfferKind;
  /** USDC base units. Zero for DECLINE, which names no price. */
  priceBaseUnits: string;
  note: string;
  seq: number;
  /** Digest of the previous message; ZERO_HASH for the first. */
  prevHash: string;
  expiresAt: number;
}

export const ZERO_HASH = '0x' + '0'.repeat(64);

/**
 * Digest of one offer. Doubles as the transcript's chain link: the next
 * message carries this value as its `prevHash`, so the final message's digest
 * transitively commits every message before it.
 */
export function offerDigest(domain: A2ADomain, offer: Offer): string {
  return TypedDataEncoder.hash(domain, OFFER_TYPES as never, offer);
}

export function recoverOfferSigner(domain: A2ADomain, offer: Offer, signature: string): string | null {
  try {
    return getAddress(verifyTypedData(domain, OFFER_TYPES as never, offer, signature));
  } catch {
    return null;
  }
}

// ── Signature verification ──────────────────────────────────────────────────

/**
 * Verify a signature against an expected signer, supporting contract wallets.
 *
 * ECDSA recovery is tried first because it needs no network call. If the
 * expected signer is a smart-contract wallet (a Base Account, for instance)
 * recovery yields the wrong address, so the caller-supplied `erc1271Check`
 * asks the contract itself via isValidSignature. That hook is injected rather
 * than implemented here so this package stays free of a provider dependency —
 * base-chain-service owns the RPC connection.
 */
export type Erc1271Check = (
  address: string,
  digest: string,
  signature: string,
) => Promise<boolean>;

export async function verifySignature(params: {
  digest: string;
  signature: string;
  expectedSigner: string;
  recovered: string | null;
  erc1271Check?: Erc1271Check;
}): Promise<{ valid: boolean; method: 'ecdsa' | 'erc1271' | 'none'; reason?: string }> {
  const expected = getAddress(params.expectedSigner);

  if (params.recovered && params.recovered === expected) {
    return { valid: true, method: 'ecdsa' };
  }

  if (params.erc1271Check) {
    try {
      if (await params.erc1271Check(expected, params.digest, params.signature)) {
        return { valid: true, method: 'erc1271' };
      }
    } catch (err) {
      return { valid: false, method: 'none', reason: `ERC-1271 check failed: ${(err as Error).message}` };
    }
  }

  return {
    valid: false,
    method: 'none',
    reason: params.recovered
      ? `signature recovers to ${params.recovered}, expected ${expected}`
      : 'signature is malformed',
  };
}
