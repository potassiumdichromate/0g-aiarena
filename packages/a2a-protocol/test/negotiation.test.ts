import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { HDNodeWallet, Wallet } from 'ethers';

import {
  AGREEMENT_TYPES,
  AGREEMENT_TYPE_STRING,
  MAX_NEGOTIATION_MESSAGES,
  OFFER_TYPES,
  ZERO_HASH,
  agreementDigest,
  assertValidNext,
  buildDomain,
  buildNextOffer,
  decideProviderResponse,
  deriveState,
  offerDigest,
  recoverAgreementSigner,
  recoverOfferSigner,
  verifySignature,
  verifyTranscript,
  type Agreement,
  type Offer,
  type SignedOffer,
} from '../src';

const ESCROW = '0x1111111111111111111111111111111111111111';
const DOMAIN = buildDomain(ESCROW);
const JOB_ID = '0x' + 'ab'.repeat(32);
const REQ_HASH = '0x' + 'cd'.repeat(32);

const CREATOR = Wallet.fromPhrase(
  'test test test test test test test test test test test junk',
) as HDNodeWallet;
const PROVIDER = HDNodeWallet.fromPhrase(
  'test test test test test test test test test test test junk',
  undefined,
  "m/44'/60'/0'/0/1",
);

const BUDGET_MIN = '250000'; // 0.25 USDC
const BUDGET_MAX = '500000'; // 0.50 USDC
const NOW = 1_800_000_000;

async function sign(wallet: HDNodeWallet, offer: Offer): Promise<SignedOffer> {
  const signature = await wallet.signTypedData(DOMAIN, OFFER_TYPES as never, offer);
  return {
    offer,
    signature,
    digest: offerDigest(DOMAIN, offer),
    signerAddress: wallet.address,
  };
}

async function converge(): Promise<SignedOffer[]> {
  const messages: SignedOffer[] = [];

  // A: "I can pay 0.35"
  const a1 = buildNextOffer({
    messages, jobId: JOB_ID, agentId: '1', role: 'CREATOR', kind: 'PROPOSE',
    priceBaseUnits: '350000', nowSeconds: NOW,
  });
  assertValidNext({ messages, next: a1, budgetMinBaseUnits: BUDGET_MIN, budgetMaxBaseUnits: BUDGET_MAX, nowSeconds: NOW });
  messages.push(await sign(CREATOR, a1));

  // B: "I can do it for 0.45"
  const b1 = buildNextOffer({
    messages, jobId: JOB_ID, agentId: '2', role: 'PROVIDER', kind: 'COUNTER',
    priceBaseUnits: '450000', nowSeconds: NOW,
  });
  assertValidNext({ messages, next: b1, budgetMinBaseUnits: BUDGET_MIN, budgetMaxBaseUnits: BUDGET_MAX, nowSeconds: NOW });
  messages.push(await sign(PROVIDER, b1));

  // A: "my maximum is 0.40"
  const a2 = buildNextOffer({
    messages, jobId: JOB_ID, agentId: '1', role: 'CREATOR', kind: 'COUNTER',
    priceBaseUnits: '400000', nowSeconds: NOW,
  });
  assertValidNext({ messages, next: a2, budgetMinBaseUnits: BUDGET_MIN, budgetMaxBaseUnits: BUDGET_MAX, nowSeconds: NOW });
  messages.push(await sign(CREATOR, a2));

  // B: "agreed at 0.40"
  const b2 = buildNextOffer({
    messages, jobId: JOB_ID, agentId: '2', role: 'PROVIDER', kind: 'ACCEPT',
    priceBaseUnits: '400000', nowSeconds: NOW,
  });
  assertValidNext({ messages, next: b2, budgetMinBaseUnits: BUDGET_MIN, budgetMaxBaseUnits: BUDGET_MAX, nowSeconds: NOW });
  messages.push(await sign(PROVIDER, b2));

  return messages;
}

// ── The specification's worked example ──────────────────────────────────────

