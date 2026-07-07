/**
 * Ethers.js contract/provider/signer wiring for the 5 arena contracts.
 *
 * This service holds the ONLY relayer signer in the new $ARENA economy
 * (ethers.Wallet from ARENA_RELAYER_PRIVATE_KEY) and is the only thing that
 * submits transactions to these 5 contracts. Every other service that needs
 * an on-chain effect (rewards, escrow, tournaments) calls this service over
 * HTTP instead of holding its own key.
 */
import { ethers } from 'ethers';
import {
  ArenaTokenAbi,
  ArenaTreasuryAbi,
  RewardDistributorAbi,
  ArenaEscrowAbi,
  ArenaTournamentAbi,
} from './abi';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} not configured`);
  return value;
}

let _provider: ethers.JsonRpcProvider | null = null;
export function getProvider(): ethers.JsonRpcProvider {
  if (!_provider) {
    const rpcUrl = requireEnv('ZEROG_RPC_URL');
    _provider = new ethers.JsonRpcProvider(rpcUrl);
  }
  return _provider;
}

let _relayer: ethers.Wallet | null = null;
export function getRelayerSigner(): ethers.Wallet {
  if (!_relayer) {
    const pk = requireEnv('ARENA_RELAYER_PRIVATE_KEY');
    _relayer = new ethers.Wallet(pk, getProvider());
  }
  return _relayer;
}

export function getRelayerAddress(): string {
  return getRelayerSigner().address;
}

// ── Contract factories ──────────────────────────────────────────────────────
// Each has a read-only (provider) variant and a write (signer-connected)
// variant. Reads never need the relayer key; writes always go through it.

export function arenaTokenRead(): ethers.Contract {
  return new ethers.Contract(requireEnv('ARENA_TOKEN_ADDRESS'), ArenaTokenAbi, getProvider());
}

export function arenaTreasuryRead(): ethers.Contract {
  return new ethers.Contract(requireEnv('ARENA_TREASURY_ADDRESS'), ArenaTreasuryAbi, getProvider());
}

export function rewardDistributorRead(): ethers.Contract {
  return new ethers.Contract(requireEnv('ARENA_REWARD_DISTRIBUTOR_ADDRESS'), RewardDistributorAbi, getProvider());
}

export function rewardDistributorWrite(): ethers.Contract {
  return new ethers.Contract(requireEnv('ARENA_REWARD_DISTRIBUTOR_ADDRESS'), RewardDistributorAbi, getRelayerSigner());
}

export function arenaEscrowRead(): ethers.Contract {
  return new ethers.Contract(requireEnv('ARENA_ESCROW_ADDRESS'), ArenaEscrowAbi, getProvider());
}

export function arenaEscrowWrite(): ethers.Contract {
  return new ethers.Contract(requireEnv('ARENA_ESCROW_ADDRESS'), ArenaEscrowAbi, getRelayerSigner());
}

export function arenaTournamentRead(): ethers.Contract {
  return new ethers.Contract(requireEnv('ARENA_TOURNAMENT_ADDRESS'), ArenaTournamentAbi, getProvider());
}

export function arenaTournamentWrite(): ethers.Contract {
  return new ethers.Contract(requireEnv('ARENA_TOURNAMENT_ADDRESS'), ArenaTournamentAbi, getRelayerSigner());
}

export function contractAddresses() {
  return {
    token: process.env.ARENA_TOKEN_ADDRESS ?? '',
    treasury: process.env.ARENA_TREASURY_ADDRESS ?? '',
    rewardDistributor: process.env.ARENA_REWARD_DISTRIBUTOR_ADDRESS ?? '',
    escrow: process.env.ARENA_ESCROW_ADDRESS ?? '',
    tournament: process.env.ARENA_TOURNAMENT_ADDRESS ?? '',
  };
}

/** Hash an arbitrary caller-chosen match/tournament id string into the bytes32 the contracts key on. */
export function hashMatchId(matchId: string): string {
  return ethers.id(matchId); // keccak256(toUtf8Bytes(matchId))
}
