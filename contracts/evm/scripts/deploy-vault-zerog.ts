/**
 * Deploy ArenaDepositVault on 0G mainnet
 *
 * Run:
 *   npx hardhat run scripts/deploy-vault-zerog.ts --network zerog-mainnet
 *
 * On 0G chain: only native 0G token deposits are enabled.
 * USDC and USDT are passed as address(0) — those functions will revert if called.
 *
 * After deploy:
 *   - Copy address into .env → ZEROG_DEPOSIT_VAULT_ADDRESS
 *   - Copy into apps/web/.env.local → NEXT_PUBLIC_ZEROG_VAULT_ADDRESS
 */

import { ethers } from 'hardhat';

async function main() {
  const [deployer] = await ethers.getSigners();
  const network    = await ethers.provider.getNetwork();

  console.log('\n=== ArenaDepositVault — 0G Mainnet Deployment ===');
  console.log('Network  :', network.name, `(chainId ${network.chainId})`);
  console.log('Deployer :', deployer.address);
  console.log('Balance  :', ethers.formatEther(await ethers.provider.getBalance(deployer.address)), '0G');

  if (network.chainId !== 16661n) {
    throw new Error(`Wrong network — expected 0G mainnet (16661), got ${network.chainId}`);
  }

  const feeCollector = process.env.EVM_FEE_COLLECTOR ?? deployer.address;
  const owner        = process.env.EVM_OWNER_ADDRESS ?? deployer.address;

  console.log('\nConstructor args:');
  console.log('  USDC         : address(0)  — disabled on 0G chain');
  console.log('  USDT         : address(0)  — disabled on 0G chain');
  console.log('  feeCollector :', feeCollector);
  console.log('  owner        :', owner);
  console.log('  (only depositNative() is active)');

  const Vault = await ethers.getContractFactory('ArenaDepositVault');
  // Pass zero addresses — ERC-20 deposit functions will revert with "not enabled"
  const vault = await Vault.deploy(
    ethers.ZeroAddress, // usdc disabled
    ethers.ZeroAddress, // usdt disabled
    feeCollector,
    owner,
  );
  await vault.waitForDeployment();

  const address = await vault.getAddress();
  const txHash  = vault.deploymentTransaction()?.hash ?? 'unknown';

  console.log('\n=== ✅ Deployed ===');
  console.log('Contract :', address);
  console.log('Tx hash  :', txHash);
  console.log('Explorer :', `https://chainscan.0g.ai/address/${address}`);

  console.log('\n=== Add to .env ===');
  console.log(`ZEROG_DEPOSIT_VAULT_ADDRESS=${address}`);
  console.log(`\n=== Add to apps/web/.env.local ===`);
  console.log(`NEXT_PUBLIC_ZEROG_VAULT_ADDRESS=${address}`);
}

main().catch(err => { console.error(err); process.exit(1); });