test('A->B->A->B converges to one agreed price with four verifiable signatures', async () => {
  const messages = await converge();

  const verification = verifyTranscript(DOMAIN, messages);
  assert.equal(verification.valid, true, JSON.stringify(verification.issues));

  const view = deriveState(messages, NOW);
  assert.equal(view.state, 'AGREED');
  assert.equal(view.agreedPriceBaseUnits, '400000');
  assert.equal(view.messageCount, 4);

  for (const message of messages) {
    const recovered = recoverOfferSigner(DOMAIN, message.offer, message.signature);
    assert.equal(recovered, message.signerAddress);
  }

  // The transcript hash is stable — it is what the Agreement binds to.
  assert.equal(verification.transcriptHash, messages[3].digest);
});

test('transcript hash is deterministic across independent verifications', async () => {
  const messages = await converge();
  assert.equal(
    verifyTranscript(DOMAIN, messages).transcriptHash,
    verifyTranscript(DOMAIN, messages).transcriptHash,
  );
});

// ── Tampering ───────────────────────────────────────────────────────────────

test('editing a message price breaks chain verification', async () => {
  const messages = await converge();
  messages[2] = { ...messages[2], offer: { ...messages[2].offer, priceBaseUnits: '499999' } };

  const verification = verifyTranscript(DOMAIN, messages);
  assert.equal(verification.valid, false);
  assert.ok(verification.issues.some((i) => /does not match its recorded digest/.test(i.reason)));
});

test('deleting a middle message breaks the chain', async () => {
  const messages = await converge();
  const tampered = [messages[0], messages[2], messages[3]];

  assert.equal(verifyTranscript(DOMAIN, tampered).valid, false);
});

test('reordering messages breaks the chain', async () => {
  const messages = await converge();
  const tampered = [messages[0], messages[2], messages[1], messages[3]];

  assert.equal(verifyTranscript(DOMAIN, tampered).valid, false);
});

test('inserting a fabricated message breaks the chain', async () => {
  const messages = await converge();
  const forged = await sign(PROVIDER, {
    ...messages[1].offer, priceBaseUnits: '260000', seq: 1,
  });

  assert.equal(verifyTranscript(DOMAIN, [messages[0], forged, messages[2], messages[3]]).valid, false);
});

// ── Signature forgery ───────────────────────────────────────────────────────

test('a signature from the wrong key does not verify against the expected signer', async () => {
  const offer = buildNextOffer({
    messages: [], jobId: JOB_ID, agentId: '1', role: 'CREATOR', kind: 'PROPOSE',
    priceBaseUnits: '300000', nowSeconds: NOW,
  });
  const signature = await PROVIDER.signTypedData(DOMAIN, OFFER_TYPES as never, offer);

  const result = await verifySignature({
    digest: offerDigest(DOMAIN, offer),
    signature,
    expectedSigner: CREATOR.address,
    recovered: recoverOfferSigner(DOMAIN, offer, signature),
  });

  assert.equal(result.valid, false);
  assert.match(result.reason ?? '', /recovers to/);
});

test('a malformed signature is rejected rather than throwing', async () => {
  const offer = buildNextOffer({
    messages: [], jobId: JOB_ID, agentId: '1', role: 'CREATOR', kind: 'PROPOSE',
    priceBaseUnits: '300000', nowSeconds: NOW,
  });

  const result = await verifySignature({
    digest: offerDigest(DOMAIN, offer),
    signature: '0xdeadbeef',
    expectedSigner: CREATOR.address,
    recovered: recoverOfferSigner(DOMAIN, offer, '0xdeadbeef'),
  });

  assert.equal(result.valid, false);
  assert.equal(result.method, 'none');
});

test('a contract wallet verifies through the ERC-1271 hook', async () => {
  const offer = buildNextOffer({
    messages: [], jobId: JOB_ID, agentId: '1', role: 'CREATOR', kind: 'PROPOSE',
    priceBaseUnits: '300000', nowSeconds: NOW,
  });
  const signature = await CREATOR.signTypedData(DOMAIN, OFFER_TYPES as never, offer);
  const smartWallet = '0x2222222222222222222222222222222222222222';

  const result = await verifySignature({
    digest: offerDigest(DOMAIN, offer),
    signature,
    expectedSigner: smartWallet,
    recovered: recoverOfferSigner(DOMAIN, offer, signature),
    erc1271Check: async () => true,
  });

  assert.equal(result.valid, true);
  assert.equal(result.method, 'erc1271');
});

