/** Random agent data generation -- one filler agent per mint cycle. */

const NAME_PREFIXES = [
  'Vex', 'Kael', 'Nyra', 'Draven', 'Sable', 'Ryn', 'Thorne', 'Zeph',
  'Kira', 'Malek', 'Ashen', 'Vorn', 'Lyra', 'Grim', 'Onyx', 'Ryker',
  'Nova', 'Cass', 'Rho', 'Talon', 'Ember', 'Fenn', 'Isolde', 'Korr',
];

const NAME_SUFFIXES = [
  'strider', 'shade', 'blade', 'wraith', 'forge', 'storm', 'hollow',
  'wing', 'fang', 'core', 'wolf', 'spire', 'crest', 'byte', 'circuit',
  'reaper', 'vale', 'drift', 'warden', 'null',
];

const CLANS = ['ZEROG', 'BASE', 'SOLANA'] as const;

const ARCHETYPES = [
  'BERSERKER', 'TACTICIAN', 'SUPPORT', 'ASSASSIN', 'DEFENDER', 'HYBRID',
] as const;

const BACKSTORY_TEMPLATES = [
  'Forged in the data-storms of the outer shard, {name} fights for a name no one gave them.',
  '{name} was an abandoned training model until a stray signal woke something up.',
  'Once a simulation-only construct, {name} clawed its way into the real arena.',
  '{name} keeps no allies and no grudges -- only a ledger of fights owed.',
  'Nobody built {name} to win. {name} decided that anyway.',
  '{name} logs every defeat and forgets every apology.',
  'Rumor says {name} was compiled from the wreckage of three failed agents.',
];

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function randomAgentName(): string {
  return `${pick(NAME_PREFIXES)}${pick(NAME_SUFFIXES)}`;
}

export interface AgentPayload {
  name: string;
  clan: (typeof CLANS)[number];
  archetype: (typeof ARCHETYPES)[number];
  backstory: string;
}

export function randomAgentPayload(): AgentPayload {
  const name = randomAgentName();
  const clan = pick(CLANS);
  const archetype = pick(ARCHETYPES);
  const backstory = pick(BACKSTORY_TEMPLATES).replace(/\{name\}/g, name);
  return { name, clan, archetype, backstory };
}

/** Random delay in ms, uniformly distributed between minMinutes and maxMinutes. */
export function randomIntervalMs(minMinutes: number, maxMinutes: number): number {
  const min = Math.min(minMinutes, maxMinutes);
  const max = Math.max(minMinutes, maxMinutes);
  const minutes = min + Math.random() * (max - min);
  return Math.round(minutes * 60_000);
}
