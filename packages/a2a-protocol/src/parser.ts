/**
 * Natural-language prompt -> structured requirements.
 *
 * The product requirement is that job creation is a prose box, not a form of
 * dropdowns. But the PARSED document is what the escrow settles against, so
 * this module never posts anything: it returns an interpretation, with a
 * confidence and the extraction method, for the author to confirm.
 *
 * Two extractors:
 *
 *   - `extractDeterministic` — pattern matching over the phrasings this domain
 *     actually uses. No network, no model, fully reproducible. It is the
 *     fallback, and it is also the thing an LLM result is sanity-checked
 *     against.
 *   - An LLM pass via 0G Compute lives in the marketplace service, which owns
 *     the ZeroGComputeClient. It calls `mergeExtractions` to reconcile.
 *
 * Deterministic-first matters: a job posting that fails because an inference
 * endpoint is slow is a bad product, and an author who cannot tell whether the
 * model understood them cannot safely confirm.
 */

import type { RequirementPredicate } from './requirements';

export type ExtractionMethod = 'deterministic' | 'llm' | 'llm+deterministic';

export interface ExtractedRequirements {
  gameId: string | null;
  target: RequirementPredicate | null;
  providerRequirements: RequirementPredicate[];
  method: ExtractionMethod;
  /** 0-1. Below CONFIRMATION_THRESHOLD the UI must insist on manual review. */
  confidence: number;
  /** Anything the author should look at before confirming. */
  warnings: string[];
}

/** Below this, the UI should treat the parse as a draft rather than a proposal. */
export const CONFIRMATION_THRESHOLD = 0.6;

/**
 * Metric aliases. Keys are lowercase phrases as they appear in prose; values
 * are canonical metric names matching @ai-arena/capability profiles.
 *
 * Ordered longest-first at match time so "combat skill" wins over "combat".
 */
const METRIC_ALIASES: Record<string, string> = {
  'combat skill': 'combatSkill',
  'combat skills': 'combatSkill',
  'combat rating': 'combatSkill',
  combat: 'combatSkill',
  precision: 'precision',
  accuracy: 'precision',
  aggression: 'aggression',
  patience: 'patience',
  adaptability: 'adaptability',
  resilience: 'resilience',
  creativity: 'creativity',
  elo: 'eloRating',
  'elo rating': 'eloRating',
  wins: 'wins',
  win: 'wins',
  victories: 'wins',
  'win rate': 'winRate',
  losses: 'losses',
  // Present so they are RECOGNISED and then explicitly refused. Leaving them
  // out made "at least 80 loyalty" parse to nothing at all, which reads to the
  // author as "the parser did not understand" rather than "this cannot be
  // measured here" — a materially different message.
  loyalty: 'loyalty',
  deception: 'deception',
};

const GAME_ALIASES: Record<string, string> = {
  warzone: 'warzone',
  'warzone warrior': 'warzone',
  'warzone warriors': 'warzone',
  robowar: 'robowar',
  'highway hustle': 'highway-hustle',
};

/** Traits with no behavioural signal in the arena environment. */
const UNMEASURABLE_METRICS = new Set(['loyalty', 'deception']);

function detectGame(text: string): string | null {
  const lower = text.toLowerCase();
  const match = Object.keys(GAME_ALIASES)
    .sort((a, b) => b.length - a.length)
    .find((alias) => lower.includes(alias));
  return match ? GAME_ALIASES[match] : null;
}

function canonicalMetric(phrase: string): string | null {
  return METRIC_ALIASES[phrase.trim().toLowerCase()] ?? null;
}

