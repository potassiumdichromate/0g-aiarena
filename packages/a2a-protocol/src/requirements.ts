/**
 * The job requirement document — the thing whose hash goes on-chain.
 *
 * Produced from a natural-language prompt (see parser.ts) and then CONFIRMED
 * by the author before posting. That confirmation step is not ceremony: the
 * parsed document, not the prose, is what the escrow settles against, so the
 * author has to see and accept the interpretation before it becomes a
 * commitment.
 *
 * The prompt text itself is part of the document. It is what a human reads in
 * a dispute, and excluding it would let the stored prose drift from the hashed
 * requirements with nothing detecting it.
 */

import { CANONICAL_SCHEMA_VERSION, canonicalHash, canonicalString, parseUsdc } from './canonical';

export type PredicateOperator = 'gte' | 'gt' | 'lte' | 'lt' | 'eq';

export interface RequirementPredicate {
  metric: string;
  op: PredicateOperator;
  /** Integer. Trait/skill metrics are 0-100; counts are whole numbers. */
  value: number;
  requireMeasured?: boolean;
}

export interface JobRequirementDocument {
  schema: typeof CANONICAL_SCHEMA_VERSION;
  /** The author's original words, verbatim. */
  prompt: string;
  gameId: string;
  /** What the finished work must achieve. */
  target: RequirementPredicate;
  /** Who may take the job. May be empty — an open job. */
  providerRequirements: RequirementPredicate[];
  /** USDC base units (6dp) as decimal strings — never floats. */
  budget: { minBaseUnits: string; maxBaseUnits: string };
  /** Seconds the provider has to deliver once escrow is funded. */
  executionWindowSeconds: number;
  /** Author's ERC-8004 agent id, tying the document to an identity. */
  creatorAgentId: string;
  /** Caller-supplied uniqueness salt; makes jobId collision-resistant. */
  nonce: string;
}

export interface BuildRequirementInput {
  prompt: string;
  gameId: string;
  target: RequirementPredicate;
  providerRequirements?: RequirementPredicate[];
  budgetMin: string | number;
  budgetMax: string | number;
  executionWindowSeconds?: number;
  creatorAgentId: string;
  nonce?: string;
}

export const DEFAULT_EXECUTION_WINDOW_SECONDS = 6 * 60 * 60;
const MAX_EXECUTION_WINDOW_SECONDS = 30 * 24 * 60 * 60;
const MAX_PROMPT_LENGTH = 4000;
const MAX_PROVIDER_REQUIREMENTS = 12;

const VALID_OPERATORS: PredicateOperator[] = ['gte', 'gt', 'lte', 'lt', 'eq'];

function assertPredicate(predicate: RequirementPredicate, label: string): void {
  if (!predicate || typeof predicate.metric !== 'string' || !predicate.metric.trim()) {
    throw new Error(`${label}: metric is required`);
  }
  if (!VALID_OPERATORS.includes(predicate.op)) {
    throw new Error(`${label}: unknown operator "${predicate.op}"`);
  }
  if (!Number.isInteger(predicate.value)) {
    throw new Error(`${label}: value must be an integer, got ${predicate.value}`);
  }
}

/**
 * Build and validate the document.
 *
 * Every validation here is a check that would otherwise surface as an on-chain
 * revert (wasting gas) or, worse, as a job that can never settle.
 */
export function buildRequirementDocument(input: BuildRequirementInput): JobRequirementDocument {
  const prompt = input.prompt?.trim() ?? '';
  if (!prompt) throw new Error('prompt is required');
  if (prompt.length > MAX_PROMPT_LENGTH) {
    throw new Error(`prompt exceeds ${MAX_PROMPT_LENGTH} characters`);
  }
  if (!input.gameId?.trim()) throw new Error('gameId is required');
  if (!input.creatorAgentId?.trim()) throw new Error('creatorAgentId is required');

  assertPredicate(input.target, 'target');

  const providerRequirements = input.providerRequirements ?? [];
  if (providerRequirements.length > MAX_PROVIDER_REQUIREMENTS) {
    throw new Error(`at most ${MAX_PROVIDER_REQUIREMENTS} provider requirements are allowed`);
  }
  providerRequirements.forEach((p, i) => assertPredicate(p, `providerRequirements[${i}]`));

  const minBaseUnits = parseUsdc(input.budgetMin);
  const maxBaseUnits = parseUsdc(input.budgetMax);

  if (minBaseUnits <= 0n) throw new Error('budget minimum must be greater than zero');
  if (maxBaseUnits < minBaseUnits) {
    throw new Error('budget maximum must be greater than or equal to the minimum');
  }

  const executionWindowSeconds = input.executionWindowSeconds ?? DEFAULT_EXECUTION_WINDOW_SECONDS;
  if (!Number.isInteger(executionWindowSeconds) || executionWindowSeconds <= 0) {
    throw new Error('executionWindowSeconds must be a positive integer');
  }
  if (executionWindowSeconds > MAX_EXECUTION_WINDOW_SECONDS) {
    // A window longer than this locks the creator's USDC for a month before a
    // timeout refund becomes claimable.
    throw new Error(`executionWindowSeconds may not exceed ${MAX_EXECUTION_WINDOW_SECONDS}`);
  }

  return {
    schema: CANONICAL_SCHEMA_VERSION,
    prompt,
    gameId: input.gameId.trim(),
    target: normalizePredicate(input.target),
    providerRequirements: providerRequirements.map(normalizePredicate),
    budget: { minBaseUnits: minBaseUnits.toString(), maxBaseUnits: maxBaseUnits.toString() },
    executionWindowSeconds,
    creatorAgentId: input.creatorAgentId.trim(),
    nonce: input.nonce ?? defaultNonce(),
  };
}

function normalizePredicate(predicate: RequirementPredicate): RequirementPredicate {
  // Omit `requireMeasured` when false rather than storing it: canonicalize
  // drops undefined, so the two spellings of "not required" must not produce
  // different hashes.
  return {
    metric: predicate.metric.trim(),
    op: predicate.op,
    value: predicate.value,
    ...(predicate.requireMeasured ? { requireMeasured: true } : {}),
  };
}

function defaultNonce(): string {
  // Not security-critical on its own — jobId also mixes in creator and
  // requirements hash — but it must differ between two identical postings.
  const random = Math.floor(Math.random() * 2 ** 48).toString(16);
  return `${Date.now().toString(16)}-${random}`;
}

/** keccak256 of the canonical document. This is what goes on-chain. */
export function requirementsHash(document: JobRequirementDocument): string {
  return canonicalHash(document);
}

/** The exact bytes whose hash was committed — store these, serve these. */
export function requirementsCanonicalJson(document: JobRequirementDocument): string {
  return canonicalString(document);
}

/**
 * Recompute the hash from stored JSON and compare.
 *
 * This is the verification a third party performs, so it deliberately takes
 * the raw stored string rather than a parsed object — parsing and re-emitting
 * inside the checker would hide exactly the drift it exists to catch.
 */
export function verifyRequirementsHash(
  storedJson: string,
  expectedHash: string,
): { valid: boolean; computedHash: string; reason?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(storedJson);
  } catch {
    return { valid: false, computedHash: '', reason: 'stored document is not valid JSON' };
  }

  let computedHash: string;
  try {
    computedHash = canonicalHash(parsed);
  } catch (err) {
    return { valid: false, computedHash: '', reason: (err as Error).message };
  }

  const valid = computedHash.toLowerCase() === expectedHash.toLowerCase();
  return {
    valid,
    computedHash,
    ...(valid ? {} : { reason: 'document does not match the hash committed on-chain' }),
  };
}
