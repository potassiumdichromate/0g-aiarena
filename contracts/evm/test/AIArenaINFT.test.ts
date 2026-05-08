import { expect } from 'chai';
import { ethers } from 'hardhat';
import { AIArenaINFT } from '../typechain-types';

describe('AIArenaINFT', () => {
  let inft: AIArenaINFT;
  let owner: any;
  let operator: any;
  let player: any;

  const sampleTraits = {
    aggression: 70,
    patience: 40,
    adaptability: 60,
    riskTolerance: 65,
    teamwork: 45,
    creativity: 55,
    endurance: 75,
    precision: 80,
  };

  beforeEach(async () => {
    [owner, operator, player] = await ethers.getSigners();
    const AIArenaINFT = await ethers.getContractFactory('AIArenaINFT');
    inft = (await AIArenaINFT.deploy()) as AIArenaINFT;
    await inft.waitForDeployment();

    // Set operator
    await inft.setOperator(operator.address, true);
  });

  it('should deploy correctly', async () => {
    expect(await inft.name()).to.equal('AI Arena Agent');
    expect(await inft.symbol()).to.equal('ARENA');
  });

  it('should mint a new agent INFT', async () => {
    const tx = await inft.connect(operator).mintAgent(
      player.address,
      'agent-uuid-123',
      'CYBER',
      'BERSERKER',
      sampleTraits,
      'ipfs://QmExampleHash'
    );

    await tx.wait();
    expect(await inft.totalSupply()).to.equal(1n);
    expect(await inft.ownerOf(1)).to.equal(player.address);
  });

  it('should evolve an agent to next stage', async () => {
    await inft.connect(operator).mintAgent(
      player.address,
      'agent-uuid-456',
      'BIO',
      'TACTICIAN',
      sampleTraits,
      'ipfs://QmHash1'
    );

    const updatedTraits = { ...sampleTraits, aggression: 80, precision: 90 };
    await inft.connect(operator).evolveAgent(1, updatedTraits, 'ipfs://QmHash2');

    const meta = await inft.agentMetadata(1);
    expect(meta.evolutionStage).to.equal(1);
  });

  it('should update memory root', async () => {
    await inft.connect(operator).mintAgent(
      player.address,
      'agent-uuid-789',
      'ARCANE',
      'SUPPORT',
      sampleTraits,
      'ipfs://QmHash3'
    );

    const memoryRoot = ethers.keccak256(ethers.toUtf8Bytes('memory-data'));
    await inft.connect(operator).updateMemoryRoot(1, memoryRoot);

    const meta = await inft.agentMetadata(1);
    expect(meta.memoryRootHash).to.equal(memoryRoot);
  });

  it('should reject minting by non-operator', async () => {
    await expect(
      inft.connect(player).mintAgent(
        player.address,
        'agent-uuid-bad',
        'MECH',
        'DEFENDER',
        sampleTraits,
        'ipfs://bad'
      )
    ).to.be.revertedWith('Not authorised operator');
  });
});
