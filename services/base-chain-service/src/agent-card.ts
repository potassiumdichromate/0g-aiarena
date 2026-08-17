/**
 * ERC-8004 Agent Registration File ("agent card").
 *
 * This is what `tokenURI` resolves to. It is how a *foreign* agent — one that
 * has never heard of KULT — discovers what this agent can do and where to
 * reach it. Getting it right is the difference between an agent identity that
 * only works inside our product and one that composes with the wider Base
 * agent ecosystem.
 *
 * Verifiability: the exact bytes are uploaded to 0G Storage, and the resulting
 * Merkle root is embedded back into the DB row (`cardRootHash`) and served in
 * the HTTP response headers. Anyone can fetch the card over HTTP, fetch the
 * blob from 0G by root hash, and confirm they match — the hash↔blob bridge
 * from the architecture doc §3.3.
 *
 * Capability numbers here are DERIVED and carry their formula version. They
 * are a snapshot for discovery convenience, never the source of truth: the
 * marketplace always recomputes server-side before accepting a proposal
 * (threat T8 — never trust an agent's self-reported capability).
 */

export interface AgentCardCapability {
  /** Stable machine key, e.g. "warzone.combatSkill". */
  name: string;
  value: number;
  /** Formula that produced `value`, e.g. "cap-v1". Bumped on any change. */
  formulaVersion: string;
}

export interface AgentCardInput {
  kultAgentId: string;
  name: string;
  description: string;
  clan: string;
  archetype: string;
  eoaAddress: string;
  ownerWallet: string;
  inftTokenId: string | null;
  capabilities: AgentCardCapability[];
  serviceBaseUrl: string;
}

export interface AgentCard {
  type: string;
  name: string;
  description: string;
  /** Wallets this agent controls, CAIP-10 style. */
  registrations: Array<{ agentAddress: string; agentRegistry?: string }>;
  endpoints: Array<{ name: string; endpoint: string; version?: string }>;
  /** ERC-8004 trust models this agent supports. */
  supportedTrust: string[];
  capabilities: AgentCardCapability[];
  extensions: Record<string, unknown>;
}

export function buildAgentCard(input: AgentCardInput): AgentCard {
  return {
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: input.name,
    description: input.description,

    registrations: [
      { agentAddress: `eip155:8453:${input.eoaAddress}` },
    ],

    endpoints: [
      {
        name: 'A2A',
        endpoint: `${input.serviceBaseUrl}/a2a/agents/${input.kultAgentId}`,
        version: '0.1.0',
      },
      {
        name: 'web',
        endpoint: `${input.serviceBaseUrl}/a2a/agents/${input.kultAgentId}/profile`,
      },
    ],

    // We attest to our own evaluations today (a named, separate verifier key —
    // not the relayer). Stated plainly rather than implying anything stronger:
    // see the trust-model note in the architecture doc §3.5 / T3.
    supportedTrust: ['feedback'],

    capabilities: input.capabilities,

    extensions: {
      'kult.platform': 'KULT AI Arena',
      'kult.agentId': input.kultAgentId,
      'kult.clan': input.clan,
      'kult.archetype': input.archetype,
      // The agent's "mind" lives on 0G as an ERC-7857 INFT; its commercial
      // identity lives here on Base. Cross-referenced so either side is
      // discoverable from the other.
      'kult.inft': input.inftTokenId
        ? { chainId: 16661, tokenId: input.inftTokenId, standard: 'ERC-7857' }
        : null,
      'kult.ownerWallet': input.ownerWallet,
    },
  };
}

/**
 * Byte-stable serialization. Object key order in JS is insertion-ordered for
 * string keys, but relying on that across code edits is how a hash silently
 * stops reproducing — so sort explicitly. Any change here invalidates every
 * previously published cardRootHash, so treat it as a versioned format.
 */
export function serializeAgentCard(card: AgentCard): Buffer {
  return Buffer.from(JSON.stringify(sortDeep(card)), 'utf8');
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value === null || typeof value !== 'object') return value;

  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    sorted[key] = sortDeep(source[key]);
  }
  return sorted;
}
