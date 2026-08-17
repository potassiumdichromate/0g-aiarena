/**
 * A2AJobEscrow — job posting.
 *
 * Phase 4 covers registration only: funding, settlement and dispute paths land
 * in Phase 6 with fork tests against real USDC. What is tested here is the
 * part that is already live-affecting — a job posted with bad bounds, or a
 * duplicate id, must revert rather than reaching the chain.
 *
 *   npx hardhat test test/A2AJobEscrow.postJob.test.ts
 */

import { expect } from 'chai';
import { ethers } from 'hardhat';
import type { A2AJobEscrow } from '../typechain-types';
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

const JobStatus = {
  NONE: 0n, POSTED: 1n, ESCROWED: 2n, EXECUTING: 3n, DELIVERED: 4n,
  SETTLED: 5n, REFUNDED: 6n, CANCELLED: 7n, DISPUTED: 8n,
};

const MIN_WINDOW = 5 * 60;
const MAX_WINDOW = 30 * 24 * 60 * 60;

describe('A2AJobEscrow — postJob', () => {
  let escrow: A2AJobEscrow;
  let admin: HardhatEthersSigner;
  let relayer: HardhatEthersSigner;
  let creator: HardhatEthersSigner;
  let outsider: HardhatEthersSigner;

  const jobId = ethers.keccak256(ethers.toUtf8Bytes('job-1'));
  const requirementsHash = ethers.keccak256(ethers.toUtf8Bytes('requirements'));
  const budgetMin = 250_000n; // 0.25 USDC
  const budgetMax = 500_000n; // 0.50 USDC
  const window = 6 * 60 * 60;

  beforeEach(async () => {
    [admin, relayer, creator, outsider] = await ethers.getSigners();

    const Factory = await ethers.getContractFactory('A2AJobEscrow');
    escrow = await Factory.deploy(admin.address, USDC_BASE, admin.address);
    await escrow.waitForDeployment();
    await escrow.connect(admin).grantRole(await escrow.RELAYER_ROLE(), relayer.address);
  });

  async function post(overrides: Partial<{ jobId: string; budgetMin: bigint; budgetMax: bigint; window: number }> = {}) {
    return escrow.connect(relayer).postJob(
      overrides.jobId ?? jobId,
      1n,
      creator.address,
      requirementsHash,
      overrides.budgetMin ?? budgetMin,
      overrides.budgetMax ?? budgetMax,
      overrides.window ?? window,
    );
  }

  // ── Happy path ────────────────────────────────────────────────────────────

  it('stores the job and emits JobPosted', async () => {
    await expect(post())
      .to.emit(escrow, 'JobPosted')
      .withArgs(jobId, 1n, creator.address, requirementsHash, budgetMin, budgetMax, window);

    const job = await escrow.getJob(jobId);
    expect(job.status).to.equal(JobStatus.POSTED);
    expect(job.requirementsHash).to.equal(requirementsHash);
    expect(job.budgetMin).to.equal(budgetMin);
    expect(job.budgetMax).to.equal(budgetMax);
    expect(job.creatorWallet).to.equal(creator.address);
    // Provider fields stay empty until funding chooses one.
    expect(job.providerAgentId).to.equal(0n);
    expect(job.providerWallet).to.equal(ethers.ZeroAddress);
    expect(job.agreedPrice).to.equal(0n);
  });

  it('posting moves no funds', async () => {
    await post();
    expect(await ethers.provider.getBalance(await escrow.getAddress())).to.equal(0n);
  });

  it('allows an exact budget (min == max)', async () => {
    await expect(post({ budgetMin: 400_000n, budgetMax: 400_000n })).to.not.be.reverted;
  });

  // ── Duplicate protection (T7) ─────────────────────────────────────────────

  it('rejects a duplicate jobId', async () => {
    await post();
    // A retried post must collide rather than create a second job.
    await expect(post()).to.be.revertedWith('job exists');
  });

  it('rejects re-posting a cancelled job id', async () => {
    await post();
    await escrow.connect(relayer).cancelBeforeFunding(jobId);
    await expect(post()).to.be.revertedWith('job exists');
  });

  // ── Access control ────────────────────────────────────────────────────────

  it('only the relayer may post', async () => {
    await expect(
      escrow.connect(outsider).postJob(jobId, 1n, creator.address, requirementsHash, budgetMin, budgetMax, window),
    ).to.be.revertedWithCustomError(escrow, 'AccessControlUnauthorizedAccount');
  });

  it('only the relayer may cancel', async () => {
    await post();
    await expect(escrow.connect(outsider).cancelBeforeFunding(jobId))
      .to.be.revertedWithCustomError(escrow, 'AccessControlUnauthorizedAccount');
  });

  // ── Validation ────────────────────────────────────────────────────────────

  it('rejects an inverted budget range', async () => {
    await expect(post({ budgetMin: 500_000n, budgetMax: 250_000n })).to.be.revertedWith('budget max < min');
  });

  it('rejects a zero budget', async () => {
    await expect(post({ budgetMin: 0n, budgetMax: 500_000n })).to.be.revertedWith('zero budget min');
  });

  it('rejects a zero requirements hash', async () => {
    // A zero hash would commit to nothing while looking valid on-chain.
    await expect(
      escrow.connect(relayer).postJob(jobId, 1n, creator.address, ethers.ZeroHash, budgetMin, budgetMax, window),
    ).to.be.revertedWith('zero requirements hash');
  });

  it('rejects a zero creator wallet', async () => {
    // This is the refund destination — a zero address burns the refund path.
    await expect(
      escrow.connect(relayer).postJob(jobId, 1n, ethers.ZeroAddress, requirementsHash, budgetMin, budgetMax, window),
    ).to.be.revertedWith('zero creator wallet');
  });

  it('rejects a zero creator agent id', async () => {
    await expect(
      escrow.connect(relayer).postJob(jobId, 0n, creator.address, requirementsHash, budgetMin, budgetMax, window),
    ).to.be.revertedWith('zero creator agent');
  });

  it('enforces execution window bounds', async () => {
    // Too short: no realistic chance to deliver. Too long: the creator's USDC
    // is locked for over a month before a timeout refund is claimable.
    await expect(post({ window: MIN_WINDOW - 1 })).to.be.revertedWith('bad execution window');
    await expect(post({ window: MAX_WINDOW + 1 })).to.be.revertedWith('bad execution window');
    await expect(post({ window: MIN_WINDOW })).to.not.be.reverted;
  });

  // ── Pausing ───────────────────────────────────────────────────────────────

  it('pausing blocks new jobs', async () => {
    await escrow.connect(admin).pause();
    await expect(post()).to.be.revertedWithCustomError(escrow, 'EnforcedPause');

    await escrow.connect(admin).unpause();
    await expect(post()).to.not.be.reverted;
  });

  // ── Views ─────────────────────────────────────────────────────────────────

  it('exists() and jobStatus() report accurately', async () => {
    expect(await escrow.exists(jobId)).to.equal(false);
    expect(await escrow.jobStatus(jobId)).to.equal(JobStatus.NONE);

    await post();
    expect(await escrow.exists(jobId)).to.equal(true);
    expect(await escrow.jobStatus(jobId)).to.equal(JobStatus.POSTED);
  });

  it('an unfunded job is never refund-claimable', async () => {
    await post();
    // Nothing was escrowed, so there is nothing to reclaim.
    expect(await escrow.refundClaimable(jobId)).to.equal(false);
  });

  // ── Admin config ──────────────────────────────────────────────────────────

  it('commission is capped', async () => {
    await expect(escrow.connect(admin).setCommissionBps(2001)).to.be.revertedWith('commission too high');
    await expect(escrow.connect(admin).setCommissionBps(2000)).to.not.be.reverted;
    expect(await escrow.commissionBps()).to.equal(2000);
  });

  it('only admin may change commission or treasury', async () => {
    await expect(escrow.connect(relayer).setCommissionBps(500))
      .to.be.revertedWithCustomError(escrow, 'AccessControlUnauthorizedAccount');
    await expect(escrow.connect(relayer).setTreasury(outsider.address))
      .to.be.revertedWithCustomError(escrow, 'AccessControlUnauthorizedAccount');
  });

  it('roles are separated — the relayer is not an admin or verifier', async () => {
    expect(await escrow.hasRole(await escrow.DEFAULT_ADMIN_ROLE(), relayer.address)).to.equal(false);
    expect(await escrow.hasRole(await escrow.VERIFIER_ROLE(), relayer.address)).to.equal(false);
    expect(await escrow.hasRole(await escrow.ARBITER_ROLE(), relayer.address)).to.equal(false);
  });
});
