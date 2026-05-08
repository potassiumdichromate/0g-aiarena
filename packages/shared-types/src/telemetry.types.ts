export type TelemetryEventType =
  | 'COMBAT_ACTION'
  | 'POSITION_UPDATE'
  | 'HEALTH_CHANGE'
  | 'ABILITY_USE'
  | 'ITEM_PICK'
  | 'KILL'
  | 'DEATH'
  | 'ROUND_START'
  | 'ROUND_END'
  | 'OBJECTIVE_CAPTURE'
  | 'CUSTOM';

export interface TelemetryEvent {
  eventId: string;
  sessionId: string;
  agentId: string;
  battleId?: string;
  eventType: TelemetryEventType;
  timestamp: number;
  payload: Record<string, unknown>;
  sequenceNumber: number;
}

export interface CombatActionPayload {
  actionType: string;
  targetId?: string;
  position: { x: number; y: number; z: number };
  success: boolean;
  damageDealt?: number;
  latencyMs: number;
}

export interface PositionUpdatePayload {
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
  rotation: number;
}

export interface TelemetryBatch {
  batchId: string;
  sessionId: string;
  agentId: string;
  events: TelemetryEvent[];
  submittedAt: number;
  checksum: string;
}

export interface TelemetrySession {
  id: string;
  agentId: string;
  gameId: string;
  battleId?: string;
  startedAt: Date;
  endedAt?: Date;
  eventCount: number;
  status: 'ACTIVE' | 'COMPLETED' | 'ABANDONED';
}
