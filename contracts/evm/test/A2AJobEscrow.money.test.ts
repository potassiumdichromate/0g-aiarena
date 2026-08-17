/**
 * The money path: funding, settlement, refunds, disputes, and every way each
 * can go wrong.
 *
 * This suite is the reason the contract can be trusted with real USDC. It runs
 * against MockUSDC, which implements EIP-3009 with the same strictness as
 * Circle's FiatTokenV2 (single-use nonces, validity window, payee-only
 * submission) — a laxer mock would let replay tests pass here and fail on
 * mainnet.
 */

import { expect } from 'chai';
import { ethers } from 'hardhat';
import { Wallet, HDNodeWallet } from 'ethers';
import { time } from '@nomicfoundation/hardhat-network-helpers';

import { AGREEMENT_TYPES, buildDomain, type Agreement } from '../../../packages/a2a-protocol/src/eip712';

const USDC = (n: string) => ethers.parseUnits(n, 6);
const BUDGET_MIN = USDC('0.25');
const BUDGET_MAX = USDC('0.50');
const AGREED = USDC('0.40');
const EXECUTION_WINDOW = 6 * 60 * 60;
const VERIFICATION_GRACE = 2 * 24 * 60 * 60;

const JOB_ID = '0x' + 'ab'.repeat(32);
const REQ_HASH = '0x' + 'cd'.repeat(32);
const TRANSCRIPT_HASH = '0x' + 'ef'.repeat(32);
const DELIVERABLE_HASH = '0x' + '11'.repeat(32);
const REPORT_HASH = '0x' + '22'.repeat(32);

