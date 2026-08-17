/**
 * Gas measurement for funding decisions.
 *
 * Not an assertion suite — it prints real gasUsed for every operation an
 * operator wallet performs, so wallet top-ups are sized from measurement
 * rather than from a guess. Run:
 *
 *   npx hardhat test test/A2AJobEscrow.gas.test.ts
 */

import { ethers } from 'hardhat';
import { Wallet, HDNodeWallet } from 'ethers';
import { time } from '@nomicfoundation/hardhat-network-helpers';

import { AGREEMENT_TYPES, buildDomain, type Agreement } from '../../../packages/a2a-protocol/src/eip712';

const USDC = (n: string) => ethers.parseUnits(n, 6);
const JOB_ID = '0x' + 'ab'.repeat(32);
const REQ_HASH = '0x' + 'cd'.repeat(32);
const EXECUTION_WINDOW = 6 * 60 * 60;

const RECEIVE_TYPES = {
  ReceiveWithAuthorization: [
    { name: 'from', type: 'address' }, { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
  ],
};

const measurements: Array<{ who: string; op: string; gas: bigint }> = [];

async function record(who: string, op: string, txPromise: Promise<{ wait: () => Promise<unknown> }>) {
  const tx = await txPromise;
  const receipt = (await tx.wait()) as unknown as { gasUsed: bigint };
  measurements.push({ who, op, gas: receipt.gasUsed });
  return receipt;
}

describe('A2AJobEscrow — gas', () => {
  it('measures every operator action', async () => {
    const [deployer, relayer, verifier, arbiter, treasury] = await ethers.getSigners();

    const usdc = await (await ethers.getContractFactory('MockUSDC')).deploy();
    await usdc.waitForDeployment();

    // ── Deployer ──────────────────────────────────────────────────────────
    const Factory = await ethers.getContractFactory('A2AJobEscrow');
    const escrow = await Factory.deploy(deployer.address, await usdc.getAddress(), treasury.address);
    const deployReceipt = await escrow.deploymentTransaction()!.wait();
    measurements.push({ who: 'DEPLOYER', op: 'deploy A2AJobEscrow', gas: deployReceipt!.gasUsed });

    await record('DEPLOYER', 'grantRole RELAYER', escrow.grantRole(await escrow.RELAYER_ROLE(), relayer.address));
    await record('DEPLOYER', 'grantRole VERIFIER', escrow.grantRole(await escrow.VERIFIER_ROLE(), verifier.address));
    await record('DEPLOYER', 'grantRole ARBITER', escrow.grantRole(await escrow.ARBITER_ROLE(), arbiter.address));

    // ── Per-job ───────────────────────────────────────────────────────────
    const creator = Wallet.createRandom().connect(ethers.provider);
    const provider = Wallet.createRandom().connect(ethers.provider);
    await usdc.mint(creator.address, USDC('100'));

    const { chainId } = await ethers.provider.getNetwork();
    const domain = buildDomain(await escrow.getAddress(), Number(chainId));
    const escrowAddress = await escrow.getAddress();

    await record('RELAYER', 'postJob', escrow.connect(relayer).postJob(
      JOB_ID, 1n, creator.address, REQ_HASH, USDC('0.25'), USDC('0.50'), EXECUTION_WINDOW,
    ));

    const agreement: Agreement = {
      jobId: JOB_ID, creatorAgentId: '1', providerAgentId: '2',
      providerWallet: provider.address, agreedPrice: USDC('0.40').toString(),
      requirementsHash: REQ_HASH, executionWindow: EXECUTION_WINDOW,
      transcriptHash: '0x' + 'ef'.repeat(32), expiry: (await time.latest()) + 86_400,
    };
    const creatorSig = await creator.signTypedData(domain, AGREEMENT_TYPES as never, agreement);
    const providerSig = await provider.signTypedData(domain, AGREEMENT_TYPES as never, agreement);

    const now = await time.latest();
    const auth = {
      from: creator.address, to: escrowAddress, value: USDC('0.40'),
      validAfter: 0, validBefore: now + 3600,
      nonce: ethers.hexlify(ethers.randomBytes(32)),
    };
    const authSig = await creator.signTypedData(
      { name: 'USD Coin', version: '2', chainId: Number(chainId), verifyingContract: await usdc.getAddress() },
      RECEIVE_TYPES, auth,
    );
    const { v, r, s } = ethers.Signature.from(authSig);

    await record('RELAYER', 'fundWithAuthorization', escrow.connect(relayer).fundWithAuthorization(
      JOB_ID,
      { ...agreement, creatorAgentId: 1n, providerAgentId: 2n, agreedPrice: USDC('0.40') },
      creator.address, creatorSig, provider.address, providerSig,
      { ...auth, v, r, s },
    ));

    await record('RELAYER', 'markExecuting', escrow.connect(relayer).markExecuting(JOB_ID));
    await record('RELAYER', 'submitDeliverable', escrow.connect(relayer).submitDeliverable(JOB_ID, '0x' + '11'.repeat(32)));
    await record('VERIFIER', 'submitVerdict (settle)', escrow.connect(verifier).submitVerdict(JOB_ID, true, '0x' + '22'.repeat(32)));

    // ── Refund path, on a second job ──────────────────────────────────────
    const JOB2 = '0x' + 'be'.repeat(32);
    await escrow.connect(relayer).postJob(JOB2, 1n, creator.address, REQ_HASH, USDC('0.25'), USDC('0.50'), EXECUTION_WINDOW);
    const a2 = { ...agreement, jobId: JOB2, expiry: (await time.latest()) + 86_400 };
    const cs2 = await creator.signTypedData(domain, AGREEMENT_TYPES as never, a2);
    const ps2 = await provider.signTypedData(domain, AGREEMENT_TYPES as never, a2);
    const now2 = await time.latest();
    const auth2 = {
      from: creator.address, to: escrowAddress, value: USDC('0.40'),
      validAfter: 0, validBefore: now2 + 3600, nonce: ethers.hexlify(ethers.randomBytes(32)),
    };
    const as2 = ethers.Signature.from(await creator.signTypedData(
      { name: 'USD Coin', version: '2', chainId: Number(chainId), verifyingContract: await usdc.getAddress() },
      RECEIVE_TYPES, auth2,
    ));
    await escrow.connect(relayer).fundWithAuthorization(
      JOB2, { ...a2, creatorAgentId: 1n, providerAgentId: 2n, agreedPrice: USDC('0.40') },
      creator.address, cs2, provider.address, ps2, { ...auth2, v: as2.v, r: as2.r, s: as2.s },
    );
    await time.increase(EXECUTION_WINDOW + 60);
    await record('ANYONE', 'claimTimeoutRefund', escrow.connect(relayer).claimTimeoutRefund(JOB2));

    // ── Report ────────────────────────────────────────────────────────────
    // Base mainnet L2 fees are a few hundredths of a gwei; the dominant cost is
    // the L1 data fee, which this local chain does not simulate. Two scenarios
    // bracket the realistic range.
    const scenarios = [
      { label: 'quiet Base (0.01 gwei)', gwei: 0.01 },
      { label: 'busy Base (0.20 gwei)', gwei: 0.2 },
    ];
    const ETH_USD = 3000;

    console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
    console.log('║  MEASURED GAS — A2AJobEscrow                                         ║');
    console.log('╚══════════════════════════════════════════════════════════════════════╝\n');
    console.log('  wallet     operation                    gas used');
    console.log('  ' + '─'.repeat(66));
    for (const m of measurements) {
      console.log(`  ${m.who.padEnd(10)} ${m.op.padEnd(28)} ${m.gas.toString().padStart(9)}`);
    }

    const perWallet = new Map<string, bigint>();
    for (const m of measurements) perWallet.set(m.who, (perWallet.get(m.who) ?? 0n) + m.gas);

    for (const sc of scenarios) {
      console.log(`\n  ── ${sc.label}, ETH at $${ETH_USD} ──`);
      for (const [who, gas] of perWallet) {
        const eth = Number(gas) * sc.gwei * 1e-9;
        console.log(`  ${who.padEnd(10)} ${eth.toFixed(8)} ETH   $${(eth * ETH_USD).toFixed(4)}`);
      }
    }

    // Per-job recurring cost: everything the relayer + verifier spend on one job.
    const perJob = measurements
      .filter((m) => ['postJob', 'fundWithAuthorization', 'markExecuting', 'submitDeliverable', 'submitVerdict (settle)'].includes(m.op))
      .reduce((sum, m) => sum + m.gas, 0n);

    console.log(`\n  ── per completed job (relayer + verifier) ──`);
    console.log(`  gas: ${perJob}`);
    for (const sc of scenarios) {
      const eth = Number(perJob) * sc.gwei * 1e-9;
      console.log(`  ${sc.label.padEnd(24)} ${eth.toFixed(8)} ETH   $${(eth * ETH_USD).toFixed(4)}`);
    }
    console.log('');
  });
});
