import { ethers } from 'hardhat';

/**
 * One-time migration: redeploys the full ARENA economy on the new
 * ERC20Permit-enabled ArenaToken (needed so staking can be gasless via
 * signed permits instead of on-chain approve() -- see useArenaStaking.ts and
 * docs/arena_token_migration_knowledge.md), then airdrops every real holder
 * of the OLD token their exact balance on the new one so nobody's existing
 * ARENA is lost.
 *
 * Snapshot method: replays every Transfer event on the old token from block
 * 0 to compute final non-zero balances. Only ~40 holders / ~3.6k ARENA
 * total as of 2026-07-08, so this is cheap and doesn't need pagination.
 *
 * Required env vars (same as deploy-arena-economy.ts, plus):
 *   OLD_ARENA_TOKEN_ADDRESS    - the live token being replaced
 *   OLD_ARENA_TREASURY_ADDRESS - excluded from the airdrop (it's the source, not a holder)
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();

  const adminAddress = process.env.ARENA_ADMIN_ADDRESS || deployer.address;
  const relayerAddress = process.env.ARENA_RELAYER_ADDRESS || deployer.address;
  const oldTokenAddress = process.env.OLD_ARENA_TOKEN_ADDRESS;
  const oldTreasuryAddress = process.env.OLD_ARENA_TREASURY_ADDRESS;
  if (!oldTokenAddress || !oldTreasuryAddress) {
    throw new Error('Set OLD_ARENA_TOKEN_ADDRESS and OLD_ARENA_TREASURY_ADDRESS');
  }

  console.log('Deploying ARENA economy (permit-enabled token) with account:', deployer.address);
  console.log('Network:', network.name, `(chainId ${network.chainId})`);

  // ── 1. Snapshot every non-zero holder of the OLD token ──────────────────
  console.log('\nSnapshotting old token holders from', oldTokenAddress, '...');
  const transferAbi = ['event Transfer(address indexed from, address indexed to, uint256 value)'];
  const oldToken = new ethers.Contract(oldTokenAddress, transferAbi, ethers.provider);
  const latestBlock = await ethers.provider.getBlockNumber();
  const events = await oldToken.queryFilter(oldToken.filters.Transfer(), 0, latestBlock);

  const balances = new Map<string, bigint>();
  for (const evt of events) {
    const { from, to, value } = (evt as unknown as { args: { from: string; to: string; value: bigint } }).args;
    balances.set(from, (balances.get(from) ?? 0n) - value);
    balances.set(to, (balances.get(to) ?? 0n) + value);
  }
  const holders = [...balances.entries()].filter(
    ([addr, bal]) => bal > 0n && addr.toLowerCase() !== oldTreasuryAddress.toLowerCase(),
  );
  const totalToAirdrop = holders.reduce((sum, [, bal]) => sum + bal, 0n);
  console.log(`Found ${holders.length} holders to migrate, totalling ${ethers.formatEther(totalToAirdrop)} ARENA`);

  // ── 2. Deploy the new economy (same order as deploy-arena-economy.ts) ───
  const ArenaTreasury = await ethers.getContractFactory('ArenaTreasury');
  const treasury = await ArenaTreasury.deploy(adminAddress);
  await treasury.waitForDeployment();
  const treasuryAddress = await treasury.getAddress();
  console.log('\nArenaTreasury deployed to:', treasuryAddress);

  const ArenaToken = await ethers.getContractFactory('ArenaToken');
  const token = await ArenaToken.deploy(treasuryAddress);
  await token.waitForDeployment();
  const tokenAddress = await token.getAddress();
  console.log('ArenaToken (permit-enabled) deployed to:', tokenAddress);

  await (await treasury.connect(deployer).setArenaToken(tokenAddress)).wait();
  console.log('ArenaTreasury.setArenaToken() confirmed');

  const RewardDistributor = await ethers.getContractFactory('RewardDistributor');
  const rewardDistributor = await RewardDistributor.deploy(adminAddress, treasuryAddress);
  await rewardDistributor.waitForDeployment();
  const rewardDistributorAddress = await rewardDistributor.getAddress();
  console.log('RewardDistributor deployed to:', rewardDistributorAddress);

  const ArenaEscrow = await ethers.getContractFactory('ArenaEscrow');
  const escrow = await ArenaEscrow.deploy(adminAddress, tokenAddress, treasuryAddress);
  await escrow.waitForDeployment();
  const escrowAddress = await escrow.getAddress();
  console.log('ArenaEscrow deployed to:', escrowAddress);

  const ArenaTournament = await ethers.getContractFactory('ArenaTournament');
  const tournament = await ArenaTournament.deploy(adminAddress, tokenAddress, treasuryAddress);
  await tournament.waitForDeployment();
  const tournamentAddress = await tournament.getAddress();
  console.log('ArenaTournament deployed to:', tournamentAddress);

  if (adminAddress.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(
      'ARENA_ADMIN_ADDRESS differs from the deployer key -- role wiring and the holder airdrop below both ' +
      'require admin/SPENDER_ROLE from this key. Run this script with the deployer as admin, or finish wiring manually.',
    );
  }

  const SPENDER_ROLE = await treasury.SPENDER_ROLE();
  await (await treasury.grantRole(SPENDER_ROLE, rewardDistributorAddress)).wait();
  await (await treasury.grantRole(SPENDER_ROLE, escrowAddress)).wait();
  await (await treasury.grantRole(SPENDER_ROLE, tournamentAddress)).wait();
  console.log('Granted SPENDER_ROLE to RewardDistributor, ArenaEscrow, ArenaTournament');

  await (await rewardDistributor.grantRole(await rewardDistributor.RELAYER_ROLE(), relayerAddress)).wait();
  await (await escrow.grantRole(await escrow.RELAYER_ROLE(), relayerAddress)).wait();
  await (await tournament.grantRole(await tournament.RELAYER_ROLE(), relayerAddress)).wait();
  console.log('Granted RELAYER_ROLE to', relayerAddress);

  // ── 3. Airdrop old holders their exact balance on the new token ─────────
  // Treasury.distribute() is the only token-moving function and it's
  // SPENDER_ROLE-gated -- temporarily grant it to the deployer just for this
  // loop, then revoke it immediately after so no extra standing privilege
  // is left behind on the live contract.
  console.log('\nAirdropping', holders.length, 'holders...');
  await (await treasury.grantRole(SPENDER_ROLE, deployer.address)).wait();
  for (const [addr, bal] of holders) {
    const tx = await treasury.distribute(addr, bal, 'migration-from-old-token');
    await tx.wait();
    console.log(`  ${addr}: ${ethers.formatEther(bal)} ARENA (tx ${tx.hash})`);
  }
  await (await treasury.revokeRole(SPENDER_ROLE, deployer.address)).wait();
  console.log('Airdrop complete, deployer SPENDER_ROLE revoked.');

  console.log('\n=== New ARENA Economy (permit-enabled) ===');
  console.log('ArenaTreasury:', treasuryAddress);
  console.log('ArenaToken:', tokenAddress);
  console.log('RewardDistributor:', rewardDistributorAddress);
  console.log('ArenaEscrow:', escrowAddress);
  console.log('ArenaTournament:', tournamentAddress);
  console.log('\nUpdate these env vars everywhere (arena-chain-service, docs):');
  console.log(`ARENA_TREASURY_ADDRESS=${treasuryAddress}`);
  console.log(`ARENA_TOKEN_ADDRESS=${tokenAddress}`);
  console.log(`ARENA_REWARD_DISTRIBUTOR_ADDRESS=${rewardDistributorAddress}`);
  console.log(`ARENA_ESCROW_ADDRESS=${escrowAddress}`);
  console.log(`ARENA_TOURNAMENT_ADDRESS=${tournamentAddress}`);
  console.log('\nOld contracts (now dead, keep for reference only):');
  console.log('OLD ArenaToken:', oldTokenAddress);
  console.log('OLD ArenaTreasury:', oldTreasuryAddress);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
