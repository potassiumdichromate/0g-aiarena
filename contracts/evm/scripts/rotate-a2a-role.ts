/**
 * Rotate one operator role to a new address, in a single run.
 *
 * Granting the new holder and revoking the old one are two transactions, and
 * doing them by hand invites the failure where the grant lands, the revoke is
 * forgotten, and two keys hold the role indefinitely. This does both, in the
 * safe order, and verifies the result.
 *
 * Order matters: GRANT first, then REVOKE. The reverse leaves a window where
 * nobody holds the role — harmless for a verifier with no pending jobs, but
 * for the relayer it would stall every in-flight job until the grant landed.
 *
 *   ROLE=VERIFIER NEW_ADDRESS=0x... OLD_ADDRESS=0x... \
 *     npx hardhat run scripts/rotate-a2a-role.ts --network base
 *
 * OLD_ADDRESS is optional; omit it to grant without revoking.
 */

import { ethers, network } from 'hardhat';
import { withRetry, sendWithRetry } from './rpc-retry';

const ROLES = ['RELAYER', 'VERIFIER', 'ARBITER'] as const;
type RoleName = (typeof ROLES)[number];

async function main(): Promise<void> {
  const net = await withRetry('network', () => ethers.provider.getNetwork());
  if (net.chainId !== 8453n) {
    throw new Error(`Refusing to run: expected Base mainnet (8453), got ${net.chainId} on "${network.name}"`);
  }

  const roleName = (process.env.ROLE ?? '').toUpperCase() as RoleName;
  const newAddress = process.env.NEW_ADDRESS;
  const oldAddress = process.env.OLD_ADDRESS;
  const escrowAddress = process.env.A2A_JOB_ESCROW_ADDRESS;

  if (!ROLES.includes(roleName)) throw new Error(`ROLE must be one of: ${ROLES.join(', ')}`);
  if (!newAddress) throw new Error('NEW_ADDRESS is not set');
  if (!escrowAddress) throw new Error('A2A_JOB_ESCROW_ADDRESS is not set');
  if (oldAddress && oldAddress.toLowerCase() === newAddress.toLowerCase()) {
    throw new Error('NEW_ADDRESS and OLD_ADDRESS are the same — nothing to rotate');
  }

  const [signer] = await ethers.getSigners();
  const escrow = await ethers.getContractAt('A2AJobEscrow', escrowAddress);

  console.log(`\nEscrow: ${escrowAddress}`);
  console.log(`Admin:  ${signer.address}`);
  console.log(`Role:   ${roleName}_ROLE`);
  console.log(`New:    ${newAddress}`);
  console.log(`Old:    ${oldAddress ?? '(none — granting only)'}\n`);

  const adminRole = await withRetry('DEFAULT_ADMIN_ROLE', () => escrow.DEFAULT_ADMIN_ROLE());
  if (!(await withRetry('hasRole(admin)', () => escrow.hasRole(adminRole, signer.address)))) {
    throw new Error(`${signer.address} does not hold DEFAULT_ADMIN_ROLE and cannot rotate roles`);
  }

  const role = await withRetry(`${roleName}_ROLE`, () => escrow[`${roleName}_ROLE`]());

  // Keeping one key that can both drive job state and judge outcomes is threat
  // T3, so refuse to create that overlap even by accident.
  if (roleName === 'VERIFIER') {
    const relayerRole = await withRetry('RELAYER_ROLE', () => escrow.RELAYER_ROLE());
    if (await withRetry('overlap check', () => escrow.hasRole(relayerRole, newAddress))) {
      throw new Error(`${newAddress} already holds RELAYER_ROLE — one key must not both drive and judge a job`);
    }
  }
  if (roleName === 'RELAYER') {
    const verifierRole = await withRetry('VERIFIER_ROLE', () => escrow.VERIFIER_ROLE());
    if (await withRetry('overlap check', () => escrow.hasRole(verifierRole, newAddress))) {
      throw new Error(`${newAddress} already holds VERIFIER_ROLE — one key must not both drive and judge a job`);
    }
  }

  // ── Grant ────────────────────────────────────────────────────────────────
  if (await withRetry('hasRole(new)', () => escrow.hasRole(role, newAddress))) {
    console.log(`  grant   already held by ${newAddress}`);
  } else {
    process.stdout.write(`  grant   ${newAddress} ... `);
    const hash = await sendWithRetry('grant', signer.address, () => escrow.grantRole(role, newAddress) as never);
    console.log(`done (${hash})`);
  }

  // ── Revoke ───────────────────────────────────────────────────────────────
  if (oldAddress) {
    if (!(await withRetry('hasRole(old)', () => escrow.hasRole(role, oldAddress)))) {
      console.log(`  revoke  ${oldAddress} does not hold the role — nothing to revoke`);
    } else {
      process.stdout.write(`  revoke  ${oldAddress} ... `);
      const hash = await sendWithRetry('revoke', signer.address, () => escrow.revokeRole(role, oldAddress) as never);
      console.log(`done (${hash})`);
    }
  }

  // ── Verify ───────────────────────────────────────────────────────────────
  console.log('\nFinal state:');
  console.log(`  ${newAddress}  ${(await withRetry('final new', () => escrow.hasRole(role, newAddress))) ? 'HOLDS' : 'DOES NOT HOLD'} ${roleName}_ROLE`);
  if (oldAddress) {
    const stillHas = await withRetry('final old', () => escrow.hasRole(role, oldAddress));
    console.log(`  ${oldAddress}  ${stillHas ? '*** STILL HOLDS — REVOKE FAILED ***' : 'revoked'}`);
    if (stillHas) process.exitCode = 1;
  }

  console.log(`\nhttps://basescan.org/address/${escrowAddress}\n`);
}

main().catch((err) => { console.error(`\n${err.message ?? err}\n`); process.exitCode = 1; });
