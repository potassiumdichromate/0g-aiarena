export type ClanType = 'CYBER' | 'BIO' | 'ARCANE' | 'MECH' | 'SHADOW';
export type EvolutionStage = 'GENESIS' | 'AWAKENED' | 'ASCENDED' | 'LEGENDARY' | 'MYTHIC';
export type CombatArchetype = 'BERSERKER' | 'TACTICIAN' | 'SUPPORT' | 'ASSASSIN' | 'DEFENDER' | 'HYBRID';

export interface AgentTraits {
  aggression: number;       // 0-100
  patience: number;         // 0-100
  adaptability: number;     // 0-100
  riskTolerance: number;    // 0-100
  teamwork: number;         // 0-100
  creativity: number;       // 0-100
  endurance: number;        // 0-100
  precision: number;        // 0-100
}

export interface AgentMetadata {
  name: string;
  description: string;
  avatarUrl: string;
  backstory: string;
  clan: ClanType;
  archetype: CombatArchetype;
  evolutionStage: EvolutionStage;
  traits: AgentTraits;
  specialAbilities: string[];
  weaknesses: string[];
}

export interface Agent {
  id: string;
  userId: string;
  name: string;
  metadata: AgentMetadata;
  eloRating: number;
  wins: number;
  losses: number;
  draws: number;
  totalBattles: number;
  inftTokenId?: string;
  activeModelId?: string;
  isRetired: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentProfile extends Agent {
  recentBattles: string[];
  memoryCount: number;
  trainingJobCount: number;
}