const RECEIVE_TYPES = {
  ReceiveWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

async function setup() {
  const [admin, relayer, verifier, arbiter, treasury] = await ethers.getSigners();

  const usdc = await (await ethers.getContractFactory('MockUSDC')).deploy();
  await usdc.waitForDeployment();

  const escrow = await (await ethers.getContractFactory('A2AJobEscrow')).deploy(
    admin.address, await usdc.getAddress(), treasury.address,
  );
  await escrow.waitForDeployment();

  await escrow.grantRole(await escrow.RELAYER_ROLE(), relayer.address);
  await escrow.grantRole(await escrow.VERIFIER_ROLE(), verifier.address);
  await escrow.grantRole(await escrow.ARBITER_ROLE(), arbiter.address);

  // Agents are plain EOAs funded with USDC; neither needs ETH, because the
  // relayer submits every transaction.
  const creator = Wallet.createRandom().connect(ethers.provider);
  const provider = Wallet.createRandom().connect(ethers.provider);
  await usdc.mint(creator.address, USDC('10'));

  const { chainId } = await ethers.provider.getNetwork();
  const domain = buildDomain(await escrow.getAddress(), Number(chainId));

  return { admin, relayer, verifier, arbiter, treasury, usdc, escrow, creator, provider, domain, chainId };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

async function postJob(ctx: Ctx, overrides: { jobId?: string; window?: number } = {}) {
  await ctx.escrow.connect(ctx.relayer).postJob(
    overrides.jobId ?? JOB_ID, 1n, ctx.creator.address, REQ_HASH,
    BUDGET_MIN, BUDGET_MAX, overrides.window ?? EXECUTION_WINDOW,
  );
}

async function agreementFor(ctx: Ctx, over: Partial<Agreement> = {}): Promise<Agreement> {
  return {
    jobId: JOB_ID,
    creatorAgentId: '1',
    providerAgentId: '2',
    providerWallet: ctx.provider.address,
    agreedPrice: AGREED.toString(),
    requirementsHash: REQ_HASH,
    executionWindow: EXECUTION_WINDOW,
    transcriptHash: TRANSCRIPT_HASH,
    // Chain time, not wall-clock: time.increase() in earlier tests pushes the
    // chain hours ahead, and a Date.now()-based expiry would already be past.
    expiry: (await time.latest()) + 86_400,
    ...over,
  };
}

function toStruct(a: Agreement) {
  return {
    jobId: a.jobId, creatorAgentId: a.creatorAgentId, providerAgentId: a.providerAgentId,
    providerWallet: a.providerWallet, agreedPrice: a.agreedPrice, requirementsHash: a.requirementsHash,
    executionWindow: a.executionWindow, transcriptHash: a.transcriptHash, expiry: a.expiry,
  };
}

async function buildAuth(ctx: Ctx, opts: { value?: bigint; to?: string; from?: HDNodeWallet; nonce?: string } = {}) {
  const escrowAddress = await ctx.escrow.getAddress();
  const signer = opts.from ?? (ctx.creator as unknown as HDNodeWallet);
  const value = opts.value ?? AGREED;
  const nonce = opts.nonce ?? ethers.hexlify(ethers.randomBytes(32));
  const now = await time.latest();

  const message = {
    from: signer.address,
    to: opts.to ?? escrowAddress,
    value,
    validAfter: 0,
    validBefore: now + 3600,
    nonce,
  };

  const tokenDomain = {
    name: 'USD Coin', version: '2',
    chainId: Number(ctx.chainId), verifyingContract: await ctx.usdc.getAddress(),
  };
  const signature = await signer.signTypedData(tokenDomain, RECEIVE_TYPES, message);
  const { v, r, s } = ethers.Signature.from(signature);

  return { ...message, v, r, s };
}

async function signBoth(ctx: Ctx, agreement: Agreement) {
  return {
    creatorSig: await ctx.creator.signTypedData(ctx.domain, AGREEMENT_TYPES as never, agreement),
    providerSig: await ctx.provider.signTypedData(ctx.domain, AGREEMENT_TYPES as never, agreement),
  };
}

async function fund(ctx: Ctx, over: Partial<Agreement> = {}, authOpts = {}) {
  const agreement = await agreementFor(ctx, over);
  const { creatorSig, providerSig } = await signBoth(ctx, agreement);
  const auth = await buildAuth(ctx, authOpts);

  return ctx.escrow.connect(ctx.relayer).fundWithAuthorization(
    JOB_ID, toStruct(agreement), ctx.creator.address, creatorSig,
    ctx.provider.address, providerSig, auth,
  );
}

async function fundAndDeliver(ctx: Ctx) {
  await postJob(ctx);
  await fund(ctx);
  await ctx.escrow.connect(ctx.relayer).markExecuting(JOB_ID);
  await ctx.escrow.connect(ctx.relayer).submitDeliverable(JOB_ID, DELIVERABLE_HASH);
}

describe('A2AJobEscrow — funding', () => {
  it('pulls USDC and records the agreement, with no ETH held by either agent', async () => {
    const ctx = await setup();
    await postJob(ctx);

    expect(await ethers.provider.getBalance(ctx.creator.address)).to.equal(0n);

    await fund(ctx);

    expect(await ctx.usdc.balanceOf(await ctx.escrow.getAddress())).to.equal(AGREED);
    const job = await ctx.escrow.getJob(JOB_ID);
    expect(job.status).to.equal(2); // ESCROWED
    expect(job.agreedPrice).to.equal(AGREED);
    expect(job.providerWallet).to.equal(ctx.provider.address);
    expect(job.commissionBps).to.equal(1000);
  });

  it('rejects a price above the budget ceiling', async () => {
    const ctx = await setup();
    await postJob(ctx);
    await expect(fund(ctx, { agreedPrice: USDC('0.75').toString() }, { value: USDC('0.75') }))
      .to.be.revertedWith('price outside budget');
  });

  it('rejects a price below the budget floor', async () => {
    const ctx = await setup();
    await postJob(ctx);
    await expect(fund(ctx, { agreedPrice: USDC('0.10').toString() }, { value: USDC('0.10') }))
      .to.be.revertedWith('price outside budget');
  });

  it('rejects an agreement whose requirements hash does not match the posted job', async () => {
    const ctx = await setup();
    await postJob(ctx);
    await expect(fund(ctx, { requirementsHash: '0x' + '99'.repeat(32) }))
      .to.be.revertedWith('requirements mismatch');
  });

  it('rejects an expired agreement', async () => {
    const ctx = await setup();
    await postJob(ctx);
    await expect(fund(ctx, { expiry: (await time.latest()) - 1 })).to.be.revertedWith('agreement expired');
  });

  it('rejects self-dealing — provider wallet equal to creator wallet', async () => {
    const ctx = await setup();
    await postJob(ctx);
    const agreement = await agreementFor(ctx, { providerWallet: ctx.creator.address });
    const { creatorSig, providerSig } = await signBoth(ctx, agreement);
    const auth = await buildAuth(ctx);

    await expect(
      ctx.escrow.connect(ctx.relayer).fundWithAuthorization(
        JOB_ID, toStruct(agreement), ctx.creator.address, creatorSig,
        ctx.provider.address, providerSig, auth,
      ),
    ).to.be.revertedWith('self-dealing');
  });

  it('rejects an authorization whose value is less than the agreed price', async () => {
    const ctx = await setup();
    await postJob(ctx);
    await expect(fund(ctx, {}, { value: USDC('0.30') }))
      .to.be.revertedWith('authorization value != agreed price');
  });

  it('rejects an authorization payable to somewhere other than the escrow', async () => {
    const ctx = await setup();
    await postJob(ctx);
    await expect(fund(ctx, {}, { to: ctx.provider.address }))
      .to.be.revertedWith('authorization payee is not the escrow');
  });

  it('rejects a forged provider signature', async () => {
    const ctx = await setup();
    await postJob(ctx);
    const agreement = await agreementFor(ctx);
    const creatorSig = await ctx.creator.signTypedData(ctx.domain, AGREEMENT_TYPES as never, agreement);
    const auth = await buildAuth(ctx);

    // Creator's signature submitted in the provider's slot.
    await expect(
      ctx.escrow.connect(ctx.relayer).fundWithAuthorization(
        JOB_ID, toStruct(agreement), ctx.creator.address, creatorSig,
        ctx.provider.address, creatorSig, auth,
      ),
    ).to.be.revertedWith('bad agreement signatures');
  });

  it('cannot be funded twice (T7)', async () => {
    const ctx = await setup();
    await postJob(ctx);
    await fund(ctx);
    await expect(fund(ctx)).to.be.revertedWith('not fundable');
  });

  it('rejects a replayed EIP-3009 nonce (T6)', async () => {
    const ctx = await setup();
    await postJob(ctx);

    const nonce = ethers.hexlify(ethers.randomBytes(32));
    await fund(ctx, {}, { nonce });

    // Second job, same authorization nonce.
    const jobId2 = '0x' + 'be'.repeat(32);
    await ctx.escrow.connect(ctx.relayer).postJob(
      jobId2, 1n, ctx.creator.address, REQ_HASH, BUDGET_MIN, BUDGET_MAX, EXECUTION_WINDOW,
    );
    const agreement = await agreementFor(ctx, { jobId: jobId2 });
    const { creatorSig, providerSig } = await signBoth(ctx, agreement);
    const auth = await buildAuth(ctx, { nonce });

    await expect(
      ctx.escrow.connect(ctx.relayer).fundWithAuthorization(
        jobId2, toStruct(agreement), ctx.creator.address, creatorSig,
        ctx.provider.address, providerSig, auth,
      ),
    ).to.be.revertedWith('FiatTokenV2: authorization is used or canceled');
  });

  it('only the relayer can fund', async () => {
    const ctx = await setup();
    await postJob(ctx);
    const agreement = await agreementFor(ctx);
    const { creatorSig, providerSig } = await signBoth(ctx, agreement);
    const auth = await buildAuth(ctx);

    await expect(
      ctx.escrow.connect(ctx.verifier).fundWithAuthorization(
        JOB_ID, toStruct(agreement), ctx.creator.address, creatorSig,
        ctx.provider.address, providerSig, auth,
      ),
    ).to.be.reverted;
  });
});

describe('A2AJobEscrow — settlement', () => {
  it('pays the provider and takes commission on an accepted verdict', async () => {
    const ctx = await setup();
    await fundAndDeliver(ctx);

    await ctx.escrow.connect(ctx.verifier).submitVerdict(JOB_ID, true, REPORT_HASH);

    const commission = (AGREED * 1000n) / 10_000n;
    expect(await ctx.usdc.balanceOf(ctx.provider.address)).to.equal(AGREED - commission);
    expect(await ctx.usdc.balanceOf(ctx.treasury.address)).to.equal(commission);
    expect(await ctx.usdc.balanceOf(await ctx.escrow.getAddress())).to.equal(0n);
    expect((await ctx.escrow.getJob(JOB_ID)).status).to.equal(5); // SETTLED
  });

  it('refunds the creator in full on a rejected verdict, taking no commission', async () => {
    const ctx = await setup();
    const before = await ctx.usdc.balanceOf(ctx.creator.address);
    await fundAndDeliver(ctx);

    await ctx.escrow.connect(ctx.verifier).submitVerdict(JOB_ID, false, REPORT_HASH);

    expect(await ctx.usdc.balanceOf(ctx.creator.address)).to.equal(before);
    expect(await ctx.usdc.balanceOf(ctx.treasury.address)).to.equal(0n);
    expect((await ctx.escrow.getJob(JOB_ID)).status).to.equal(6); // REFUNDED
  });

  it('the relayer cannot render a verdict (T1)', async () => {
    const ctx = await setup();
    await fundAndDeliver(ctx);
    await expect(ctx.escrow.connect(ctx.relayer).submitVerdict(JOB_ID, true, REPORT_HASH)).to.be.reverted;
  });

  it('cannot settle a job that was never delivered', async () => {
    const ctx = await setup();
    await postJob(ctx);
    await fund(ctx);
    await expect(ctx.escrow.connect(ctx.verifier).submitVerdict(JOB_ID, true, REPORT_HASH))
      .to.be.revertedWith('not delivered');
  });

  it('cannot settle the same job twice', async () => {
    const ctx = await setup();
    await fundAndDeliver(ctx);
    await ctx.escrow.connect(ctx.verifier).submitVerdict(JOB_ID, true, REPORT_HASH);
    await expect(ctx.escrow.connect(ctx.verifier).submitVerdict(JOB_ID, true, REPORT_HASH))
      .to.be.revertedWith('not delivered');
  });

  it('rejects a deliverable submitted after the execution deadline', async () => {
    const ctx = await setup();
    await postJob(ctx);
    await fund(ctx);
    await time.increase(EXECUTION_WINDOW + 60);
    await expect(ctx.escrow.connect(ctx.relayer).submitDeliverable(JOB_ID, DELIVERABLE_HASH))
      .to.be.revertedWith('past execution deadline');
  });
});

describe('A2AJobEscrow — recovery', () => {
  it('anyone can trigger a timeout refund, and it pays only the creator', async () => {
    const ctx = await setup();
    const before = await ctx.usdc.balanceOf(ctx.creator.address);
    await postJob(ctx);
    await fund(ctx);

    await time.increase(EXECUTION_WINDOW + 60);

    // A completely unrelated account calls it.
    const [, , , , , stranger] = await ethers.getSigners();
    await ctx.escrow.connect(stranger).claimTimeoutRefund(JOB_ID);

    expect(await ctx.usdc.balanceOf(ctx.creator.address)).to.equal(before);
    expect(await ctx.usdc.balanceOf(stranger.address)).to.equal(0n);
  });

  it('timeout refund still works while the contract is paused (liveness)', async () => {
    const ctx = await setup();
    const before = await ctx.usdc.balanceOf(ctx.creator.address);
    await postJob(ctx);
    await fund(ctx);

    await time.increase(EXECUTION_WINDOW + 60);
    await ctx.escrow.connect(ctx.admin).pause();

    await ctx.escrow.claimTimeoutRefund(JOB_ID);
    expect(await ctx.usdc.balanceOf(ctx.creator.address)).to.equal(before);
  });

  it('refund is not claimable before the deadline', async () => {
    const ctx = await setup();
    await postJob(ctx);
    await fund(ctx);
    await expect(ctx.escrow.claimTimeoutRefund(JOB_ID)).to.be.revertedWith('not refund-claimable');
  });

  it('a delivered job gets a verifier grace period before refund is claimable', async () => {
    const ctx = await setup();
    await fundAndDeliver(ctx);

    await time.increase(EXECUTION_WINDOW + 60);
    expect(await ctx.escrow.refundClaimable(JOB_ID)).to.equal(false);

    await time.increase(VERIFICATION_GRACE);
    expect(await ctx.escrow.refundClaimable(JOB_ID)).to.equal(true);
  });

  it('a verifier that never responds cannot trap the creator', async () => {
    const ctx = await setup();
    const before = await ctx.usdc.balanceOf(ctx.creator.address);
    await fundAndDeliver(ctx);

    await time.increase(EXECUTION_WINDOW + VERIFICATION_GRACE + 60);
    await ctx.escrow.claimTimeoutRefund(JOB_ID);

    expect(await ctx.usdc.balanceOf(ctx.creator.address)).to.equal(before);
  });

  it('cannot double-refund', async () => {
    const ctx = await setup();
    await postJob(ctx);
    await fund(ctx);
    await time.increase(EXECUTION_WINDOW + 60);
    await ctx.escrow.claimTimeoutRefund(JOB_ID);
    await expect(ctx.escrow.claimTimeoutRefund(JOB_ID)).to.be.revertedWith('not refund-claimable');
  });

  it('a settled job cannot then be refunded', async () => {
    const ctx = await setup();
    await fundAndDeliver(ctx);
    await ctx.escrow.connect(ctx.verifier).submitVerdict(JOB_ID, true, REPORT_HASH);
    await time.increase(EXECUTION_WINDOW + VERIFICATION_GRACE + 60);
    await expect(ctx.escrow.claimTimeoutRefund(JOB_ID)).to.be.revertedWith('not refund-claimable');
  });
});

describe('A2AJobEscrow — disputes', () => {
  it('either party may raise a dispute; a stranger may not', async () => {
    const ctx = await setup();
    await postJob(ctx);
    await fund(ctx);

    const [, , , , , stranger] = await ethers.getSigners();
    await expect(ctx.escrow.connect(stranger).raiseDispute(JOB_ID)).to.be.revertedWith('not a party to this job');

    // Fund the provider with a little ETH so it can send its own transaction.
    await stranger.sendTransaction({ to: ctx.provider.address, value: ethers.parseEther('0.01') });
    await ctx.escrow.connect(ctx.provider).raiseDispute(JOB_ID);
    expect((await ctx.escrow.getJob(JOB_ID)).status).to.equal(8); // DISPUTED
  });

  it('a dispute stops the timeout-refund clock', async () => {
    const ctx = await setup();
    await postJob(ctx);
    await fund(ctx);

    const [, , , , , stranger] = await ethers.getSigners();
    await stranger.sendTransaction({ to: ctx.provider.address, value: ethers.parseEther('0.01') });
    await ctx.escrow.connect(ctx.provider).raiseDispute(JOB_ID);

    await time.increase(EXECUTION_WINDOW + VERIFICATION_GRACE + 60);
    expect(await ctx.escrow.refundClaimable(JOB_ID)).to.equal(false);
  });

  it('the arbiter can split the escrow for partial completion (T12)', async () => {
    const ctx = await setup();
    const creatorBefore = await ctx.usdc.balanceOf(ctx.creator.address);
    await postJob(ctx);
    await fund(ctx);

    const [, , , , , stranger] = await ethers.getSigners();
    await stranger.sendTransaction({ to: ctx.provider.address, value: ethers.parseEther('0.01') });
    await ctx.escrow.connect(ctx.provider).raiseDispute(JOB_ID);

    const toProvider = USDC('0.25');
    const toCreator = AGREED - toProvider;
    await ctx.escrow.connect(ctx.arbiter).resolveDispute(JOB_ID, toProvider, toCreator);

    expect(await ctx.usdc.balanceOf(ctx.provider.address)).to.equal(toProvider);
    expect(await ctx.usdc.balanceOf(ctx.creator.address)).to.equal(creatorBefore - AGREED + toCreator);
    expect(await ctx.usdc.balanceOf(await ctx.escrow.getAddress())).to.equal(0n);
  });

  it('a split that does not equal the escrowed amount is rejected', async () => {
    const ctx = await setup();
    await postJob(ctx);
    await fund(ctx);

    const [, , , , , stranger] = await ethers.getSigners();
    await stranger.sendTransaction({ to: ctx.provider.address, value: ethers.parseEther('0.01') });
    await ctx.escrow.connect(ctx.provider).raiseDispute(JOB_ID);

    await expect(ctx.escrow.connect(ctx.arbiter).resolveDispute(JOB_ID, AGREED, USDC('0.01')))
      .to.be.revertedWith('split must equal the escrowed amount');
  });

  it('only the arbiter can resolve', async () => {
    const ctx = await setup();
    await postJob(ctx);
    await fund(ctx);

    const [, , , , , stranger] = await ethers.getSigners();
    await stranger.sendTransaction({ to: ctx.provider.address, value: ethers.parseEther('0.01') });
    await ctx.escrow.connect(ctx.provider).raiseDispute(JOB_ID);

    await expect(ctx.escrow.connect(ctx.relayer).resolveDispute(JOB_ID, AGREED, 0)).to.be.reverted;
  });
});

describe('A2AJobEscrow — admin bounds', () => {
  it('commission is capped and locked per job at funding time', async () => {
    const ctx = await setup();
    await postJob(ctx);
    await fund(ctx);

    // Admin raises the rate after this job was funded.
    await ctx.escrow.connect(ctx.admin).setCommissionBps(2000);

    await ctx.escrow.connect(ctx.relayer).markExecuting(JOB_ID);
    await ctx.escrow.connect(ctx.relayer).submitDeliverable(JOB_ID, DELIVERABLE_HASH);
    await ctx.escrow.connect(ctx.verifier).submitVerdict(JOB_ID, true, REPORT_HASH);

    // Still charged the 10% locked in at funding, not the new 20%.
    expect(await ctx.usdc.balanceOf(ctx.treasury.address)).to.equal((AGREED * 1000n) / 10_000n);
  });

  it('commission cannot exceed the hard cap', async () => {
    const ctx = await setup();
    await expect(ctx.escrow.connect(ctx.admin).setCommissionBps(2001)).to.be.reverted;
  });

  it('pause blocks new funding but never refunds', async () => {
    const ctx = await setup();
    await postJob(ctx);
    await ctx.escrow.connect(ctx.admin).pause();
    await expect(fund(ctx)).to.be.reverted;
  });
});