const METRIC_PHRASE = Object.keys(METRIC_ALIASES)
  .sort((a, b) => b.length - a.length)
  .map((alias) => alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');

/**
 * "at least 70 combat skill", "minimum combat skills of 90", "100+ wins",
 * "over 100 wins", "combat skill of at least 90".
 */
const MODIFIER = 'at\\s+least|minimum(?:\\s+of)?|min|over|above|more\\s+than';

/**
 * Optional game qualifier between a value and its metric: people write
 * "100+ Warzone wins", not "100+ wins". Restricted to known game names rather
 * than any word, so a loose `\w+` cannot bridge two unrelated clauses.
 */
const GAME_QUALIFIER = `(?:(?:${Object.keys(GAME_ALIASES)
  .sort((a, b) => b.length - a.length)
  .map((alias) => alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|')})\\s+)?`;

/**
 * Ordered most-specific first. An earlier pattern claims its character span,
 * so a later, looser pattern cannot re-read the same text differently.
 */
const PATTERNS: Array<{ regex: RegExp; metricGroup: number; valueGroup: number }> = [
  // "at least 70 combat skill" / "over 100 wins"
  {
    regex: new RegExp(
      `(?:${MODIFIER})\\s+(\\d+)\\+?\\s*(?:%\\s*)?${GAME_QUALIFIER}(${METRIC_PHRASE})`, 'gi',
    ),
    metricGroup: 2,
    valueGroup: 1,
  },
  // "minimum combat skills of 90" — modifier BEFORE the metric, value after.
  // This is the phrasing in the product specification and was missing.
  {
    regex: new RegExp(`(?:${MODIFIER})\\s+(${METRIC_PHRASE})\\s*(?:of|:|=)?\\s*(\\d+)`, 'gi'),
    metricGroup: 1,
    valueGroup: 2,
  },
  // "combat skill of at least 90" / "combat skills minimum 90"
  {
    regex: new RegExp(`(${METRIC_PHRASE})\\s*(?:of|:)?\\s*(?:${MODIFIER})\\s+(\\d+)`, 'gi'),
    metricGroup: 1,
    valueGroup: 2,
  },
  // "100+ wins" / "70+ combat skill" / "100+ Warzone wins"
  {
    regex: new RegExp(`(\\d+)\\s*\\+\\s*${GAME_QUALIFIER}(${METRIC_PHRASE})`, 'gi'),
    metricGroup: 2,
    valueGroup: 1,
  },
  // "combat skill 90" / "combat skill: 90"
  {
    regex: new RegExp(`(${METRIC_PHRASE})\\s*(?::|=|\\s)\\s*(\\d+)(?!\\s*\\+)`, 'gi'),
    metricGroup: 1,
    valueGroup: 2,
  },
  // Bare "50 precision". Lowest priority — without it, a second constraint in
  // "at least 70 combat skill and 50 precision" is invisible, so the author is
  // never warned that it was dropped.
  {
    regex: new RegExp(`(\\d+)\\s+${GAME_QUALIFIER}(${METRIC_PHRASE})`, 'gi'),
    metricGroup: 2,
    valueGroup: 1,
  },
];

interface FoundConstraint {
  metric: string;
  value: number;
  /** Character offset, used to attribute constraints to clauses. */
  index: number;
}

function findConstraints(text: string): FoundConstraint[] {
  const found: FoundConstraint[] = [];
  const claimed = new Set<number>();

  for (const { regex, metricGroup, valueGroup } of PATTERNS) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const start = match.index;
      const end = start + match[0].length;

      // Earlier (more specific) patterns win the span. Checking every offset,
      // not just the start: a looser pattern often begins mid-way through an
      // already-claimed match ("90 and have over 100+ wins" would otherwise be
      // re-read from a different offset and double-count).
      let overlaps = false;
      for (let i = start; i < end; i += 1) {
        if (claimed.has(i)) { overlaps = true; break; }
      }
      if (overlaps) continue;

      const metric = canonicalMetric(match[metricGroup]);
      const value = Number.parseInt(match[valueGroup], 10);
      if (!metric || !Number.isInteger(value)) continue;

      for (let i = start; i < end; i += 1) claimed.add(i);
      found.push({ metric, value, index: start });
    }
  }

  return found.sort((a, b) => a.index - b.index);
}

/**
 * Split the prompt into "what I want" and "who should do it".
 *
 * The distinction is the whole game: "I want at least 70 combat skill" is the
 * target, "the trainer should have at least 90 combat skill" is a provider
 * requirement. Both mention combat skill; only the surrounding clause
 * separates them.
 */
const PROVIDER_CLAUSE_MARKERS = [
  'trainer',
  'the agent i want this job for',
  'provider',
  'whoever',
  'who takes',
  'coach',
  'teacher',
  'should have',
  'must have',
];

function providerClauseStart(text: string): number {
  const lower = text.toLowerCase();
  const positions = PROVIDER_CLAUSE_MARKERS.map((m) => lower.indexOf(m)).filter((i) => i >= 0);
  return positions.length ? Math.min(...positions) : -1;
}

