/**
 * Grant the escrow's operator roles. Idempotent, resumable, retry-tolerant.
 *
 * Exists because deploy-a2a-base.ts does deploy + three grants in one run, and
 * a dropped RPC connection partway through leaves the contract deployed with
 * some or none of its roles set. Re-running the deploy in that state would
 * deploy a SECOND escrow — so this grants roles against an already deployed
 * address instead.
 *
 * Every grant is checked before it is sent, so running this repeatedly is free
 * and safe. Each grant is its own transaction: one failure never undoes
 * another, and a re-run resumes exactly where it stopped.
 *
 * Reads and writes both retry (see rpc-retry.ts), but writes only retry while
 * the nonce proves nothing was broadcast — a duplicate grant is harmless, but
 * the same discipline is what keeps this pattern safe to copy elsewhere.
 *
 *   npx hardhat run scripts/grant-a2a-roles.ts --network base
 */

import { ethers, network } from 'hardhat';
import { withRetry, sendWithRetry } from './rpc-retry';

async function main(): Promise<void> {
  const net = await withRetry('network', () => ethers.provider.getNetwork());
  if (net.chainId !== 8453n) {
    throw new Error(`Refusing to run: expected Base mainnet (8453), got ${net.chainId} on "${network.name}"`);
  }

  const escrowAddress = process.env.A2A_JOB_ESCROW_ADDRESS;
  if (!escrowAddress) throw new Error('A2A_JOB_ESCROW_ADDRESS is not set');

  const [signer] = await ethers.getSigners();
  const escrow = await ethers.getContractAt('A2AJobEscrow', escrowAddress);

  const balance = await withRetry('balance', () => ethers.provider.getBalance(signer.address));
  console.log(`\nEscrow:  ${escrowAddress}`);
  console.log(`Signer:  ${signer.address}`);
  console.log(`Balance: ${ethers.formatEther(balance)} ETH\n`);

  const adminRole = await withRetry('DEFAULT_ADMIN_ROLE', () => escrow.DEFAULT_ADMIN_ROLE());
  const isAdmin = await withRetry('hasRole(admin)', () => escrow.hasRole(adminRole, signer.address));
  if (!isAdmin) {
    throw new Error(
      `${signer.address} does not hold DEFAULT_ADMIN_ROLE on this escrow and cannot grant roles. ` +
        'Check BASE_DEPLOYER_PRIVATE_KEY matches the wallet that deployed it.',
    );
  }

  const relayer = process.env.BASE_RELAYER_ADDRESS;
  const verifier = process.env.A2A_VERIFIER_ADDRESS;
  const arbiter = process.env.A2A_ARBITER_ADDRESS;

  if (!relayer) throw new Error('BASE_RELAYER_ADDRESS not set');
  if (!verifier) throw new Error('A2A_VERIFIER_ADDRESS not set');
  if (verifier.toLowerCase() === relayer.toLowerCase()) {
    throw new Error('Verifier and relayer must be different keys: one drives state, the other judges outcomes');
  }

  const targets: Array<[string, string, string | undefined]> = [
    ['RELAYER_ROLE', await withRetry('RELAYER_ROLE', () => escrow.RELAYER_ROLE()), relayer],
    ['VERIFIER_ROLE', await withRetry('VERIFIER_ROLE', () => escrow.VERIFIER_ROLE()), verifier],
    ['ARBITER_ROLE', await withRetry('ARBITER_ROLE', () => escrow.ARBITER_ROLE()), arbiter],
  ];

  for (const [label, role, who] of targets) {
    if (!who) {
      console.log(`  ${label.padEnd(14)} skipped — no address configured`);
      continue;
    }

    const already = await withRetry(`hasRole(${label})`, () => escrow.hasRole(role, who));
    if (already) {
      console.log(`  ${label.padEnd(14)} already granted to ${who}`);
      continue;
    }

    process.stdout.write(`  ${label.padEnd(14)} granting to ${who} ... `);
    const hash = await sendWithRetry(label, signer.address, () => escrow.grantRole(role, who) as never);
    console.log(`done (${hash})`);
  }

  console.log('\nFinal role state:');
  for (const [label, role, who] of targets) {
    if (!who) continue;
    const has = await withRetry(`final ${label}`, () => escrow.hasRole(role, who));
    console.log(`  ${label.padEnd(14)} ${has ? 'GRANTED' : 'NOT GRANTED'}  ${who}`);
  }
  console.log(`  ${'DEFAULT_ADMIN'.padEnd(14)} GRANTED  ${signer.address}`);

  console.log(`\nhttps://basescan.org/address/${escrowAddress}\n`);
}

main().catch((err) => { console.error(`\n${err.message ?? err}\n`); process.exitCode = 1; });
