/**
 * Cross-check: the contract and the off-chain library must agree, exactly.
 *
 * This is the highest-value test in Phase 5. Both sides independently
 * implement EIP-712 over the same struct — Solidity via OpenZeppelin's
 * _hashTypedDataV4, TypeScript via ethers' TypedDataEncoder. A single
 * mismatched field name, type or ordering makes every real funding attempt
 * revert with an opaque signature error, and it would only be discovered on
 * Base mainnet with real USDC.
 */

import { expect } from 'chai';
import { ethers } from 'hardhat';
import { TypedDataEncoder, Wallet, HDNodeWallet } from 'ethers';

import {
  AGREEMENT_TYPES,
  AGREEMENT_TYPE_STRING,
  agreementDigest,
  buildDomain,
  type Agreement,
} from '../../../packages/a2a-protocol/src/eip712';

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

async function deploy() {
  const [admin, treasury] = await ethers.getSigners();
  const Factory = await ethers.getContractFactory('A2AJobEscrow');
  const escrow = await Factory.deploy(admin.address, USDC_BASE, treasury.address);
  await escrow.waitForDeployment();
  return { escrow, admin, treasury };
}

function sampleAgreement(providerWallet: string): Agreement {
  return {
    jobId: '0x' + 'ab'.repeat(32),
    creatorAgentId: '1',
    providerAgentId: '2',
    providerWallet,
    agreedPrice: '400000', // 0.40 USDC
    requirementsHash: '0x' + 'cd'.repeat(32),
    executionWindow: 21600,
    transcriptHash: '0x' + 'ef'.repeat(32),
    expiry: 1_800_003_600,
  };
}

/** Solidity struct field order — must match AGREEMENT_TYPES exactly. */
function toSolidityStruct(agreement: Agreement) {
  return {
    jobId: agreement.jobId,
    creatorAgentId: agreement.creatorAgentId,
    providerAgentId: agreement.providerAgentId,
    providerWallet: agreement.providerWallet,
    agreedPrice: agreement.agreedPrice,
    requirementsHash: agreement.requirementsHash,
    executionWindow: agreement.executionWindow,
    transcriptHash: agreement.transcriptHash,
    expiry: agreement.expiry,
  };
}

