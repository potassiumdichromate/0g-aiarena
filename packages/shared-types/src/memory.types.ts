export type MemoryType = 'WORKING' | 'EPISODIC' | 'SEMANTIC' | 'PROCEDURAL';

export interface MemoryItem {
  id: string;
  agentId: string;
  type: MemoryType;
  content: string;
  embedding?: number[];
  importance: number;   // 0-1
  accessCount: number;
  lastAccessed: Date;
  createdAt: Date;
  expiresAt?: Date;
  metadata: Record<string, unknown>;
}

export interface BattleEpisode {
  id: string;
  agentId: string;
  battleId: string;
  opponentId: string;
  outcome: 'WIN' | 'LOSS' | 'DRAW';
  keyMoments: Array<{
    timestamp: number;
    description: string;
    importance: number;
  }>;
  lessonsLearned: string[];
  eloChange: number;
  embedding?: number[];
  storedAt: Date;
}

export interface WorkingMemoryState {
  agentId: string;
  currentBattleId?: string;
  currentOpponentId?: string;
  currentStrategy: string;
  recentActions: string[];
  healthState: number;
  resourceState: Record<string, number>;
  threatLevel: number;
  updatedAt: Date;
}

export interface MemoryRetrievalOptions {
  query: string;
  limit: number;
  types?: MemoryType[];
  minImportance?: number;
  filter?: Record<string, unknown>;
}
