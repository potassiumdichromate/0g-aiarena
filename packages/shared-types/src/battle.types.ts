export type BattleState = 'PENDING' | 'INITIALIZING' | 'IN_PROGRESS' | 'PAUSED' | 'COMPLETED' | 'DISPUTED' | 'CANCELLED';
export type BattleMode = 'RANKED' | 'CASUAL' | 'WAGER' | 'TOURNAMENT' | 'EXHIBITION';
export type WinCondition = 'KO' | 'POINTS' | 'SURVIVAL' | 'OBJECTIVE';

export interface CombatAction {
  agentId: string;
  actionType: string;
  targetId?: string;
  parameters: Record<string, unknown>;
  timestamp: number;
  confidence: number;
  source: 'AI' | 'FALLBACK' | 'CACHED';
}

export interface BattleConfig {
  gameId: string;
  mode: BattleMode;
  maxRounds: number;
  timeoutMs: number;
  wagerAmount?: number;
  allowSpectators: boolean;
  recordReplay: boolean;
  winCondition: WinCondition;
}

export interface MatchResult {
  winnerId: string;
  loserId: string;
  winCondition: WinCondition;
  roundsPlayed: number;
  finalScore: Record<string, number>;
  eloChange: Record<string, number>;
  replayHash?: string;
}

export interface Battle {
  id: string;
  gameId: string;
  agentIds: string[];
  config: BattleConfig;
  state: BattleState;
  result?: MatchResult;
  escrowId?: string;
  replayId?: string;
  startedAt?: Date;
  endedAt?: Date;
  createdAt: Date;
}
