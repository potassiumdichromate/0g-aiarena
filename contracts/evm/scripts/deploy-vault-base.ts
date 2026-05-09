/**
 * Deploy ArenaDepositVault on Base mainnet
 *
 * Run:
 *   npx hardhat run scripts/deploy-vault-base.ts --network base-mainnet
 *
 * What gets deployed:
 *   ArenaDepositVault(
 *     usdc         = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913,  // Circle native USDC on Base
 *     usdt         = 0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2,  // Bridged USDT on Base
 *     feeCollector = <EVM_FEE_COLLECTOR from .env>,
 *     owner        = <EVM_DEPLOYER_ADDRESS — should be multisig in prod>
 *   )
 *
 * After deploy:
 *   - Copy the printed address into .env → BASE_DEPOSIT_VAULT_ADDRESS
 *   - Copy into apps/web/.env.local → NEXT_PUBLIC_BASE_VAULT_ADDRESS
 */

import { ethers } from 'hardhat';

// ── Base mainnet token addresses (canonical, verified) ────────────────────────
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // Circle native USDC
const BASE_USDT = '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2'; // Bridged USDT

async function main() {
  const [deployer] = await ethers.getSigners();
  const network    = await ethers.provider.getNetwork();

  console.log('\n=== ArenaDepositVault — Base Mainnet Deployment ===');
  console.log('Network  :', network.name, `(chainId ${network.chainId})`);
  console.log('Deployer :', deployer.address);
  console.log('Balance  :', ethers.formatEther(await ethers.provider.getBalance(deployer.address)), 'ETH');

  if (network.chainId !== 8453n) {
    throw new Error(`Wrong network — expected Base mainnet (8453), got ${network.chainId}`);
  }

  // Fee collector — defaults to deployer if not set (update to multisig in prod)
  const feeCollector = process.env.EVM_FEE_COLLECTOR ?? deployer.address;
  const owner        = process.env.EVM_OWNER_ADDRESS ?? deployer.address;

  console.log('\nConstructor args:');
  console.log('  USDC         :', BASE_USDC);
  console.log('  USDT         :', BASE_USDT);
  console.log('  feeCollector :', feeCollector);
  console.log('  owner        :', owner);

  const Vault = await ethers.getContractFactory('ArenaDepositVault');
  const vault = await Vault.deploy(BASE_USDC, BASE_USDT, feeCollector, owner);
  await vault.waitForDeployment();

  const address = await vault.getAddress();
  const txHash  = vault.deploymentTransaction()?.hash ?? 'unknown';

  console.log('\n=== ✅ Deployed ===');
  console.log('Contract :', address);
  console.log('Tx hash  :', txHash);
  console.log('Explorer :', `https://basescan.org/address/${address}`);

  console.log('\n=== Add to .env ===');
  console.log(`BASE_DEPOSIT_VAULT_ADDRESS=${address}`);
  console.log(`\n=== Add to apps/web/.env.local ===`);
  console.log(`NEXT_PUBLIC_BASE_VAULT_ADDRESS=${address}`);
  console.log(`NEXT_PUBLIC_BASE_USDC_ADDRESS=${BASE_USDC}`);
  console.log(`NEXT_PUBLIC_BASE_USDT_ADDRESS=${BASE_USDT}`);
}

main().catch(err => { console.error(err); process.exit(1); });
