/**
 * Verifies our EIP-712 typed-data definition produces the exact digest the
 * deployed IdentityRegistry computes.
 *
 * This is the test that earns its keep: a wrong domain name or a reordered
 * struct field yields a signature that recovers to a *different* address, and
 * setAgentWallet would revert with "invalid wallet sig" only after we had
 * already paid gas for register(). The contract-side formula is reimplemented
 * here from IdentityRegistryUpgradeable.sol and compared against ethers'
 * encoder, so the two must agree independently.
 *
 * Contract source (master):
 *   AGENT_WALLET_SET_TYPEHASH =
 *     keccak256("AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)")
 *   structHash = keccak256(abi.encode(TYPEHASH, agentId, newWallet, owner, deadline))
 *   digest     = _hashTypedDataV4(structHash)
 *
 * Domain values were read from the live contract's eip712Domain() on Base
 * mainnet, not assumed:
 *   name "ERC8004IdentityRegistry", version "1", chainId 8453
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import {
  AGENT_WALLET_SET_TYPES,
  IDENTITY_EIP712_DOMAIN,
  ERC8004_IDENTITY_REGISTRY,
  BASE_CHAIN_ID,
} from '../src/config.js';

const AGENT_ID = 12345n;
const NEW_WALLET = '0x1111111111111111111111111111111111111111';
const OWNER = '0x2222222222222222222222222222222222222222';
const DEADLINE = 1_800_000_000n;

const types = AGENT_WALLET_SET_TYPES as unknown as Record<string, Array<{ name: string; type: string }>>;
const value = { agentId: AGENT_ID, newWallet: NEW_WALLET, owner: OWNER, deadline: DEADLINE };

/** Reimplementation of the contract's digest, independent of ethers' encoder. */
function contractSideDigest(): string {
  const typehash = ethers.keccak256(
    ethers.toUtf8Bytes('AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)'),
  );
  const structHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'uint256', 'address', 'address', 'uint256'],
      [typehash, AGENT_ID, NEW_WALLET, OWNER, DEADLINE],
    ),
  );

  // OZ EIP712: keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
  const domainTypehash = ethers.keccak256(
    ethers.toUtf8Bytes(
      'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)',
    ),
  );
  const domainSeparator = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'],
      [
        domainTypehash,
        ethers.keccak256(ethers.toUtf8Bytes('ERC8004IdentityRegistry')),
        ethers.keccak256(ethers.toUtf8Bytes('1')),
        BASE_CHAIN_ID,
        ERC8004_IDENTITY_REGISTRY,
      ],
    ),
  );

  return ethers.keccak256(ethers.concat(['0x1901', domainSeparator, structHash]));
}

test('our typed-data digest matches the contract formula', () => {
  assert.equal(ethers.TypedDataEncoder.hash(IDENTITY_EIP712_DOMAIN, types, value), contractSideDigest());
});

test('a signature recovers to the agent wallet, as setAgentWallet requires', async () => {
  const agent = new ethers.Wallet('0x' + '11'.repeat(32));
  const signed = { ...value, newWallet: agent.address };

  const signature = await agent.signTypedData(IDENTITY_EIP712_DOMAIN, types, signed);
  const recovered = ethers.verifyTypedData(IDENTITY_EIP712_DOMAIN, types, signed, signature);

  // The contract checks `recovered != newWallet` — this is that check.
  assert.equal(ethers.getAddress(recovered), ethers.getAddress(agent.address));
});

test('the ERC-721 name is not mistaken for the EIP-712 domain name', () => {
  // The registry's name() is "AgentIdentity" but its EIP-712 domain name is
  // "ERC8004IdentityRegistry". Confusing them is the most likely way to get a
  // silently-wrong digest, so pin it.
  assert.equal(IDENTITY_EIP712_DOMAIN.name, 'ERC8004IdentityRegistry');
  assert.notEqual(ethers.TypedDataEncoder.hash({ ...IDENTITY_EIP712_DOMAIN, name: 'AgentIdentity' }, types, value),
    contractSideDigest());
});

test('domain is pinned to Base mainnet', () => {
  assert.equal(IDENTITY_EIP712_DOMAIN.chainId, 8453);
  assert.equal(
    ethers.getAddress(IDENTITY_EIP712_DOMAIN.verifyingContract),
    ethers.getAddress(ERC8004_IDENTITY_REGISTRY),
  );
});
