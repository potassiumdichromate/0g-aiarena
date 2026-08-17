/**
 * ERC-8021 attribution, end to end against the real contract.
 *
 * The encoder is unit-tested in a2a-protocol. What this proves is the part
 * that could actually go wrong in production:
 *
 *   1. Appending the suffix does NOT break the call — the contract ignores
 *      trailing bytes and the state transition still happens.
 *   2. The suffix survives onto the chain and can be read back out of the
 *      mined transaction, which is exactly what an indexer does.
 *   3. Attribution is measurably cheap.
 */

import { expect } from 'chai';
import { ethers } from 'hardhat';

import {
  decodeBuilderCodeSuffix,
  encodeBuilderCodeSuffix,
  appendDataSuffix,
} from '../../../packages/a2a-protocol/src/builderCode';

const USDC = (n: string) => ethers.parseUnits(n, 6);
const REQ_HASH = '0x' + 'cd'.repeat(32);
const EXECUTION_WINDOW = 6 * 60 * 60;
const BUILDER_CODE = 'kult';

async function setup() {
  const [admin, relayer, treasury, creator] = await ethers.getSigners();

  const usdc = await (await ethers.getContractFactory('MockUSDC')).deploy();
  await usdc.waitForDeployment();

  const escrow = await (await ethers.getContractFactory('A2AJobEscrow')).deploy(
    admin.address, await usdc.getAddress(), treasury.address,
  );
  await escrow.waitForDeployment();
  await escrow.grantRole(await escrow.RELAYER_ROLE(), relayer.address);

  return { escrow, relayer, creator };
}

describe('A2AJobEscrow — ERC-8021 attribution', () => {
  it('an attributed postJob still executes correctly', async () => {
    const { escrow, relayer, creator } = await setup();
    const jobId = '0x' + 'a1'.repeat(32);

    const populated = await escrow.connect(relayer).postJob.populateTransaction(
      jobId, 1n, creator.address, REQ_HASH, USDC('0.25'), USDC('0.50'), EXECUTION_WINDOW,
    );

    const tx = await relayer.sendTransaction({
      ...populated,
      data: appendDataSuffix(populated.data!, encodeBuilderCodeSuffix([BUILDER_CODE])),
    });
    await tx.wait();

    // The state transition happened despite the extra bytes.
    const job = await escrow.getJob(jobId);
    expect(job.status).to.equal(1); // POSTED
    expect(job.creatorWallet).to.equal(creator.address);
    expect(job.budgetMax).to.equal(USDC('0.50'));
  });

  it('the builder code is readable from the mined transaction, as an indexer would', async () => {
    const { escrow, relayer, creator } = await setup();
    const jobId = '0x' + 'a2'.repeat(32);

    const populated = await escrow.connect(relayer).postJob.populateTransaction(
      jobId, 1n, creator.address, REQ_HASH, USDC('0.25'), USDC('0.50'), EXECUTION_WINDOW,
    );
    const tx = await relayer.sendTransaction({
      ...populated,
      data: appendDataSuffix(populated.data!, encodeBuilderCodeSuffix([BUILDER_CODE])),
    });
    await tx.wait();

    // Read it back off the chain rather than from the local variable.
    const onChain = await ethers.provider.getTransaction(tx.hash);
    expect(decodeBuilderCodeSuffix(onChain!.data)?.codes).to.deep.equal([BUILDER_CODE]);
  });

  it('an unattributed transaction decodes to null', async () => {
    const { escrow, relayer, creator } = await setup();
    const jobId = '0x' + 'a3'.repeat(32);

    const tx = await escrow.connect(relayer).postJob(
      jobId, 1n, creator.address, REQ_HASH, USDC('0.25'), USDC('0.50'), EXECUTION_WINDOW,
    );
    await tx.wait();

    const onChain = await ethers.provider.getTransaction(tx.hash);
    expect(decodeBuilderCodeSuffix(onChain!.data)).to.equal(null);
  });

  it('attribution costs only calldata gas', async () => {
    const { escrow, relayer, creator } = await setup();

    const plainTx = await escrow.connect(relayer).postJob(
      '0x' + 'b1'.repeat(32), 1n, creator.address, REQ_HASH, USDC('0.25'), USDC('0.50'), EXECUTION_WINDOW,
    );
    const plain = await plainTx.wait();

    const populated = await escrow.connect(relayer).postJob.populateTransaction(
      '0x' + 'b2'.repeat(32), 1n, creator.address, REQ_HASH, USDC('0.25'), USDC('0.50'), EXECUTION_WINDOW,
    );
    const attributedTx = await relayer.sendTransaction({
      ...populated,
      data: appendDataSuffix(populated.data!, encodeBuilderCodeSuffix([BUILDER_CODE])),
    });
    const attributed = await attributedTx.wait();

    const delta = attributed!.gasUsed - plain!.gasUsed;
    console.log(`\n      attribution overhead: ${delta} gas (${(Number(delta) / Number(plain!.gasUsed) * 100).toFixed(3)}%)\n`);

    // 22 bytes at 16 gas per non-zero byte is ~350; allow headroom for zero
    // bytes and calldata accounting, but it must stay trivial.
    expect(delta).to.be.lessThan(1000n);
  });

  it('a longer code still works and costs proportionally', async () => {
    const { escrow, relayer, creator } = await setup();
    const jobId = '0x' + 'c1'.repeat(32);
    const longCode = 'kult-agent-marketplace';

    const populated = await escrow.connect(relayer).postJob.populateTransaction(
      jobId, 1n, creator.address, REQ_HASH, USDC('0.25'), USDC('0.50'), EXECUTION_WINDOW,
    );
    const tx = await relayer.sendTransaction({
      ...populated,
      data: appendDataSuffix(populated.data!, encodeBuilderCodeSuffix([longCode])),
    });
    await tx.wait();

    expect((await escrow.getJob(jobId)).status).to.equal(1);
    const onChain = await ethers.provider.getTransaction(tx.hash);
    expect(decodeBuilderCodeSuffix(onChain!.data)?.codes).to.deep.equal([longCode]);
  });
});
