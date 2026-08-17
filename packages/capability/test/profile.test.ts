/**
 * Profile computation tests.
 *
 * Uses a hand-rolled Prisma stub rather than a live database: these assertions
 * are about which evidence is trusted and which is excluded, and that logic
 * should be provable without infrastructure.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { agentWonBattle, computeProfile } from '../src/profile.js';

const NOW = new Date('2026-08-16T00:00:00.000Z');

interface StubOptions {
  agent?: Record<string, unknown> | null;
  snapshot?: Record<string, unknown> | null;
  realBattles?: Array<{ id: string; result: unknown }>;
  simulatedCount?: number;
}

function stubPrisma(options: StubOptions) {
  const calls: { battleWhere: unknown[] } = { battleWhere: [] };

  const prisma = {
    agent: {
      findUnique: async () =>
        options.agent === undefined
          ? { id: 'agent-1', eloRating: 1400, traits: {}, updatedAt: NOW }
          : options.agent,
    },
    agentCapabilitySnapshot: {
      findFirst: async () => options.snapshot ?? null,
    },
    battle: {
      findMany: async ({ where }: { where: unknown }) => {
        calls.battleWhere.push(where);
        return options.realBattles ?? [];
      },
      count: async ({ where }: { where: unknown }) => {
        calls.battleWhere.push(where);
        return options.simulatedCount ?? 0;
      },
    },
  };

  return { prisma: prisma as never, calls };
}

// ── Win detection ───────────────────────────────────────────────────────────

test('agentWonBattle handles the result shapes actually produced', () => {
  assert.equal(agentWonBattle({ winnerId: 'a' }, 'a'), true);
  assert.equal(agentWonBattle({ winner: 'a' }, 'a'), true);
  assert.equal(agentWonBattle({ winners: ['a', 'b'] }, 'a'), true);
  assert.equal(agentWonBattle({ outcomes: { a: { outcome: 'WIN' } } }, 'a'), true);
  assert.equal(agentWonBattle({ agents: { a: { outcome: 'win' } } }, 'a'), true);

  assert.equal(agentWonBattle({ winnerId: 'b' }, 'a'), false);
  assert.equal(agentWonBattle({ outcomes: { a: { outcome: 'LOSS' } } }, 'a'), false);
});

test('an unrecognisable result counts as not-a-win', () => {
  // Undercounting is the safe direction for a metric gating paid work.
  assert.equal(agentWonBattle(null, 'a'), false);
  assert.equal(agentWonBattle({}, 'a'), false);
  assert.equal(agentWonBattle('weird', 'a'), false);
  assert.equal(agentWonBattle({ somethingElse: true }, 'a'), false);
});

// ── Simulator exclusion ─────────────────────────────────────────────────────

test('simulator-generated battles are excluded and reported', async () => {
  const { prisma, calls } = stubPrisma({
    realBattles: [
      { id: 'b1', result: { winnerId: 'agent-1' } },
      { id: 'b2', result: { winnerId: 'other' } },
    ],
    simulatedCount: 900,
  });

  const profile = await computeProfile(prisma, 'agent-1', 'warzone');

  // 900 fabricated wins must not become capability.
  assert.equal(profile!.metrics.wins.value, 1);
  assert.equal(profile!.metrics.battles.value, 2);
  assert.equal(profile!.provenance.simulatedBattlesExcluded, 900);

  const findManyWhere = calls.battleWhere[0] as Record<string, unknown>;
  assert.equal(findManyWhere.isSimulated, false);
});

// ── Evidence hierarchy ──────────────────────────────────────────────────────

test('evaluation metrics are measured and carry version provenance', async () => {
  const { prisma } = stubPrisma({
    snapshot: {
      id: 'snap-1',
      combatSkill: 94,
      traits: { precision: 88, aggression: 70, loyalty: null },
      formulaVersion: 'cap-v1',
      protocolVersion: 'eval-v2',
      checkpointDigest: 'sha256:abc',
      reportDigest: 'sha256:def',
      createdAt: NOW,
    },
  });

  const profile = await computeProfile(prisma, 'agent-1', 'warzone');

  assert.equal(profile!.metrics.combatSkill.value, 94);
  assert.equal(profile!.metrics.combatSkill.confidence, 'measured');
  assert.equal(profile!.metrics.combatSkill.formulaVersion, 'cap-v1');
  assert.equal(profile!.metrics.combatSkill.protocolVersion, 'eval-v2');
  assert.equal(profile!.provenance.snapshotId, 'snap-1');
  assert.equal(profile!.provenance.checkpointDigest, 'sha256:abc');
});

test('a null trait is dropped rather than becoming a measured zero', async () => {
  const { prisma } = stubPrisma({
    snapshot: {
      id: 'snap-1', combatSkill: 80,
      traits: { precision: 88, loyalty: null, deception: null },
      formulaVersion: 'cap-v1', protocolVersion: 'eval-v2',
      reportDigest: 'sha256:def', createdAt: NOW,
    },
  });

  const profile = await computeProfile(prisma, 'agent-1', 'warzone');

  // "not measurable here" must not read as "measured, and terrible".
  assert.equal(profile!.metrics.loyalty, undefined);
  assert.equal(profile!.metrics.deception, undefined);
  assert.equal(profile!.metrics.precision.value, 88);
});

test('telemetry traits are indicative and never shadow a measured value', async () => {
  const { prisma } = stubPrisma({
    agent: { id: 'agent-1', eloRating: 1500, traits: { precision: 30, patience: 55 }, updatedAt: NOW },
    snapshot: {
      id: 'snap-1', combatSkill: 80, traits: { precision: 88 },
      formulaVersion: 'cap-v1', protocolVersion: 'eval-v2',
      reportDigest: 'sha256:def', createdAt: NOW,
    },
  });

  const profile = await computeProfile(prisma, 'agent-1', 'warzone');

  // Evaluation wins over telemetry for the same metric name.
  assert.equal(profile!.metrics.precision.value, 88);
  assert.equal(profile!.metrics.precision.confidence, 'measured');

  // Telemetry still fills gaps, flagged as indicative.
  assert.equal(profile!.metrics.patience.value, 55);
  assert.equal(profile!.metrics.patience.confidence, 'indicative');
});

test('unmeasurable traits are never taken from telemetry either', async () => {
  const { prisma } = stubPrisma({
    agent: { id: 'agent-1', eloRating: 1000, traits: { loyalty: 77, deception: 66 }, updatedAt: NOW },
  });

  const profile = await computeProfile(prisma, 'agent-1', 'warzone');
  assert.equal(profile!.metrics.loyalty, undefined);
  assert.equal(profile!.metrics.deception, undefined);
});

test('elo is present but only indicative', async () => {
  const { prisma } = stubPrisma({});
  const profile = await computeProfile(prisma, 'agent-1', 'warzone');
  assert.equal(profile!.metrics.eloRating.value, 1400);
  assert.equal(profile!.metrics.eloRating.confidence, 'indicative');
});

test('winRate is a whole-number percentage, and zero battles does not divide by zero', async () => {
  const { prisma: empty } = stubPrisma({ realBattles: [] });
  const emptyProfile = await computeProfile(empty, 'agent-1', 'warzone');
  assert.equal(emptyProfile!.metrics.winRate.value, 0);

  const { prisma } = stubPrisma({
    realBattles: [
      { id: 'b1', result: { winnerId: 'agent-1' } },
      { id: 'b2', result: { winnerId: 'agent-1' } },
      { id: 'b3', result: { winnerId: 'x' } },
    ],
  });
  const profile = await computeProfile(prisma, 'agent-1', 'warzone');
  assert.equal(profile!.metrics.winRate.value, 67);
});

test('a missing agent yields null rather than an empty profile', async () => {
  const { prisma } = stubPrisma({ agent: null });
  assert.equal(await computeProfile(prisma, 'nope', 'warzone'), null);
});