describe('A2AJobEscrow — EIP-712 agreement', () => {
  it('derives the same AGREEMENT_TYPEHASH as the off-chain type string', async () => {
    const { escrow } = await deploy();
    expect(await escrow.AGREEMENT_TYPEHASH()).to.equal(ethers.keccak256(ethers.toUtf8Bytes(AGREEMENT_TYPE_STRING)));
  });

  it('derives the same domain separator as ethers', async () => {
    const { escrow } = await deploy();
    const address = await escrow.getAddress();
    const { chainId } = await ethers.provider.getNetwork();

    expect(await escrow.domainSeparator()).to.equal(
      TypedDataEncoder.hashDomain(buildDomain(address, Number(chainId))),
    );
  });

  it('computes the same agreement digest as the off-chain library', async () => {
    const { escrow } = await deploy();
    const address = await escrow.getAddress();
    const { chainId } = await ethers.provider.getNetwork();
    const [, , provider] = await ethers.getSigners();

    const agreement = sampleAgreement(provider.address);

    expect(await escrow.hashAgreement(toSolidityStruct(agreement))).to.equal(
      agreementDigest(buildDomain(address, Number(chainId)), agreement),
    );
  });

  it('accepts two real EOA signatures over the same terms', async () => {
    const { escrow } = await deploy();
    const address = await escrow.getAddress();
    const { chainId } = await ethers.provider.getNetwork();
    const domain = buildDomain(address, Number(chainId));

    const creator = Wallet.createRandom();
    const provider = Wallet.createRandom();
    const agreement = sampleAgreement(provider.address);

    const creatorSig = await creator.signTypedData(domain, AGREEMENT_TYPES as never, agreement);
    const providerSig = await provider.signTypedData(domain, AGREEMENT_TYPES as never, agreement);

    expect(
      await escrow.verifyAgreement(
        toSolidityStruct(agreement), creator.address, creatorSig, provider.address, providerSig,
      ),
    ).to.equal(true);
  });

  it('rejects a signature over a different price — the frontend cannot alter terms', async () => {
    const { escrow } = await deploy();
    const address = await escrow.getAddress();
    const { chainId } = await ethers.provider.getNetwork();
    const domain = buildDomain(address, Number(chainId));

    const creator = Wallet.createRandom();
    const provider = Wallet.createRandom();
    const agreement = sampleAgreement(provider.address);

    const creatorSig = await creator.signTypedData(domain, AGREEMENT_TYPES as never, agreement);
    const providerSig = await provider.signTypedData(domain, AGREEMENT_TYPES as never, agreement);

    // Both parties signed 0.40; submit 0.50.
    const inflated = { ...agreement, agreedPrice: '500000' };

    expect(
      await escrow.verifyAgreement(
        toSolidityStruct(inflated), creator.address, creatorSig, provider.address, providerSig,
      ),
    ).to.equal(false);
  });

  it('rejects a redirected payout wallet', async () => {
    const { escrow } = await deploy();
    const address = await escrow.getAddress();
    const { chainId } = await ethers.provider.getNetwork();
    const domain = buildDomain(address, Number(chainId));

    const creator = Wallet.createRandom();
    const provider = Wallet.createRandom();
    const attacker = Wallet.createRandom();
    const agreement = sampleAgreement(provider.address);

    const creatorSig = await creator.signTypedData(domain, AGREEMENT_TYPES as never, agreement);
    const providerSig = await provider.signTypedData(domain, AGREEMENT_TYPES as never, agreement);

    const redirected = { ...agreement, providerWallet: attacker.address };

    expect(
      await escrow.verifyAgreement(
        toSolidityStruct(redirected), creator.address, creatorSig, provider.address, providerSig,
      ),
    ).to.equal(false);
  });

  it('rejects a swapped negotiation transcript', async () => {
    const { escrow } = await deploy();
    const address = await escrow.getAddress();
    const { chainId } = await ethers.provider.getNetwork();
    const domain = buildDomain(address, Number(chainId));

    const creator = Wallet.createRandom();
    const provider = Wallet.createRandom();
    const agreement = sampleAgreement(provider.address);

    const creatorSig = await creator.signTypedData(domain, AGREEMENT_TYPES as never, agreement);
    const providerSig = await provider.signTypedData(domain, AGREEMENT_TYPES as never, agreement);

    const swapped = { ...agreement, transcriptHash: '0x' + '99'.repeat(32) };

    expect(
      await escrow.verifyAgreement(
        toSolidityStruct(swapped), creator.address, creatorSig, provider.address, providerSig,
      ),
    ).to.equal(false);
  });

  it('rejects when only one party signed', async () => {
    const { escrow } = await deploy();
    const address = await escrow.getAddress();
    const { chainId } = await ethers.provider.getNetwork();
    const domain = buildDomain(address, Number(chainId));

    const creator = Wallet.createRandom();
    const provider = Wallet.createRandom();
    const agreement = sampleAgreement(provider.address);

    const creatorSig = await creator.signTypedData(domain, AGREEMENT_TYPES as never, agreement);

    // Provider's slot filled with the creator's signature.
    expect(
      await escrow.verifyAgreement(
        toSolidityStruct(agreement), creator.address, creatorSig, provider.address, creatorSig,
      ),
    ).to.equal(false);
  });

  it('a signature for another deployment does not verify here (replay, T6)', async () => {
    const { escrow } = await deploy();
    const address = await escrow.getAddress();
    const { chainId } = await ethers.provider.getNetwork();

    const creator = Wallet.createRandom();
    const provider = Wallet.createRandom();
    const agreement = sampleAgreement(provider.address);

    const otherDomain = buildDomain('0x3333333333333333333333333333333333333333', Number(chainId));
    const creatorSig = await creator.signTypedData(otherDomain, AGREEMENT_TYPES as never, agreement);
    const providerSig = await provider.signTypedData(otherDomain, AGREEMENT_TYPES as never, agreement);

    expect(
      await escrow.verifyAgreement(
        toSolidityStruct(agreement), creator.address, creatorSig, provider.address, providerSig,
      ),
    ).to.equal(false);
  });
});