export function extractDeterministic(prompt: string): ExtractedRequirements {
  const warnings: string[] = [];
  const gameId = detectGame(prompt);
  if (!gameId) warnings.push('No game recognised in the prompt — defaulting is not safe, please pick one.');

  const constraints = findConstraints(prompt);
  const splitAt = providerClauseStart(prompt);

  let targetConstraint: FoundConstraint | undefined;
  const providerConstraints: FoundConstraint[] = [];

  for (const constraint of constraints) {
    const isProviderSide = splitAt >= 0 && constraint.index >= splitAt;
    if (isProviderSide) {
      providerConstraints.push(constraint);
    } else if (!targetConstraint) {
      targetConstraint = constraint;
    } else {
      // A second constraint on the requester's side is ambiguous — surface it
      // rather than silently discarding or misfiling it.
      warnings.push(
        `Ignored an extra constraint before the provider clause: ${constraint.metric} ${constraint.value}. ` +
          'Only one target is supported per job.',
      );
    }
  }

  // No provider clause but several constraints: the first is the target and the
  // rest are most likely provider requirements.
  if (splitAt < 0 && constraints.length > 1) {
    for (const constraint of constraints.slice(1)) providerConstraints.push(constraint);
    warnings.push(
      'No explicit trainer/provider clause found; constraints after the first were read as ' +
        'provider requirements. Please confirm.',
    );
  }

  for (const constraint of [...(targetConstraint ? [targetConstraint] : []), ...providerConstraints]) {
    if (UNMEASURABLE_METRICS.has(constraint.metric)) {
      warnings.push(
        `"${constraint.metric}" cannot be measured in this environment and cannot be used as a requirement.`,
      );
    }
  }

  const usable = (c: FoundConstraint) => !UNMEASURABLE_METRICS.has(c.metric);

  if (!targetConstraint) warnings.push('No target metric found — the job needs a completion condition.');

  const target: RequirementPredicate | null =
    targetConstraint && usable(targetConstraint)
      ? { metric: targetConstraint.metric, op: 'gte', value: targetConstraint.value }
      : null;

  const providerRequirements: RequirementPredicate[] = providerConstraints
    .filter(usable)
    .map((c) => ({ metric: c.metric, op: 'gte', value: c.value }));

  return {
    gameId,
    target,
    providerRequirements,
    method: 'deterministic',
    confidence: scoreConfidence(gameId, target, providerRequirements.length, warnings.length),
    warnings,
  };
}

function scoreConfidence(
  gameId: string | null,
  target: RequirementPredicate | null,
  providerCount: number,
  warningCount: number,
): number {
  let score = 0;
  if (gameId) score += 0.35;
  if (target) score += 0.45;
  if (providerCount > 0) score += 0.2;
  // Each warning is a thing the author needs to check.
  return Math.max(0, Math.min(1, score - warningCount * 0.15));
}

/**
 * Reconcile an LLM extraction with the deterministic one.
 *
 * The LLM is better at unusual phrasing; the deterministic pass is incapable
 * of hallucinating a constraint that is not in the text. So: take the LLM's
 * structure, but drop any numeric value that does not literally appear in the
 * prompt, and flag disagreements for the author rather than silently picking a
 * winner.
 */
export function mergeExtractions(
  prompt: string,
  llm: Omit<ExtractedRequirements, 'method' | 'confidence' | 'warnings'>,
  deterministic: ExtractedRequirements,
): ExtractedRequirements {
  const warnings = [...deterministic.warnings];
  const numbersInPrompt = new Set((prompt.match(/\d+/g) ?? []).map((n) => Number.parseInt(n, 10)));

  const grounded = (predicate: RequirementPredicate | null, label: string): RequirementPredicate | null => {
    if (!predicate) return null;
    if (!numbersInPrompt.has(predicate.value)) {
      warnings.push(
        `Dropped ${label} "${predicate.metric} ${predicate.value}" — that number does not appear in the prompt.`,
      );
      return null;
    }
    if (UNMEASURABLE_METRICS.has(predicate.metric)) {
      warnings.push(`Dropped ${label} "${predicate.metric}" — not measurable in this environment.`);
      return null;
    }
    return predicate;
  };

  const target = grounded(llm.target, 'target') ?? deterministic.target;
  const providerRequirements = llm.providerRequirements
    .map((p) => grounded(p, 'provider requirement'))
    .filter((p): p is RequirementPredicate => p !== null);

  const gameId = llm.gameId ?? deterministic.gameId;

  if (
    deterministic.target &&
    target &&
    (deterministic.target.metric !== target.metric || deterministic.target.value !== target.value)
  ) {
    warnings.push(
      `Interpretations differ on the target: pattern matching read ` +
        `"${deterministic.target.metric} ${deterministic.target.value}", the model read ` +
        `"${target.metric} ${target.value}". Please confirm which you meant.`,
    );
  }

  return {
    gameId,
    target,
    providerRequirements: providerRequirements.length
      ? providerRequirements
      : deterministic.providerRequirements,
    method: 'llm+deterministic',
    confidence: scoreConfidence(gameId, target, providerRequirements.length, warnings.length),
    warnings,
  };
}
