import { ethers } from 'hardhat';

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log('Deploying contracts with account:', deployer.address);
  console.log('Account balance:', ethers.formatEther(await ethers.provider.getBalance(deployer.address)));

  // Deploy AIArenaINFT — oracle address can be updated later via setOracle()
  // Using deployer as placeholder oracle until the TEE oracle is operational.
  const AIArenaINFT = await ethers.getContractFactory('AIArenaINFT');
  const inft = await AIArenaINFT.deploy(deployer.address);
  await inft.waitForDeployment();
  const inftAddress = await inft.getAddress();
  console.log('AIArenaINFT deployed to:', inftAddress);

  // Deploy AgentRegistry
  const AgentRegistry = await ethers.getContractFactory('AgentRegistry');
  const registry = await AgentRegistry.deploy();
  await registry.waitForDeployment();
  const registryAddress = await registry.getAddress();
  console.log('AgentRegistry deployed to:', registryAddress);

  // Deploy ModuleMarketplace
  const ModuleMarketplace = await ethers.getContractFactory('ModuleMarketplace');
  const marketplace = await ModuleMarketplace.deploy();
  await marketplace.waitForDeployment();
  const marketplaceAddress = await marketplace.getAddress();
  console.log('ModuleMarketplace deployed to:', marketplaceAddress);

  // Set the INFT contract as authorised operator on registry
  // (would be done after deploying the inft-service operator wallet)

  console.log('\n=== Deployment Summary ===');
  console.log('Network:', (await ethers.provider.getNetwork()).name);
  console.log('AIArenaINFT:', inftAddress);
  console.log('AgentRegistry:', registryAddress);
  console.log('ModuleMarketplace:', marketplaceAddress);
  console.log('\nAdd these to your .env:');
  console.log(`INFT_CONTRACT_ADDRESS=${inftAddress}`);
  console.log(`AGENT_REGISTRY_ADDRESS=${registryAddress}`);
  console.log(`MODULE_MARKETPLACE_ADDRESS=${marketplaceAddress}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
