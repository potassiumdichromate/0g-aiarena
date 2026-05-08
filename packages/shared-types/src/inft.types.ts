import { AgentTraits, ClanType, CombatArchetype, EvolutionStage } from './agent.types';

export interface INFTAttribute {
  trait_type: string;
  value: string | number;
  display_type?: 'number' | 'boost_percentage' | 'boost_number' | 'date';
}

export interface INFTMetadata {
  tokenId: string;
  agentId: string;
  name: string;
  description: string;
  image: string;
  animationUrl?: string;
  externalUrl?: string;
  attributes: INFTAttribute[];
  traits: AgentTraits;
  clan: ClanType;
  archetype: CombatArchetype;
  evolutionStage: EvolutionStage;
  memoryRootHash?: string;
  modelVersionHash?: string;
  generationNumber: number;
  parentTokenIds?: string[];
  chainId: number;
  contractAddress: string;
  mintedAt: Date;
  lastEvolutionAt?: Date;
}

export interface EvolutionResult {
  tokenId: string;
  previousStage: EvolutionStage;
  newStage: EvolutionStage;
  traitChanges: Partial<AgentTraits>;
  newAttributes: INFTAttribute[];
  txHash: string;
  evolvedAt: Date;
}
