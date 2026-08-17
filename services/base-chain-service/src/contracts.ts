/**
 * Ethers wiring for Base mainnet.
 *
 * Mirrors services/arena-chain-service/src/contracts.ts: this service holds
 * the ONLY Base relayer signer and is the only thing that submits Base
 * transactions. Every other service asks it over HTTP rather than holding a
 * key. Reads use the provider and never need the relayer.
 *
 * The relayer pays all gas, deliberately. Neither the agent's own EOA nor the
 * human owner's Privy wallet ever needs ETH on Base — agents authorize by
 * signature (EIP-712 for identity, EIP-3009 for USDC) and we relay.
 */

import { ethers } from 'ethers';
import IdentityRegistryAbi from './abi/IdentityRegistry.json';
import { ERC8004_IDENTITY_REGISTRY, requireEnv } from './config';

let _provider: ethers.JsonRpcProvider | null = null;
export function getProvider(): ethers.JsonRpcProvider {
  if (!_provider) {
    const rpcUrl = process.env.BASE_RPC_URL ?? 'https://mainnet.base.org';
    // Pinning the network skips eth_chainId on every call and, more usefully,
    // makes a misconfigured RPC fail loudly instead of silently transacting
    // against the wrong chain.
    _provider = new ethers.JsonRpcProvider(rpcUrl, { chainId: 8453, name: 'base' });
  }
  return _provider;
}

let _relayer: ethers.Wallet | null = null;
export function getRelayerSigner(): ethers.Wallet {
  if (!_relayer) {
    _relayer = new ethers.Wallet(requireEnv('BASE_RELAYER_PRIVATE_KEY'), getProvider());
  }
  return _relayer;
}

export function getRelayerAddress(): string {
  return getRelayerSigner().address;
}

export function identityRegistryRead(): ethers.Contract {
  return new ethers.Contract(ERC8004_IDENTITY_REGISTRY, IdentityRegistryAbi, getProvider());
}

export function identityRegistryWrite(): ethers.Contract {
  return new ethers.Contract(ERC8004_IDENTITY_REGISTRY, IdentityRegistryAbi, getRelayerSigner());
}

/** Extract a clean revert reason from an ethers error, matching arena-chain-service. */
export function revertReason(err: unknown): string {
  const e = err as { shortMessage?: string; reason?: string; message?: string };
  return e.shortMessage ?? e.reason ?? e.message ?? 'unknown error';
}

/**
 * Relayer ETH balance — the single operational dependency that silently
 * breaks everything when it hits zero. Surfaced on /health so monitoring
 * catches it before a registration fails.
 */
export async function relayerBalanceEth(): Promise<string> {
  const balance = await getProvider().getBalance(getRelayerAddress());
  return ethers.formatEther(balance);
}
