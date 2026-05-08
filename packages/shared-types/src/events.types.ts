import { Battle, MatchResult } from './battle.types';
import { Agent } from './agent.types';

export interface BattleEndedEvent {
  battleId: string;
  result: MatchResult;
  battle: Battle;
  occurredAt: Date;
}

export interface BattleStartedEvent {
  battleId: string;
  agentIds: string[];
  gameId: string;
  occurredAt: Date;
}

export interface TrainingCompletedEvent {
  jobId: string;
  agentId: string;
  modelId: string;
  checkpointPath: string;
  metrics: {
    loss: number;
    accuracy?: number;
    epochs: number;
    trainingTime: number;
  };
  occurredAt: Date;
}

export interface TrainingQueuedEvent {
  jobId: string;
  agentId: string;
  priority: number;
  occurredAt: Date;
}

export interface AgentEvolutionEvent {
  agentId: string;
  tokenId: string;
  fromStage: string;
  toStage: string;
  txHash: string;
  occurredAt: Date;
}

export interface EscrowSettledEvent {
  escrowId: string;
  battleId: string;
  winnerId: string;
  amounts: Record<string, number>;
  txHash: string;
  occurredAt: Date;
}

export interface TelemetryProcessedEvent {
  sessionId: string;
  agentId: string;
  featuresPath: string;
  eventCount: number;
  occurredAt: Date;
}

export interface MatchFoundEvent {
  matchId: string;
  agentIds: string[];
  eloRatings: Record<string, number>;
  occurredAt: Date;
}
