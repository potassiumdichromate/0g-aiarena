import { ethers } from 'hardhat';

/**
 * Deploys the full ARENA 0G Chain beta economy:
 *   ArenaTreasury -> ArenaToken -> RewardDistributor -> ArenaEscrow -> ArenaTournament
 * then wires role grants so RewardDistributor/ArenaEscrow/ArenaTournament can
 * spend from the treasury, and grants RELAYER_ROLE on each spender contract
 * to the backend relayer wallet.
 *
 * Deployment order matters: ArenaTreasury must exist before ArenaToken (its
 * constructor mints the entire fixed supply straight to the treasury
 * address), and ArenaTreasury.setArenaToken() can only be called once, right
 * after ArenaToken is deployed.
 *
 * Required env vars (see docs/ARENA_TOKEN_0G.md):
 *   EVM_DEPLOYER_PRIVATE_KEY   - deployer wallet, becomes DEFAULT_ADMIN_ROLE
 *                                on every contract unless ARENA_ADMIN_ADDRESS
 *                                is set (recommended: a multisig on mainnet)
 *   ARENA_ADMIN_ADDRESS        - optional; defaults to deployer if unset
 *   ARENA_RELAYER_ADDRESS      - backend hot wallet that will submit all
 *                                sponsored transactions; granted RELAYER_ROLE
 *                                on RewardDistributor, ArenaEscrow, ArenaTournament
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();

  const adminAddress = process.env.ARENA_ADMIN_ADDRESS || deployer.address;
  const relayerAddress = process.env.ARENA_RELAYER_ADDRESS || deployer.address;

  console.log('Deploying ARENA economy with account:', deployer.address);
  console.log('Network:', network.name, `(chainId ${network.chainId})`);
  console.log('Admin address (DEFAULT_ADMIN_ROLE):', adminAddress);
  console.log('Relayer address (RELAYER_ROLE):', relayerAddress);
  console.log('Deployer balance:', ethers.formatEther(await ethers.provider.getBalance(deployer.address)));

  if (network.chainId === 16661n && adminAddress === deployer.address) {
    console.warn(
      '\n⚠️  WARNING: deploying to 0G MAINNET with the deployer address as admin.\n' +
      '   Production deployments should set ARENA_ADMIN_ADDRESS to a multisig\n' +
      '   before granting DEFAULT_ADMIN_ROLE. Continuing in 5s (Ctrl+C to abort)...\n'
    );
    await new Promise((r) => setTimeout(r, 5000));
  }

  // 1. Treasury (deployed first; token address wired in after ArenaToken deploys)
  const ArenaTreasury = await ethers.getContractFactory('ArenaTreasury');
  const treasury = await ArenaTreasury.deploy(adminAddress);
  await treasury.waitForDeployment();
  const treasuryAddress = await treasury.getAddress();
  console.log('ArenaTreasury deployed to:', treasuryAddress);

  // 2. Token (mints the fixed 1,000,000 ARENA supply straight to the treasury)
  const ArenaToken = await ethers.getContractFactory('ArenaToken');
  const token = await ArenaToken.deploy(treasuryAddress);
  await token.waitForDeployment();
  const tokenAddress = await token.getAddress();
  console.log('ArenaToken deployed to:', tokenAddress);

  // 3. Wire the token into the treasury (one-time, admin-only)
  const setTokenTx = await treasury.connect(deployer).setArenaToken(tokenAddress);
  await setTokenTx.wait();
  console.log('ArenaTreasury.setArenaToken() confirmed');

  // 4. RewardDistributor
  const RewardDistributor = await ethers.getContractFactory('RewardDistributor');
  const rewardDistributor = await RewardDistributor.deploy(adminAddress, treasuryAddress);
  await rewardDistributor.waitForDeployment();
  const rewardDistributorAddress = await rewardDistributor.getAddress();
  console.log('RewardDistributor deployed to:', rewardDistributorAddress);

  // 5. ArenaEscrow
  const ArenaEscrow = await ethers.getContractFactory('ArenaEscrow');
  const escrow = await ArenaEscrow.deploy(adminAddress, tokenAddress, treasuryAddress);
  await escrow.waitForDeployment();
  const escrowAddress = await escrow.getAddress();
  console.log('ArenaEscrow deployed to:', escrowAddress);

  // 6. ArenaTournament
  const ArenaTournament = await ethers.getContractFactory('ArenaTournament');
  const tournament = await ArenaTournament.deploy(adminAddress, tokenAddress, treasuryAddress);
  await tournament.waitForDeployment();
  const tournamentAddress = await tournament.getAddress();
  console.log('ArenaTournament deployed to:', tournamentAddress);

  // 7. Role wiring — all performed by `deployer`, which must equal `adminAddress`
  //    for these txs to succeed (if ARENA_ADMIN_ADDRESS differs from the
  //    deployer key, run these grants separately from the admin's own wallet).
  if (adminAddress.toLowerCase() === deployer.address.toLowerCase()) {
    const SPENDER_ROLE = await treasury.SPENDER_ROLE();
    await (await treasury.grantRole(SPENDER_ROLE, rewardDistributorAddress)).wait();
    await (await treasury.grantRole(SPENDER_ROLE, escrowAddress)).wait();
    await (await treasury.grantRole(SPENDER_ROLE, tournamentAddress)).wait();
    console.log('Granted SPENDER_ROLE on ArenaTreasury to RewardDistributor, ArenaEscrow, ArenaTournament');

    const RELAYER_ROLE_RD = await rewardDistributor.RELAYER_ROLE();
    await (await rewardDistributor.grantRole(RELAYER_ROLE_RD, relayerAddress)).wait();
    const RELAYER_ROLE_ESCROW = await escrow.RELAYER_ROLE();
    await (await escrow.grantRole(RELAYER_ROLE_ESCROW, relayerAddress)).wait();
    const RELAYER_ROLE_TOURNAMENT = await tournament.RELAYER_ROLE();
    await (await tournament.grantRole(RELAYER_ROLE_TOURNAMENT, relayerAddress)).wait();
    console.log('Granted RELAYER_ROLE to', relayerAddress, 'on RewardDistributor, ArenaEscrow, ArenaTournament');
  } else {
    console.warn(
      '\n⚠️  ARENA_ADMIN_ADDRESS differs from the deployer key — role grants were\n' +
      '   skipped. Run them manually from the admin wallet:\n' +
      `   treasury.grantRole(SPENDER_ROLE, "${rewardDistributorAddress}")\n` +
      `   treasury.grantRole(SPENDER_ROLE, "${escrowAddress}")\n` +
      `   treasury.grantRole(SPENDER_ROLE, "${tournamentAddress}")\n` +
      `   rewardDistributor.grantRole(RELAYER_ROLE, "${relayerAddress}")\n` +
      `   escrow.grantRole(RELAYER_ROLE, "${relayerAddress}")\n` +
      `   tournament.grantRole(RELAYER_ROLE, "${relayerAddress}")\n`
    );
  }

  console.log('\n=== ARENA Economy Deployment Summary ===');
  console.log('Network:', network.name, `(chainId ${network.chainId})`);
  console.log('ArenaTreasury:', treasuryAddress);
  console.log('ArenaToken:', tokenAddress);
  console.log('RewardDistributor:', rewardDistributorAddress);
  console.log('ArenaEscrow:', escrowAddress);
  console.log('ArenaTournament:', tournamentAddress);
  console.log('\nAdd these to your .env (see docs/ARENA_TOKEN_0G.md):');
  console.log(`ARENA_TREASURY_ADDRESS=${treasuryAddress}`);
  console.log(`ARENA_TOKEN_ADDRESS=${tokenAddress}`);
  console.log(`ARENA_REWARD_DISTRIBUTOR_ADDRESS=${rewardDistributorAddress}`);
  console.log(`ARENA_ESCROW_ADDRESS=${escrowAddress}`);
  console.log(`ARENA_TOURNAMENT_ADDRESS=${tournamentAddress}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
