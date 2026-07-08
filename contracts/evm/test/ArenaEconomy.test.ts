import { expect } from 'chai';
import { ethers } from 'hardhat';

describe('ARENA 0G economy', () => {
  async function deployEconomy() {
    const [admin, relayer, playerA, playerB, playerC, outsider] = await ethers.getSigners();

    const ArenaTreasury = await ethers.getContractFactory('ArenaTreasury');
    const treasury = await ArenaTreasury.deploy(admin.address);
    await treasury.waitForDeployment();

    const ArenaToken = await ethers.getContractFactory('ArenaToken');
    const token = await ArenaToken.deploy(await treasury.getAddress());
    await token.waitForDeployment();

    await treasury.connect(admin).setArenaToken(await token.getAddress());

    const RewardDistributor = await ethers.getContractFactory('RewardDistributor');
    const rewardDistributor = await RewardDistributor.deploy(admin.address, await treasury.getAddress());
    await rewardDistributor.waitForDeployment();

    const ArenaEscrow = await ethers.getContractFactory('ArenaEscrow');
    const escrow = await ArenaEscrow.deploy(admin.address, await token.getAddress(), await treasury.getAddress());
    await escrow.waitForDeployment();

    const ArenaTournament = await ethers.getContractFactory('ArenaTournament');
    const tournament = await ArenaTournament.deploy(admin.address, await token.getAddress(), await treasury.getAddress());
    await tournament.waitForDeployment();

    const SPENDER_ROLE = await treasury.SPENDER_ROLE();
    await treasury.connect(admin).grantRole(SPENDER_ROLE, await rewardDistributor.getAddress());
    await treasury.connect(admin).grantRole(SPENDER_ROLE, await escrow.getAddress());
    await treasury.connect(admin).grantRole(SPENDER_ROLE, await tournament.getAddress());

    await rewardDistributor.connect(admin).grantRole(await rewardDistributor.RELAYER_ROLE(), relayer.address);
    await escrow.connect(admin).grantRole(await escrow.RELAYER_ROLE(), relayer.address);
    await tournament.connect(admin).grantRole(await tournament.RELAYER_ROLE(), relayer.address);

    return { admin, relayer, playerA, playerB, playerC, outsider, treasury, token, rewardDistributor, escrow, tournament };
  }

  it('mints exactly the fixed 1,000,000 supply to the treasury and nowhere else', async () => {
    const { treasury, token } = await deployEconomy();
    const supply = await token.totalSupply();
    expect(supply).to.equal(ethers.parseEther('1000000'));
    expect(await token.balanceOf(await treasury.getAddress())).to.equal(supply);
  });

  it('exposes no mint function at all (fixed supply is structural, not permission-gated)', async () => {
    const { token } = await deployEconomy();
    expect((token as any).mint).to.be.undefined;
    expect(token.interface.fragments.some((f: any) => f.name === 'mint')).to.equal(false);
  });

  it('grants the Agent Mint reward from the treasury and decrements its balance', async () => {
    const { relayer, playerA, treasury, token, rewardDistributor } = await deployEconomy();
    const before = await treasury.balance();

    await expect(rewardDistributor.connect(relayer).grantAgentMintReward(playerA.address, 42))
      .to.emit(rewardDistributor, 'AgentRewardGranted')
      .withArgs(playerA.address, 42, ethers.parseEther('100'));

    expect(await token.balanceOf(playerA.address)).to.equal(ethers.parseEther('100'));
    expect(await treasury.balance()).to.equal(before - ethers.parseEther('100'));
    expect(await treasury.distributed()).to.equal(ethers.parseEther('100'));
  });

  it('rejects reward calls from anyone without RELAYER_ROLE', async () => {
    const { outsider, playerA, rewardDistributor } = await deployEconomy();
    await expect(
      rewardDistributor.connect(outsider).grantAgentMintReward(playerA.address, 1)
    ).to.be.reverted;
  });

  it('only allows one daily-login claim per UTC day per player', async () => {
    const { relayer, playerA, rewardDistributor } = await deployEconomy();
    await rewardDistributor.connect(relayer).grantDailyLoginReward(playerA.address);
    await expect(rewardDistributor.connect(relayer).grantDailyLoginReward(playerA.address)).to.be.revertedWith(
      'already claimed today'
    );
  });

  it('settles a 5+5 wager into a 9/1 winner/treasury split (10% commission)', async () => {
    const { relayer, playerA, playerB, treasury, token, rewardDistributor, escrow } = await deployEconomy();

    // Fund both players via the reward distributor so they have ARENA to stake.
    await rewardDistributor.connect(relayer).grantTrainingReward(playerA.address, ethers.parseEther('10'), 'seed');
    await rewardDistributor.connect(relayer).grantTrainingReward(playerB.address, ethers.parseEther('10'), 'seed');

    await token.connect(playerA).approve(await escrow.getAddress(), ethers.parseEther('5'));
    await token.connect(playerB).approve(await escrow.getAddress(), ethers.parseEther('5'));

    const matchId = ethers.keccak256(ethers.toUtf8Bytes('match-1'));
    await escrow.connect(relayer).createMatch(matchId, playerA.address, ethers.parseEther('5'));
    await escrow.connect(relayer).joinMatch(matchId, playerB.address);
    await escrow.connect(relayer).startMatch(matchId);

    const treasuryBalBefore = await treasury.balance();
    const winnerBalBefore = await token.balanceOf(playerA.address);

    await expect(escrow.connect(relayer).settleMatch(matchId, playerA.address))
      .to.emit(escrow, 'MatchSettled')
      .withArgs(matchId, playerA.address, ethers.parseEther('9'), ethers.parseEther('1'));

    expect(await token.balanceOf(playerA.address)).to.equal(winnerBalBefore + ethers.parseEther('9'));
    expect(await treasury.balance()).to.equal(treasuryBalBefore + ethers.parseEther('1'));
    expect(await treasury.totalCommissions()).to.equal(ethers.parseEther('1'));
  });

  it('refunds both stakes on cancelMatch', async () => {
    const { relayer, playerA, playerB, token, rewardDistributor, escrow } = await deployEconomy();
    await rewardDistributor.connect(relayer).grantTrainingReward(playerA.address, ethers.parseEther('10'), 'seed');
    await rewardDistributor.connect(relayer).grantTrainingReward(playerB.address, ethers.parseEther('10'), 'seed');
    await token.connect(playerA).approve(await escrow.getAddress(), ethers.parseEther('5'));
    await token.connect(playerB).approve(await escrow.getAddress(), ethers.parseEther('5'));

    const matchId = ethers.keccak256(ethers.toUtf8Bytes('match-cancel'));
    await escrow.connect(relayer).createMatch(matchId, playerA.address, ethers.parseEther('5'));
    await escrow.connect(relayer).joinMatch(matchId, playerB.address);

    const aBefore = await token.balanceOf(playerA.address);
    const bBefore = await token.balanceOf(playerB.address);
    await escrow.connect(relayer).cancelMatch(matchId);

    expect(await token.balanceOf(playerA.address)).to.equal(aBefore + ethers.parseEther('5'));
    expect(await token.balanceOf(playerB.address)).to.equal(bBefore + ethers.parseEther('5'));
  });

  it('runs a 3-player tournament with a placement-based prize split and commission to treasury', async () => {
    const { relayer, playerA, playerB, playerC, treasury, token, rewardDistributor, tournament } = await deployEconomy();

    for (const p of [playerA, playerB, playerC]) {
      await rewardDistributor.connect(relayer).grantTrainingReward(p.address, ethers.parseEther('10'), 'seed');
      await token.connect(p).approve(await tournament.getAddress(), ethers.parseEther('10'));
    }

    const tId = 1;
    await tournament.connect(relayer).createTournament(tId, ethers.parseEther('10'), 3);
    await tournament.connect(relayer).enterTournament(tId, playerA.address);
    await tournament.connect(relayer).enterTournament(tId, playerB.address);
    await tournament.connect(relayer).enterTournament(tId, playerC.address);
    await tournament.connect(relayer).startTournament(tId);

    // pool = 30 ARENA. commission 10% = 3. 1st place 60% = 18, 2nd place 30% = 9. Sums to exactly 100%.
    const treasuryBefore = await treasury.balance();
    await tournament.connect(relayer).settleTournament(tId, [playerA.address, playerB.address], [6000, 3000]);

    expect(await token.balanceOf(playerA.address)).to.equal(ethers.parseEther('18')); // 60% of 30
    expect(await token.balanceOf(playerB.address)).to.equal(ethers.parseEther('9'));  // 30% of 30
    expect(await treasury.balance()).to.equal(treasuryBefore + ethers.parseEther('3')); // 10% of 30
  });

  it('locks the commission rate at match-creation time, ignoring later admin changes', async () => {
    const { admin, relayer, playerA, playerB, token, rewardDistributor, escrow } = await deployEconomy();
    await rewardDistributor.connect(relayer).grantTrainingReward(playerA.address, ethers.parseEther('10'), 'seed');
    await rewardDistributor.connect(relayer).grantTrainingReward(playerB.address, ethers.parseEther('10'), 'seed');
    await token.connect(playerA).approve(await escrow.getAddress(), ethers.parseEther('5'));
    await token.connect(playerB).approve(await escrow.getAddress(), ethers.parseEther('5'));

    const matchId = ethers.keccak256(ethers.toUtf8Bytes('match-locked-commission'));
    await escrow.connect(relayer).createMatch(matchId, playerA.address, ethers.parseEther('5'));
    await escrow.connect(relayer).joinMatch(matchId, playerB.address);

    // Admin raises commission to 20% AFTER both players have already staked at the original 10%.
    await escrow.connect(admin).setCommissionBps(2000);

    await escrow.connect(relayer).startMatch(matchId);
    await expect(escrow.connect(relayer).settleMatch(matchId, playerA.address))
      .to.emit(escrow, 'MatchSettled')
      .withArgs(matchId, playerA.address, ethers.parseEther('9'), ethers.parseEther('1')); // still the original 10%, not 20%
  });

  it('rejects a tournament settlement whose prize + commission does not sum to exactly 100%', async () => {
    const { relayer, playerA, playerB, token, rewardDistributor, tournament } = await deployEconomy();
    for (const p of [playerA, playerB]) {
      await rewardDistributor.connect(relayer).grantTrainingReward(p.address, ethers.parseEther('10'), 'seed');
      await token.connect(p).approve(await tournament.getAddress(), ethers.parseEther('10'));
    }
    const tId = 2;
    await tournament.connect(relayer).createTournament(tId, ethers.parseEther('10'), 2);
    await tournament.connect(relayer).enterTournament(tId, playerA.address);
    await tournament.connect(relayer).enterTournament(tId, playerB.address);
    await tournament.connect(relayer).startTournament(tId);

    // 6000 + 1000 commission = 7000, leaving 30% stranded -- must revert, not silently lock funds.
    await expect(
      tournament.connect(relayer).settleTournament(tId, [playerA.address], [6000])
    ).to.be.revertedWith('prize allocation must total exactly 100%');
  });

  it('rejects a tournament settlement that lists the same winner twice', async () => {
    const { relayer, playerA, playerB, token, rewardDistributor, tournament } = await deployEconomy();
    for (const p of [playerA, playerB]) {
      await rewardDistributor.connect(relayer).grantTrainingReward(p.address, ethers.parseEther('10'), 'seed');
      await token.connect(p).approve(await tournament.getAddress(), ethers.parseEther('10'));
    }
    const tId = 3;
    await tournament.connect(relayer).createTournament(tId, ethers.parseEther('10'), 2);
    await tournament.connect(relayer).enterTournament(tId, playerA.address);
    await tournament.connect(relayer).enterTournament(tId, playerB.address);
    await tournament.connect(relayer).startTournament(tId);

    await expect(
      tournament.connect(relayer).settleTournament(tId, [playerA.address, playerA.address], [4500, 4500])
    ).to.be.revertedWith('duplicate winner');
  });
});
