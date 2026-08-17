/**
 * Pre-flight for the A2A marketplace on Base mainnet.
 *
 * Asserts that the canonical addresses base-chain-service hardcodes really are
 * what we believe them to be, on the chain we believe we are talking to. Run
 * this before any Base deployment and after any RPC change:
 *
 *   pnpm --filter @ai-arena/contracts-evm exec hardhat run scripts/verify-base-contracts.ts --network base
 *
 * We deploy NEITHER registry — they are the community-canonical ERC-8004
 * deployments, at deterministic addresses shared across 20+ chains. This
 * script is the guard against that assumption silently rotting.
 */

import { ethers, network } from 'hardhat';

const EXPECTED_CHAIN_ID = 8453n;

const IDENTITY_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
const REPUTATION_REGISTRY = '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
];
const IDENTITY_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function eip712Domain() view returns (bytes1,string,string,uint256,address,bytes32,uint256[])',
];

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = String(actual) === String(expected);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label}: ${actual}${ok ? '' : `  (expected ${expected})`}`);
}

async function assertHasCode(label: string, address: string): Promise<void> {
  const code = await ethers.provider.getCode(address);
  const ok = code !== '0x';
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${label} has code: ${(code.length - 2) / 2} bytes`);
}

async function main(): Promise<void> {
  const net = await ethers.provider.getNetwork();
  console.log(`\nNetwork "${network.name}" — chainId ${net.chainId}\n`);
  check('chainId', net.chainId, EXPECTED_CHAIN_ID);
  if (net.chainId !== EXPECTED_CHAIN_ID) {
    throw new Error('Refusing to continue: not Base mainnet');
  }

  console.log('ERC-8004 IdentityRegistry');
  await assertHasCode('IdentityRegistry', IDENTITY_REGISTRY);
  const identity = new ethers.Contract(IDENTITY_REGISTRY, IDENTITY_ABI, ethers.provider);
  check('name()', await identity.name(), 'AgentIdentity');
  check('symbol()', await identity.symbol(), 'AGENT');

  // The EIP-712 domain name differs from the ERC-721 name. Signatures built
  // with the wrong one recover to the wrong address and setAgentWallet reverts
  // only after register() has already been paid for — so pin it here.
  const domain = await identity.eip712Domain();
  check('eip712Domain.name', domain[1], 'ERC8004IdentityRegistry');
  check('eip712Domain.version', domain[2], '1');
  check('eip712Domain.chainId', domain[3], EXPECTED_CHAIN_ID);
  check('eip712Domain.verifyingContract', ethers.getAddress(domain[4]), ethers.getAddress(IDENTITY_REGISTRY));

  console.log('\nERC-8004 ReputationRegistry');
  await assertHasCode('ReputationRegistry', REPUTATION_REGISTRY);

  // The reputation registry is bound to ONE identity registry. If it points at
  // a different one, giveFeedback writes into a namespace where our agent ids
  // mean nothing — feedback would land, cost gas, and attach to the wrong (or
  // no) agent. Silent, and only discoverable by reading the chain.
  const reputation = new ethers.Contract(
    REPUTATION_REGISTRY,
    ['function getIdentityRegistry() view returns (address)'],
    ethers.provider,
  );
  try {
    check(
      'getIdentityRegistry()',
      ethers.getAddress(await reputation.getIdentityRegistry()),
      ethers.getAddress(IDENTITY_REGISTRY),
    );
  } catch (err) {
    check('getIdentityRegistry()', `call failed: ${(err as Error).message}`, 'an address');
  }

  console.log('\nUSDC');
  const usdc = new ethers.Contract(USDC, ERC20_ABI, ethers.provider);
  check('symbol()', await usdc.symbol(), 'USDC');
  check('decimals()', await usdc.decimals(), 6);

  // EIP-3009 is what the whole funding path rests on: the creator signs an
  // authorization and the relayer submits it, so neither agent needs ETH. If
  // this token does not implement it, every fundWithAuthorization reverts and
  // there is no fallback. Verify before deploying, not after.
  const eip3009 = new ethers.Contract(
    USDC,
    [
      'function authorizationState(address, bytes32) view returns (bool)',
      'function RECEIVE_WITH_AUTHORIZATION_TYPEHASH() view returns (bytes32)',
      'function DOMAIN_SEPARATOR() view returns (bytes32)',
      'function version() view returns (string)',
    ],
    ethers.provider,
  );

  try {
    // An unused nonce must read false. A token without EIP-3009 reverts here.
    const unused = await eip3009.authorizationState(ethers.ZeroAddress, ethers.ZeroHash);
    check('authorizationState() [EIP-3009]', unused, false);
  } catch {
    check('authorizationState() [EIP-3009]', 'NOT IMPLEMENTED', 'implemented');
  }

  // Pin the typehash: the escrow builds its authorization against this exact
  // struct definition, and a mismatch fails signature recovery inside the token.
  const EXPECTED_TYPEHASH = ethers.keccak256(
    ethers.toUtf8Bytes(
      'ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)',
    ),
  );
  try {
    check('RECEIVE_WITH_AUTHORIZATION_TYPEHASH', await eip3009.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), EXPECTED_TYPEHASH);
  } catch {
    check('RECEIVE_WITH_AUTHORIZATION_TYPEHASH', 'not exposed', EXPECTED_TYPEHASH);
  }

  // The EIP-712 domain the client must sign against. Reported rather than
  // asserted — the client reads it from the chain at signing time.
  try {
    console.log(`  INFO  version(): ${await eip3009.version()}`);
    console.log(`  INFO  DOMAIN_SEPARATOR(): ${await eip3009.DOMAIN_SEPARATOR()}`);
  } catch {
    console.log('  INFO  version()/DOMAIN_SEPARATOR() not exposed');
  }

  console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