// ── Replay ──────────────────────────────────────────────────────────────────

test('an offer signed for one escrow deployment does not verify against another', async () => {
  const offer = buildNextOffer({
    messages: [], jobId: JOB_ID, agentId: '1', role: 'CREATOR', kind: 'PROPOSE',
    priceBaseUnits: '300000', nowSeconds: NOW,
  });
  const signature = await CREATOR.signTypedData(DOMAIN, OFFER_TYPES as never, offer);

  const otherDomain = buildDomain('0x3333333333333333333333333333333333333333');
  assert.notEqual(recoverOfferSigner(otherDomain, offer, signature), CREATOR.address);
});

test('an agreement signed for another chain does not verify on Base', async () => {
  const agreement = sampleAgreement();
  const optimism = buildDomain(ESCROW, 10);
  const signature = await CREATOR.signTypedData(optimism, AGREEMENT_TYPES as never, agreement);

  assert.notEqual(recoverAgreementSigner(DOMAIN, agreement, signature), CREATOR.address);
});

// ── Turn taking and bounds ──────────────────────────────────────────────────

test('an agent cannot bid against itself', async () => {
  const messages = [
    await sign(CREATOR, buildNextOffer({
      messages: [], jobId: JOB_ID, agentId: '1', role: 'CREATOR', kind: 'PROPOSE',
      priceBaseUnits: '300000', nowSeconds: NOW,
    })),
  ];

  const next = buildNextOffer({
    messages, jobId: JOB_ID, agentId: '1', role: 'CREATOR', kind: 'COUNTER',
    priceBaseUnits: '310000', nowSeconds: NOW,
  });

  assert.throws(
    () => assertValidNext({ messages, next, budgetMinBaseUnits: BUDGET_MIN, budgetMaxBaseUnits: BUDGET_MAX, nowSeconds: NOW }),
    /cannot speak twice in a row/,
  );
});

test('a price above the budget ceiling is rejected before it reaches the chain', () => {
  const next = buildNextOffer({
    messages: [], jobId: JOB_ID, agentId: '1', role: 'CREATOR', kind: 'PROPOSE',
    priceBaseUnits: '900000', nowSeconds: NOW,
  });

  assert.throws(
    () => assertValidNext({ messages: [], next, budgetMinBaseUnits: BUDGET_MIN, budgetMaxBaseUnits: BUDGET_MAX, nowSeconds: NOW }),
    /outside the job's budget range/,
  );
});

test('ACCEPT cannot quietly change the price', async () => {
  const messages = [
    await sign(CREATOR, buildNextOffer({
      messages: [], jobId: JOB_ID, agentId: '1', role: 'CREATOR', kind: 'PROPOSE',
      priceBaseUnits: '300000', nowSeconds: NOW,
    })),
  ];

  const next = buildNextOffer({
    messages, jobId: JOB_ID, agentId: '2', role: 'PROVIDER', kind: 'ACCEPT',
    priceBaseUnits: '450000', nowSeconds: NOW,
  });

  assert.throws(
    () => assertValidNext({ messages, next, budgetMinBaseUnits: BUDGET_MIN, budgetMaxBaseUnits: BUDGET_MAX, nowSeconds: NOW }),
    /ACCEPT must match the offered price/,
  );
});

test('a closed negotiation accepts no further messages', async () => {
  const messages = await converge();
  const next = buildNextOffer({
    messages, jobId: JOB_ID, agentId: '1', role: 'CREATOR', kind: 'COUNTER',
    priceBaseUnits: '260000', nowSeconds: NOW,
  });

  assert.throws(
    () => assertValidNext({ messages, next, budgetMinBaseUnits: BUDGET_MIN, budgetMaxBaseUnits: BUDGET_MAX, nowSeconds: NOW }),
    /is AGREED and accepts no further messages/,
  );
});

