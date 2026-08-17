import { expect } from 'chai';
import { ethers } from 'hardhat';
import { time } from '@nomicfoundation/hardhat-network-helpers';
import type { HardhatEthersSigner } from '@nomicfoundation/hardhat-ethers/signers';
import type { CreatorStudioSubscription } from '../typechain-types';

const FREE = 0;
const PLUS = 1;
const PRO = 2;

const PERIOD = 30n * 24n * 60n * 60n;
const PLUS_PRICE = ethers.parseEther('10');
const PRO_PRICE = ethers.parseEther('25');
const NO_EXPIRY = 2n ** 64n - 1n;

const EIP712_TYPES = {
  SubscribeRequest: [
    { name: 'account', type: 'address' },
    { name: 'tier', type: 'uint8' },
    { name: 'periods', type: 'uint8' },
    { name: 'autoRenew', type: 'bool' },
    { name: 'maxCost', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
};

describe('CreatorStudioSubscription', () => {
  let sub: CreatorStudioSubscription;
  let admin: HardhatEthersSigner;
  let relayer: HardhatEthersSigner;
  let treasury: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let other: HardhatEthersSigner;
  let subAddress: string;

  beforeEach(async () => {
    [admin, relayer, treasury, user, other] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory('CreatorStudioSubscription');
    sub = await Factory.deploy(admin.address, relayer.address, treasury.address, PLUS_PRICE, PRO_PRICE);
    await sub.waitForDeployment();
    subAddress = await sub.getAddress();
  });

  async function domain() {
    return {
      name: 'AIArena Creator Studio',
      version: '1',
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: subAddress,
    };
  }

  async function signRequest(signer: HardhatEthersSigner, req: Record<string, unknown>) {
    return signer.signTypedData(await domain(), EIP712_TYPES, req);
  }

  // ── Deployment ────────────────────────────────────────────────────────────

  describe('deployment', () => {
    it('sets tier prices from constructor args', async () => {
      expect(await sub.tierPrice(FREE)).to.equal(0n);
      expect(await sub.tierPrice(PLUS)).to.equal(PLUS_PRICE);
      expect(await sub.tierPrice(PRO)).to.equal(PRO_PRICE);
    });

    it('wires treasury and roles', async () => {
      expect(await sub.treasury()).to.equal(treasury.address);
      expect(await sub.hasRole(await sub.RELAYER_ROLE(), relayer.address)).to.equal(true);
      expect(await sub.hasRole(await sub.DEFAULT_ADMIN_ROLE(), admin.address)).to.equal(true);
    });

    it('rejects a zero treasury', async () => {
      const Factory = await ethers.getContractFactory('CreatorStudioSubscription');
      await expect(
        Factory.deploy(admin.address, relayer.address, ethers.ZeroAddress, PLUS_PRICE, PRO_PRICE),
      ).to.be.revertedWithCustomError(sub, 'ZeroAddress');
    });
  });

  // ── Path A: direct payment ────────────────────────────────────────────────

  describe('subscribe (direct)', () => {
    it('forwards the full fee to the treasury in the same tx', async () => {
      await expect(sub.connect(user).subscribe(PLUS, 1, { value: PLUS_PRICE })).to.changeEtherBalances(
        [treasury, sub],
        [PLUS_PRICE, 0n],
      );
      expect(await sub.totalCollected()).to.equal(PLUS_PRICE);
    });

    it('activates the tier for exactly 30 days', async () => {
      const tx = await sub.connect(user).subscribe(PRO, 1, { value: PRO_PRICE });
      const block = await ethers.provider.getBlock(tx.blockNumber!);
      const info = await sub.subscriptionOf(user.address);

      expect(info.tier).to.equal(BigInt(PRO));
      expect(info.active).to.equal(true);
      expect(info.expiresAt).to.equal(BigInt(block!.timestamp) + PERIOD);
      expect(await sub.currentTier(user.address)).to.equal(BigInt(PRO));
    });

    it('charges periods × price for a multi-month purchase', async () => {
      await expect(sub.connect(user).subscribe(PLUS, 12, { value: PLUS_PRICE * 12n })).to.changeEtherBalance(
        treasury,
        PLUS_PRICE * 12n,
      );
      const info = await sub.subscriptionOf(user.address);
      expect(info.expiresAt).to.be.greaterThan(BigInt(await time.latest()) + PERIOD * 11n);
    });

    it('reverts when underpaid', async () => {
      await expect(sub.connect(user).subscribe(PLUS, 1, { value: PLUS_PRICE - 1n }))
        .to.be.revertedWithCustomError(sub, 'InsufficientPayment')
        .withArgs(PLUS_PRICE, PLUS_PRICE - 1n);
    });

    it('routes overpayment into withdrawable credit', async () => {
      await sub.connect(user).subscribe(PLUS, 1, { value: PLUS_PRICE + ethers.parseEther('3') });
      expect(await sub.credit(user.address)).to.equal(ethers.parseEther('3'));
      expect(await sub.totalCredit()).to.equal(ethers.parseEther('3'));
    });

    it('activates Free with no payment and no expiry', async () => {
      await sub.connect(user).subscribe(FREE, 0);
      const info = await sub.subscriptionOf(user.address);
      expect(info.tier).to.equal(BigInt(FREE));
      expect(info.expiresAt).to.equal(NO_EXPIRY);
      expect(info.active).to.equal(true);
    });

    it('rejects periods on Free and zero periods on a paid tier', async () => {
      await expect(sub.connect(user).subscribe(FREE, 1)).to.be.revertedWithCustomError(
        sub,
        'FreeTierTakesNoPeriods',
      );
      await expect(sub.connect(user).subscribe(PLUS, 0, { value: 0 })).to.be.revertedWithCustomError(
        sub,
        'PaidTierRequiresPeriods',
      );
    });

    it('caps a single purchase at MAX_PERIODS', async () => {
      await expect(sub.connect(user).subscribe(PLUS, 25, { value: PLUS_PRICE * 25n }))
        .to.be.revertedWithCustomError(sub, 'InvalidPeriods')
        .withArgs(25);
    });

    it('lets a third party pay on someone else’s behalf', async () => {
      await sub.connect(other).subscribeFor(user.address, PRO, 1, { value: PRO_PRICE });
      expect(await sub.currentTier(user.address)).to.equal(BigInt(PRO));
      expect(await sub.isActive(other.address)).to.equal(false);
    });
  });

  // ── Expiry & renewal stacking ─────────────────────────────────────────────

  describe('expiry', () => {
    it('lapses to Free after the period ends', async () => {
      await sub.connect(user).subscribe(PLUS, 1, { value: PLUS_PRICE });
      await time.increase(PERIOD + 1n);

      expect(await sub.isActive(user.address)).to.equal(false);
      expect(await sub.currentTier(user.address)).to.equal(BigInt(FREE));
    });

    it('stacks a same-tier renewal onto the existing expiry', async () => {
      await sub.connect(user).subscribe(PLUS, 1, { value: PLUS_PRICE });
      const first = (await sub.subscriptionOf(user.address)).expiresAt;

      await time.increase(10n * 24n * 60n * 60n);
      await sub.connect(user).subscribe(PLUS, 1, { value: PLUS_PRICE });

      expect((await sub.subscriptionOf(user.address)).expiresAt).to.equal(first + PERIOD);
    });

    it('restarts from now when renewing after a lapse', async () => {
      await sub.connect(user).subscribe(PLUS, 1, { value: PLUS_PRICE });
      await time.increase(PERIOD + 100n);
      await sub.connect(user).subscribe(PLUS, 1, { value: PLUS_PRICE });

      const now = BigInt(await time.latest());
      expect((await sub.subscriptionOf(user.address)).expiresAt).to.equal(now + PERIOD);
    });
  });

  // ── Tier changes ──────────────────────────────────────────────────────────

  describe('tier changes', () => {
    it('carries unused Plus value into Pro time on upgrade', async () => {
      await sub.connect(user).subscribe(PLUS, 1, { value: PLUS_PRICE });
      await time.increase(PERIOD / 2n); // 15 days left = 5 0G of value

      await sub.connect(user).subscribe(PRO, 1, { value: PRO_PRICE });

      // 5 0G at the Pro rate (25 0G / 30d) = 6 days.
      const now = BigInt(await time.latest());
      const expiresAt = (await sub.subscriptionOf(user.address)).expiresAt;
      const bonus = expiresAt - now - PERIOD;
      expect(bonus).to.be.closeTo(6n * 24n * 60n * 60n, 5n);
      expect(await sub.currentTier(user.address)).to.equal(BigInt(PRO));
    });

    it('carries unused Pro value into a longer Plus window on downgrade', async () => {
      await sub.connect(user).subscribe(PRO, 1, { value: PRO_PRICE });
      await time.increase(PERIOD / 2n); // 15 days left = 12.5 0G of value

      await sub.connect(user).subscribe(PLUS, 1, { value: PLUS_PRICE });

      // 12.5 0G at the Plus rate (10 0G / 30d) = 37.5 days.
      const now = BigInt(await time.latest());
      const bonus = (await sub.subscriptionOf(user.address)).expiresAt - now - PERIOD;
      expect(bonus).to.be.closeTo((75n * 24n * 60n * 60n) / 2n, 10n);
    });

    it('matches previewExpiry against the real result', async () => {
      await sub.connect(user).subscribe(PLUS, 1, { value: PLUS_PRICE });
      await time.increase(PERIOD / 3n);

      const preview = await sub.previewExpiry(user.address, PRO, 2);
      await sub.connect(user).subscribe(PRO, 2, { value: PRO_PRICE * 2n });

      expect((await sub.subscriptionOf(user.address)).expiresAt).to.be.closeTo(preview, 5n);
    });

    it('gives no carry-over from an expired subscription', async () => {
      await sub.connect(user).subscribe(PLUS, 1, { value: PLUS_PRICE });
      await time.increase(PERIOD + 1n);
      await sub.connect(user).subscribe(PRO, 1, { value: PRO_PRICE });

      const now = BigInt(await time.latest());
      expect((await sub.subscriptionOf(user.address)).expiresAt).to.equal(now + PERIOD);
    });

    it('gives no carry-over from the Free tier', async () => {
      await sub.connect(user).subscribe(FREE, 0);
      await sub.connect(user).subscribe(PRO, 1, { value: PRO_PRICE });

      const now = BigInt(await time.latest());
      expect((await sub.subscriptionOf(user.address)).expiresAt).to.equal(now + PERIOD);
    });
  });

  // ── Credit ────────────────────────────────────────────────────────────────

  describe('credit', () => {
    it('accepts a top-up and a plain transfer alike', async () => {
      await sub.connect(user).depositCredit({ value: ethers.parseEther('20') });
      await user.sendTransaction({ to: subAddress, value: ethers.parseEther('5') });

      expect(await sub.credit(user.address)).to.equal(ethers.parseEther('25'));
      expect(await sub.totalCredit()).to.equal(ethers.parseEther('25'));
    });

    it('lets the deployer sponsor a user', async () => {
      await sub.connect(admin).depositCreditFor(user.address, { value: PRO_PRICE });
      expect(await sub.credit(user.address)).to.equal(PRO_PRICE);
      expect(await sub.credit(admin.address)).to.equal(0n);
    });

    it('withdraws credit back to the owner', async () => {
      await sub.connect(user).depositCredit({ value: ethers.parseEther('20') });
      await expect(sub.connect(user).withdrawCredit(ethers.parseEther('8'))).to.changeEtherBalance(
        sub,
        -ethers.parseEther('8'),
      );
      expect(await sub.credit(user.address)).to.equal(ethers.parseEther('12'));
    });

    it('withdraws everything with uint256 max', async () => {
      await sub.connect(user).depositCredit({ value: ethers.parseEther('20') });
      await sub.connect(user).withdrawCredit(ethers.MaxUint256);
      expect(await sub.credit(user.address)).to.equal(0n);
      expect(await sub.totalCredit()).to.equal(0n);
    });

    it('never lets one account withdraw another’s credit', async () => {
      await sub.connect(user).depositCredit({ value: ethers.parseEther('20') });
      await expect(sub.connect(other).withdrawCredit(1n)).to.be.revertedWithCustomError(
        sub,
        'InsufficientCredit',
      );
    });

    it('keeps withdrawals open while paused', async () => {
      await sub.connect(user).depositCredit({ value: ethers.parseEther('20') });
      await sub.connect(admin).pause();
      await expect(sub.connect(user).withdrawCredit(ethers.MaxUint256)).to.not.be.reverted;
    });
  });

  // ── Path B: gasless ───────────────────────────────────────────────────────

  describe('subscribeWithSignature (gasless)', () => {
    async function buildRequest(overrides: Record<string, unknown> = {}) {
      return {
        account: user.address,
        tier: PRO,
        periods: 1,
        autoRenew: false,
        maxCost: PRO_PRICE,
        nonce: await sub.nonces(user.address),
        deadline: BigInt(await time.latest()) + 3600n,
        ...overrides,
      };
    }

    it('subscribes without the user spending any gas', async () => {
      await sub.connect(admin).depositCreditFor(user.address, { value: PRO_PRICE });
      const req = await buildRequest();
      const sig = await signRequest(user, req);

      const before = await ethers.provider.getBalance(user.address);
      await expect(sub.connect(relayer).subscribeWithSignature(req, sig)).to.changeEtherBalance(
        treasury,
        PRO_PRICE,
      );

      expect(await ethers.provider.getBalance(user.address)).to.equal(before);
      expect(await sub.currentTier(user.address)).to.equal(BigInt(PRO));
      expect(await sub.credit(user.address)).to.equal(0n);
    });

    it('consumes the nonce so the signature cannot be replayed', async () => {
      await sub.connect(user).depositCredit({ value: PRO_PRICE * 2n });
      const req = await buildRequest();
      const sig = await signRequest(user, req);

      await sub.connect(relayer).subscribeWithSignature(req, sig);
      expect(await sub.nonces(user.address)).to.equal(1n);
      await expect(sub.connect(relayer).subscribeWithSignature(req, sig)).to.be.reverted;
    });

    it('rejects a signature from the wrong signer', async () => {
      await sub.connect(user).depositCredit({ value: PRO_PRICE });
      const req = await buildRequest();
      const sig = await signRequest(other, req);

      await expect(sub.connect(relayer).subscribeWithSignature(req, sig)).to.be.revertedWithCustomError(
        sub,
        'InvalidSignature',
      );
    });

    it('rejects a tampered request', async () => {
      await sub.connect(user).depositCredit({ value: PRO_PRICE * 5n });
      const req = await buildRequest();
      const sig = await signRequest(user, req);

      await expect(
        sub.connect(relayer).subscribeWithSignature({ ...req, periods: 5 }, sig),
      ).to.be.revertedWithCustomError(sub, 'InvalidSignature');
    });

    it('rejects an expired signature', async () => {
      await sub.connect(user).depositCredit({ value: PRO_PRICE });
      const req = await buildRequest({ deadline: BigInt(await time.latest()) + 60n });
      const sig = await signRequest(user, req);

      await time.increase(120n);
      await expect(sub.connect(relayer).subscribeWithSignature(req, sig)).to.be.revertedWithCustomError(
        sub,
        'SignatureExpired',
      );
    });

    it('honours maxCost when the admin raises the price after signing', async () => {
      await sub.connect(user).depositCredit({ value: ethers.parseEther('100') });
      const req = await buildRequest();
      const sig = await signRequest(user, req);

      await sub.connect(admin).setTierPrice(PRO, ethers.parseEther('40'));

      await expect(sub.connect(relayer).subscribeWithSignature(req, sig))
        .to.be.revertedWithCustomError(sub, 'PriceExceedsAuthorized')
        .withArgs(ethers.parseEther('40'), PRO_PRICE);
    });

    it('reverts when credit is short', async () => {
      await sub.connect(user).depositCredit({ value: PRO_PRICE - 1n });
      const req = await buildRequest();
      const sig = await signRequest(user, req);

      await expect(sub.connect(relayer).subscribeWithSignature(req, sig))
        .to.be.revertedWithCustomError(sub, 'InsufficientCredit')
        .withArgs(PRO_PRICE, PRO_PRICE - 1n);
    });

    it('is restricted to RELAYER_ROLE', async () => {
      await sub.connect(user).depositCredit({ value: PRO_PRICE });
      const req = await buildRequest();
      const sig = await signRequest(user, req);

      await expect(sub.connect(other).subscribeWithSignature(req, sig)).to.be.revertedWithCustomError(
        sub,
        'AccessControlUnauthorizedAccount',
      );
    });

    it('records auto-renew consent from the signed request', async () => {
      await sub.connect(user).depositCredit({ value: PRO_PRICE });
      const req = await buildRequest({ autoRenew: true });
      const sig = await signRequest(user, req);

      await expect(sub.connect(relayer).subscribeWithSignature(req, sig))
        .to.emit(sub, 'AutoRenewSet')
        .withArgs(user.address, true);
    });
  });

  // ── Auto-renew ────────────────────────────────────────────────────────────

  describe('renewFromCredit', () => {
    beforeEach(async () => {
      await sub.connect(user).subscribe(PLUS, 1, { value: PLUS_PRICE });
      await sub.connect(user).setAutoRenew(true);
      await sub.connect(user).depositCredit({ value: PLUS_PRICE * 3n });
    });

    it('renews inside the window and charges credit', async () => {
      await time.increase(PERIOD - 24n * 60n * 60n); // 1 day left
      expect(await sub.isDueForRenewal(user.address)).to.equal(true);

      await expect(sub.connect(relayer).renewFromCredit(user.address)).to.changeEtherBalance(
        treasury,
        PLUS_PRICE,
      );
      expect(await sub.credit(user.address)).to.equal(PLUS_PRICE * 2n);
    });

    it('refuses to renew early, outside the window', async () => {
      await expect(sub.connect(relayer).renewFromCredit(user.address)).to.be.revertedWithCustomError(
        sub,
        'NotDueForRenewal',
      );
    });

    it('refuses without the user’s consent', async () => {
      await sub.connect(user).setAutoRenew(false);
      await time.increase(PERIOD - 60n);
      await expect(sub.connect(relayer).renewFromCredit(user.address)).to.be.revertedWithCustomError(
        sub,
        'AutoRenewNotEnabled',
      );
    });

    it('is restricted to RELAYER_ROLE', async () => {
      await time.increase(PERIOD - 60n);
      await expect(sub.connect(other).renewFromCredit(user.address)).to.be.revertedWithCustomError(
        sub,
        'AccessControlUnauthorizedAccount',
      );
    });
  });

  // ── Admin ─────────────────────────────────────────────────────────────────

  describe('admin', () => {
    it('redirects collections to a new treasury', async () => {
      await sub.connect(admin).setTreasury(other.address);
      await expect(sub.connect(user).subscribe(PLUS, 1, { value: PLUS_PRICE })).to.changeEtherBalance(
        other,
        PLUS_PRICE,
      );
    });

    it('repricing does not shorten already-paid time', async () => {
      await sub.connect(user).subscribe(PLUS, 1, { value: PLUS_PRICE });
      const before = (await sub.subscriptionOf(user.address)).expiresAt;
      await sub.connect(admin).setTierPrice(PLUS, ethers.parseEther('20'));
      expect((await sub.subscriptionOf(user.address)).expiresAt).to.equal(before);
    });

    it('refuses a non-zero Free price and an over-cap paid price', async () => {
      await expect(sub.connect(admin).setTierPrice(FREE, 1n)).to.be.revertedWithCustomError(
        sub,
        'FreeTierMustBeFree',
      );
      await expect(
        sub.connect(admin).setTierPrice(PRO, ethers.parseEther('10001')),
      ).to.be.revertedWithCustomError(sub, 'PriceTooHigh');
    });

    it('blocks non-admins from pricing and treasury changes', async () => {
      await expect(sub.connect(user).setTierPrice(PRO, 1n)).to.be.revertedWithCustomError(
        sub,
        'AccessControlUnauthorizedAccount',
      );
      await expect(sub.connect(user).setTreasury(user.address)).to.be.revertedWithCustomError(
        sub,
        'AccessControlUnauthorizedAccount',
      );
    });

    it('pause stops new subscriptions', async () => {
      await sub.connect(admin).pause();
      await expect(sub.connect(user).subscribe(PLUS, 1, { value: PLUS_PRICE })).to.be.revertedWithCustomError(
        sub,
        'EnforcedPause',
      );
      await sub.connect(admin).unpause();
      await expect(sub.connect(user).subscribe(PLUS, 1, { value: PLUS_PRICE })).to.not.be.reverted;
    });

    it('sweep can never touch user credit', async () => {
      await sub.connect(user).depositCredit({ value: ethers.parseEther('50') });
      expect(await sub.sweepable()).to.equal(0n);
      await expect(sub.connect(admin).sweep(admin.address)).to.be.revertedWithCustomError(
        sub,
        'NothingToSweep',
      );
      expect(await ethers.provider.getBalance(subAddress)).to.equal(await sub.totalCredit());
    });
  });

  // ── Views ─────────────────────────────────────────────────────────────────

  describe('views', () => {
    it('quote reports what is still due after credit', async () => {
      await sub.connect(user).depositCredit({ value: ethers.parseEther('4') });
      const q = await sub.quote(user.address, PLUS, 1);
      expect(q.cost).to.equal(PLUS_PRICE);
      expect(q.creditBalance).to.equal(ethers.parseEther('4'));
      expect(q.dueNow).to.equal(ethers.parseEther('6'));
    });

    it('quote reports zero due once credit covers the cost', async () => {
      await sub.connect(user).depositCredit({ value: PRO_PRICE });
      expect((await sub.quote(user.address, PRO, 1)).dueNow).to.equal(0n);
    });

    it('hashSubscribeRequest matches the ethers EIP-712 digest', async () => {
      const req = {
        account: user.address,
        tier: PLUS,
        periods: 3,
        autoRenew: true,
        maxCost: PLUS_PRICE * 3n,
        nonce: 0n,
        deadline: BigInt(await time.latest()) + 3600n,
      };
      const expected = ethers.TypedDataEncoder.hash(await domain(), EIP712_TYPES, req);
      expect(await sub.hashSubscribeRequest(req)).to.equal(expected);
    });

    it('reports an unknown account as inactive', async () => {
      const info = await sub.subscriptionOf(other.address);
      expect(info.active).to.equal(false);
      expect(info.startedAt).to.equal(0n);
      expect(await sub.currentTier(other.address)).to.equal(BigInt(FREE));
    });
  });
});
