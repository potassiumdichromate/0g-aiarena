/**
 * Did the deploy actually land?
 *
 * A dropped connection during `deploy()` is ambiguous: the transaction may have
 * been broadcast and mined while the client gave up waiting for the receipt.
 * Retrying blindly in that case deploys a SECOND escrow, wastes gas, and leaves
 * two contracts with equal claim to being canonical.
 *
 * This reads the deployer's nonce and reconstructs every address it could have
 * created, then reports which of them hold contract code.
 *
 *   npx hardhat run scripts/check-deploy-state.ts --network base
 */

import { ethers } from 'hardhat';

async function main(): Promise<void> {
  const [deployer] = await ethers.getSigners();
  const provider = ethers.provider;

  const net = await provider.getNetwork();
  console.log(`\nNetwork: chainId ${net.chainId}`);
  console.log(`Deployer: ${deployer.address}`);

  const [nonce, pendingNonce, balance] = await Promise.all([
    provider.getTransactionCount(deployer.address, 'latest'),
    provider.getTransactionCount(deployer.address, 'pending'),
    provider.getBalance(deployer.address),
  ]);

  console.log(`Balance: ${ethers.formatEther(balance)} ETH`);
  console.log(`Nonce (latest):  ${nonce}`);
  console.log(`Nonce (pending): ${pendingNonce}`);

  if (pendingNonce > nonce) {
    console.log('\n  A transaction is still PENDING. Wait for it to mine before doing anything else.');
  }

  if (nonce === 0) {
    console.log('\n  RESULT: nothing was deployed. The failure happened before broadcast.');
    console.log('  Safe to re-run: pnpm deploy:a2a:base\n');
    return;
  }

  console.log(`\n  The deployer has sent ${nonce} transaction(s). Checking what they created...\n`);

  let found = 0;
  for (let n = 0; n < nonce; n += 1) {
    const address = ethers.getCreateAddress({ from: deployer.address, nonce: n });
    const code = await provider.getCode(address);
    if (code === '0x') continue;

    found += 1;
    console.log(`  CONTRACT from nonce ${n}: ${address}`);
    console.log(`    code: ${(code.length - 2) / 2} bytes`);
    console.log(`    https://basescan.org/address/${address}`);

    // Confirm it is actually our escrow, not some unrelated deploy.
    try {
      const escrow = await ethers.getContractAt('A2AJobEscrow', address);
      const [usdc, treasury, commission] = await Promise.all([
        escrow.usdc(), escrow.treasury(), escrow.commissionBps(),
      ]);
      console.log(`    -> A2AJobEscrow confirmed`);
      console.log(`       usdc:       ${usdc}`);
      console.log(`       treasury:   ${treasury}`);
      console.log(`       commission: ${commission} bps`);

      const [relayerRole, verifierRole, arbiterRole, adminRole] = await Promise.all([
        escrow.RELAYER_ROLE(), escrow.VERIFIER_ROLE(), escrow.ARBITER_ROLE(), escrow.DEFAULT_ADMIN_ROLE(),
      ]);

      const grants: Array<[string, string, string | undefined]> = [
        ['DEFAULT_ADMIN', adminRole, deployer.address],
        ['RELAYER', relayerRole, process.env.BASE_RELAYER_ADDRESS],
        ['VERIFIER', verifierRole, process.env.A2A_VERIFIER_ADDRESS],
        ['ARBITER', arbiterRole, process.env.A2A_ARBITER_ADDRESS],
      ];

      console.log('       roles:');
      for (const [label, role, who] of grants) {
        if (!who) { console.log(`         ${label.padEnd(14)} (address not set in .env)`); continue; }
        const has = await escrow.hasRole(role, who);
        console.log(`         ${label.padEnd(14)} ${has ? 'GRANTED' : 'NOT granted'}  ${who}`);
      }

      console.log(`\n  ACTION: set A2A_JOB_ESCROW_ADDRESS=${address}`);
      console.log('  Do NOT re-run the deploy. If any role above is missing, grant it individually.\n');
    } catch {
      console.log('    -> not an A2AJobEscrow (some other contract)\n');
    }
  }

  if (found === 0) {
    console.log('  No contracts found. The transactions were plain transfers or calls,');
    console.log('  so no escrow was deployed. Safe to re-run: pnpm deploy:a2a:base\n');
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