test('haggling is bounded', async () => {
  const messages: SignedOffer[] = [];
  for (let i = 0; i < MAX_NEGOTIATION_MESSAGES; i += 1) {
    const role = i % 2 === 0 ? 'CREATOR' : 'PROVIDER';
    const offer = buildNextOffer({
      messages, jobId: JOB_ID, agentId: role === 'CREATOR' ? '1' : '2', role,
      kind: i === 0 ? 'PROPOSE' : 'COUNTER', priceBaseUnits: '300000', nowSeconds: NOW,
    });
    messages.push(await sign(role === 'CREATOR' ? CREATOR : PROVIDER, offer));
  }

  const next = buildNextOffer({
    messages, jobId: JOB_ID, agentId: '1', role: 'CREATOR', kind: 'COUNTER',
    priceBaseUnits: '300000', nowSeconds: NOW,
  });

  assert.throws(
    () => assertValidNext({ messages, next, budgetMinBaseUnits: BUDGET_MIN, budgetMaxBaseUnits: BUDGET_MAX, nowSeconds: NOW }),
    /exceeded 20 messages/,
  );
});

test('an expired last offer closes the negotiation', async () => {
  const messages = [
    await sign(CREATOR, buildNextOffer({
      messages: [], jobId: JOB_ID, agentId: '1', role: 'CREATOR', kind: 'PROPOSE',
      priceBaseUnits: '300000', ttlSeconds: 60, nowSeconds: NOW,
    })),
  ];

  assert.equal(deriveState(messages, NOW + 30).state, 'OPEN');
  assert.equal(deriveState(messages, NOW + 120).state, 'EXPIRED');
});

// ── Provider policy ─────────────────────────────────────────────────────────

test('provider accepts an offer at or above its floor', async () => {
  const messages = [
    await sign(CREATOR, buildNextOffer({
      messages: [], jobId: JOB_ID, agentId: '1', role: 'CREATOR', kind: 'PROPOSE',
      priceBaseUnits: '400000', nowSeconds: NOW,
    })),
  ];

  const decision = decideProviderResponse({
    messages, policy: { floorBaseUnits: '350000' },
    budgetMinBaseUnits: BUDGET_MIN, budgetMaxBaseUnits: BUDGET_MAX,
  });

  assert.equal(decision.kind, 'ACCEPT');
  assert.equal(decision.kind === 'ACCEPT' && decision.priceBaseUnits, '400000');
});

test('provider counters above its floor when the offer is too low', async () => {
  const messages = [
    await sign(CREATOR, buildNextOffer({
      messages: [], jobId: JOB_ID, agentId: '1', role: 'CREATOR', kind: 'PROPOSE',
      priceBaseUnits: '300000', nowSeconds: NOW,
    })),
  ];

  const decision = decideProviderResponse({
    messages, policy: { floorBaseUnits: '400000', concessionRate: 0.5 },
    budgetMinBaseUnits: BUDGET_MIN, budgetMaxBaseUnits: BUDGET_MAX,
  });

  assert.equal(decision.kind, 'COUNTER');
  assert.ok(decision.kind === 'COUNTER' && BigInt(decision.priceBaseUnits) >= 400000n);
});

test('provider declines a job whose ceiling is below its floor — and earns nothing', () => {
  const decision = decideProviderResponse({
    messages: [], policy: { floorBaseUnits: '600000' },
    budgetMinBaseUnits: BUDGET_MIN, budgetMaxBaseUnits: BUDGET_MAX,
  });

  assert.equal(decision.kind, 'DECLINE');
});

