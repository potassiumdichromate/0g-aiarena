/**
 * Base mainnet configuration.
 *
 * The three addresses below are CANONICAL and must not be moved into
 * overridable env vars without a very good reason — they are the whole point
 * of building on Base rather than deploying our own registries. All three were
 * verified live on chainId 8453 before this service was written:
 *
 *   IdentityRegistry   name() = "AgentIdentity",  symbol() = "AGENT"
 *   ReputationRegistry ERC-1967 proxy, 130 bytes of code
 *   USDC               symbol() = "USDC"
 *
 * The EIP-712 domain below was read from the deployed contract's own
 * eip712Domain() rather than assumed — name is "ERC8004IdentityRegistry"
 * (NOT "AgentIdentity", which is the ERC-721 name; conflating the two would
 * produce signatures that silently fail to recover).
 */

export const BASE_CHAIN_ID = 8453;

export const ERC8004_IDENTITY_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
export const ERC8004_REPUTATION_REGISTRY = '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63';
export const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

/** EIP-712 domain of the IdentityRegistry, read from eip712Domain() on Base. */
export const IDENTITY_EIP712_DOMAIN = {
  name: 'ERC8004IdentityRegistry',
  version: '1',
  chainId: BASE_CHAIN_ID,
  verifyingContract: ERC8004_IDENTITY_REGISTRY,
} as const;

/** Matches AGENT_WALLET_SET_TYPEHASH in IdentityRegistryUpgradeable.sol. */
export const AGENT_WALLET_SET_TYPES = {
  AgentWalletSet: [
    { name: 'agentId', type: 'uint256' },
    { name: 'newWallet', type: 'address' },
    { name: 'owner', type: 'address' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

/** The contract rejects deadlines further out than its MAX_DEADLINE_DELAY. */
export const WALLET_SIG_TTL_SECONDS = 15 * 60;

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} not configured`);
  return value;
}

/** Public origin this service is reachable at — used to build resolvable tokenURIs. */
export function publicBaseUrl(): string {
  return (process.env.A2A_PUBLIC_BASE_URL ?? 'http://localhost:8051').replace(/\/$/, '');
}

export function basescanTx(txHash: string): string {
  return `https://basescan.org/tx/${txHash}`;
}

export function basescanToken(tokenId: string): string {
  return `https://basescan.org/token/${ERC8004_IDENTITY_REGISTRY}?a=${tokenId}`;
}
