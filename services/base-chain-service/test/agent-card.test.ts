/**
 * The agent card's serialization must be byte-stable: its Merkle root is
 * committed on-chain at registration, and any drift means the served
 * document no longer matches its published hash.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildAgentCard, serializeAgentCard, AgentCardInput } from '../src/agent-card.js';

const INPUT: AgentCardInput = {
  kultAgentId: 'a1b2c3d4-0000-4000-8000-000000000001',
  name: 'NEXUS-01',
  description: 'A TACTICIAN agent of the BASE clan.',
  clan: 'BASE',
  archetype: 'TACTICIAN',
  eoaAddress: '0x1111111111111111111111111111111111111111',
  ownerWallet: '0x2222222222222222222222222222222222222222',
  inftTokenId: '42',
  capabilities: [
    { name: 'arena.eloRating', value: 1420, formulaVersion: 'raw-v1' },
    { name: 'arena.wins', value: 187, formulaVersion: 'raw-v1' },
  ],
  serviceBaseUrl: 'https://a2a.example.com',
};

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

test('serialization is deterministic across repeated builds', () => {
  assert.equal(sha(serializeAgentCard(buildAgentCard(INPUT))), sha(serializeAgentCard(buildAgentCard(INPUT))));
});

test('serialization is independent of input key order', () => {
  // Rebuild with the object literal's keys in a different order — the emitted
  // bytes must not change.
  const reordered: AgentCardInput = {
    serviceBaseUrl: INPUT.serviceBaseUrl,
    capabilities: INPUT.capabilities,
    inftTokenId: INPUT.inftTokenId,
    ownerWallet: INPUT.ownerWallet,
    eoaAddress: INPUT.eoaAddress,
    archetype: INPUT.archetype,
    clan: INPUT.clan,
    description: INPUT.description,
    name: INPUT.name,
    kultAgentId: INPUT.kultAgentId,
  };

  assert.equal(sha(serializeAgentCard(buildAgentCard(reordered))), sha(serializeAgentCard(buildAgentCard(INPUT))));
});

test('capability array order is preserved, not sorted', () => {
  // Arrays are ordered data; sorting them would silently reorder capabilities.
  const card = buildAgentCard(INPUT);
  assert.deepEqual(card.capabilities.map((c) => c.name), ['arena.eloRating', 'arena.wins']);

  const parsed = JSON.parse(serializeAgentCard(card).toString('utf8'));
  assert.deepEqual(parsed.capabilities.map((c: { name: string }) => c.name), ['arena.eloRating', 'arena.wins']);
});

test('declares the agent EOA as a CAIP-10 Base address', () => {
  const card = buildAgentCard(INPUT);
  assert.equal(card.registrations[0].agentAddress, `eip155:8453:${INPUT.eoaAddress}`);
});

test('cross-references the 0G INFT so either chain is discoverable from the other', () => {
  const card = buildAgentCard(INPUT);
  assert.deepEqual(card.extensions['kult.inft'], { chainId: 16661, tokenId: '42', standard: 'ERC-7857' });
});

test('handles an agent whose INFT has not minted yet', () => {
  const card = buildAgentCard({ ...INPUT, inftTokenId: null });
  assert.equal(card.extensions['kult.inft'], null);
  assert.doesNotThrow(() => serializeAgentCard(card));
});

test('changing any input changes the bytes', () => {
  const base = sha(serializeAgentCard(buildAgentCard(INPUT)));
  assert.notEqual(sha(serializeAgentCard(buildAgentCard({ ...INPUT, name: 'NEXUS-02' }))), base);
});