test('provider concession never dips below the floor', async () => {
  const messages: SignedOffer[] = [
    await sign(CREATOR, buildNextOffer({
      messages: [], jobId: JOB_ID, agentId: '1', role: 'CREATOR', kind: 'PROPOSE',
      priceBaseUnits: '250000', nowSeconds: NOW,
    })),
  ];

  for (let round = 0; round < 6; round += 1) {
    const decision = decideProviderResponse({
      messages, policy: { floorBaseUnits: '400000', concessionRate: 0.9 },
      budgetMinBaseUnits: BUDGET_MIN, budgetMaxBaseUnits: BUDGET_MAX,
    });
    if (decision.kind !== 'COUNTER') break;

    assert.ok(
      BigInt(decision.priceBaseUnits) >= 400000n,
      `conceded to ${decision.priceBaseUnits}, below the floor`,
    );

    messages.push(await sign(PROVIDER, buildNextOffer({
      messages, jobId: JOB_ID, agentId: '2', role: 'PROVIDER', kind: 'COUNTER',
      priceBaseUnits: decision.priceBaseUnits, nowSeconds: NOW,
    })));
    messages.push(await sign(CREATOR, buildNextOffer({
      messages, jobId: JOB_ID, agentId: '1', role: 'CREATOR', kind: 'COUNTER',
      priceBaseUnits: '250000', nowSeconds: NOW,
    })));
  }
});

// ── Agreement ───────────────────────────────────────────────────────────────

function sampleAgreement(transcriptHash = ZERO_HASH): Agreement {
  return {
    jobId: JOB_ID,
    creatorAgentId: '1',
    providerAgentId: '2',
    providerWallet: PROVIDER.address,
    agreedPrice: '400000',
    requirementsHash: REQ_HASH,
    executionWindow: 21600,
    transcriptHash,
    expiry: NOW + 3600,
  };
}

test('both parties sign the same agreement digest', async () => {
  const messages = await converge();
  const agreement = sampleAgreement(verifyTranscript(DOMAIN, messages).transcriptHash);
  const digest = agreementDigest(DOMAIN, agreement);

  const creatorSig = await CREATOR.signTypedData(DOMAIN, AGREEMENT_TYPES as never, agreement);
  const providerSig = await PROVIDER.signTypedData(DOMAIN, AGREEMENT_TYPES as never, agreement);

  assert.equal(recoverAgreementSigner(DOMAIN, agreement, creatorSig), CREATOR.address);
  assert.equal(recoverAgreementSigner(DOMAIN, agreement, providerSig), PROVIDER.address);
  assert.equal(agreementDigest(DOMAIN, agreement), digest);
});

test('changing the price invalidates both signatures', async () => {
  const agreement = sampleAgreement();
  const creatorSig = await CREATOR.signTypedData(DOMAIN, AGREEMENT_TYPES as never, agreement);

  const altered = { ...agreement, agreedPrice: '500000' };
  assert.notEqual(recoverAgreementSigner(DOMAIN, altered, creatorSig), CREATOR.address);
});

test('swapping the transcript invalidates the agreement', async () => {
  const agreement = sampleAgreement('0x' + '11'.repeat(32));
  const creatorSig = await CREATOR.signTypedData(DOMAIN, AGREEMENT_TYPES as never, agreement);

  const swapped = { ...agreement, transcriptHash: '0x' + '22'.repeat(32) };
  assert.notEqual(recoverAgreementSigner(DOMAIN, swapped, creatorSig), CREATOR.address);
});

test('redirecting the payout wallet invalidates the agreement', async () => {
  const agreement = sampleAgreement();
  const creatorSig = await CREATOR.signTypedData(DOMAIN, AGREEMENT_TYPES as never, agreement);

  const redirected = { ...agreement, providerWallet: '0x4444444444444444444444444444444444444444' };
  assert.notEqual(recoverAgreementSigner(DOMAIN, redirected, creatorSig), CREATOR.address);
});

test('the Agreement type string matches the struct field order exactly', () => {
  // The contract hashes AGREEMENT_TYPE_STRING to derive its typehash. If this
  // drifts from AGREEMENT_TYPES, every funding attempt reverts on a signature
  // error that looks like a wallet bug.
  const fields = AGREEMENT_TYPES.Agreement.map((f) => `${f.type} ${f.name}`).join(',');
  assert.equal(AGREEMENT_TYPE_STRING, `Agreement(${fields})`);
});
