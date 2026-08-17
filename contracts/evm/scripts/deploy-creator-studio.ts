import { ethers } from 'hardhat';

/**
 * Deploys CreatorStudioSubscription to 0G Chain.
 *
 * The contract is standalone — no wiring step, no dependency on the ARENA
 * economy contracts. It collects native 0G and forwards every wei to the
 * treasury in the same transaction that collects it.
 *
 * Required env vars (root .env):
 *   EVM_DEPLOYER_PRIVATE_KEY      - deployer wallet; pays deploy gas, and by
 *                                   default becomes both admin and relayer
 *   CREATOR_TREASURY_ADDRESS      - where all subscription revenue lands
 *                                   (defaults to the Creator Studio treasury below)
 *
 * Optional:
 *   CREATOR_ADMIN_ADDRESS         - DEFAULT_ADMIN/PRICE_ADMIN/PAUSER holder.
 *                                   Strongly recommended: a multisig on mainnet.
 *   CREATOR_RELAYER_ADDRESS       - wallet that submits gasless requests and
 *                                   pays users' gas. Defaults to the deployer.
 *   CREATOR_PLUS_PRICE_0G         - per-30-day price for Creator Plus (default 10)
 *   CREATOR_PRO_PRICE_0G          - per-30-day price for Creator Pro  (default 25)
 *
 * Run:
 *   pnpm deploy:creator:mainnet
 */

const DEFAULT_TREASURY = '0x043091b10bBcD3F8C5158C27AD291CC56B4F46db';

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();

  const treasuryAddress = process.env.CREATOR_TREASURY_ADDRESS || DEFAULT_TREASURY;
  const adminAddress = process.env.CREATOR_ADMIN_ADDRESS || deployer.address;
  const relayerAddress = process.env.CREATOR_RELAYER_ADDRESS || deployer.address;
  const plusPrice = ethers.parseEther(process.env.CREATOR_PLUS_PRICE_0G || '10');
  const proPrice = ethers.parseEther(process.env.CREATOR_PRO_PRICE_0G || '25');

  if (!ethers.isAddress(treasuryAddress)) {
    throw new Error(`CREATOR_TREASURY_ADDRESS is not a valid address: ${treasuryAddress}`);
  }

  const balance = await ethers.provider.getBalance(deployer.address);

  console.log('─'.repeat(72));
  console.log('CreatorStudioSubscription deployment');
  console.log('─'.repeat(72));
  console.log('Network          :', network.name, `(chainId ${network.chainId})`);
  console.log('Deployer         :', deployer.address);
  console.log('Deployer balance :', ethers.formatEther(balance), '0G');
  console.log('Treasury         :', treasuryAddress);
  console.log('Admin            :', adminAddress);
  console.log('Relayer          :', relayerAddress);
  console.log('Creator Plus     :', ethers.formatEther(plusPrice), '0G / 30 days');
  console.log('Creator Pro      :', ethers.formatEther(proPrice), '0G / 30 days');
  console.log('─'.repeat(72));

  if (balance === 0n) {
    throw new Error('Deployer has a zero 0G balance — fund it before deploying.');
  }

  if (network.chainId === 16661n) {
    if (adminAddress === deployer.address) {
      console.warn(
        '\n⚠️  Deploying to 0G MAINNET with the deployer EOA as DEFAULT_ADMIN_ROLE.\n' +
          '   That key can reprice tiers and redirect the treasury. Move admin to a\n' +
          '   multisig via grantRole/renounceRole after deployment.\n'
      );
    }
    console.log('\nDeploying to MAINNET in 5s (Ctrl+C to abort)...\n');
    await new Promise((r) => setTimeout(r, 5000));
  }

  const Factory = await ethers.getContractFactory('CreatorStudioSubscription');
  const contract = await Factory.deploy(adminAddress, relayerAddress, treasuryAddress, plusPrice, proPrice);
  console.log('Deploy tx submitted:', contract.deploymentTransaction()?.hash);

  await contract.waitForDeployment();
  const address = await contract.getAddress();

  // Read the deployed state back so the log is proof, not assumption.
  const [onChainTreasury, prices, domain] = await Promise.all([
    contract.treasury(),
    contract.allTierPrices(),
    contract.eip712Domain(),
  ]);

  console.log('\n✅ CreatorStudioSubscription deployed to:', address);
  console.log('   treasury      :', onChainTreasury);
  console.log('   Free / Plus / Pro:', prices.map((p) => `${ethers.formatEther(p)} 0G`).join(' / '));
  console.log('   EIP-712 domain:', domain.name, `v${domain.version}`, `chainId ${domain.chainId}`);

  console.log('\nAdd to root .env:');
  console.log(`CREATOR_SUBSCRIPTION_ADDRESS=${address}`);
  console.log(`CREATOR_TREASURY_ADDRESS=${treasuryAddress}`);
  console.log(`CREATOR_RELAYER_ADDRESS=${relayerAddress}`);

  console.log('\nVerify with:');
  console.log(
    `npx hardhat verify --network zerog-mainnet ${address} ` +
      `${adminAddress} ${relayerAddress} ${treasuryAddress} ${plusPrice} ${proPrice}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
