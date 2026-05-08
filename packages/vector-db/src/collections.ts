export const COLLECTIONS = {
  AGENT_MEMORIES: 'agent_memories',
  BATTLE_EPISODES: 'battle_episodes',
  BEHAVIOUR_PROFILES: 'behaviour_profiles',
  AGENT_EMBEDDINGS: 'agent_embeddings',
} as const;

export type CollectionName = typeof COLLECTIONS[keyof typeof COLLECTIONS];

export const COLLECTION_CONFIGS: Record<CollectionName, {
  vectorSize: number;
  distance: 'Cosine' | 'Euclidean' | 'Dot';
}> = {
  [COLLECTIONS.AGENT_MEMORIES]: { vectorSize: 1024, distance: 'Cosine' },
  [COLLECTIONS.BATTLE_EPISODES]: { vectorSize: 1024, distance: 'Cosine' },
  [COLLECTIONS.BEHAVIOUR_PROFILES]: { vectorSize: 512, distance: 'Cosine' },
  [COLLECTIONS.AGENT_EMBEDDINGS]: { vectorSize: 1024, distance: 'Cosine' },
};
