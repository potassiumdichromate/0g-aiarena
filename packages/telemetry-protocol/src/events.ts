export interface TelemetryEventBase {
  eventId: string;
  sessionId: string;
  agentId: string;
  battleId?: string;
  eventType: string;
  timestamp: number;
  sequenceNumber: number;
}

export interface CombatActionEvent extends TelemetryEventBase {
  eventType: 'COMBAT_ACTION';
  payload: {
    actionType: string;
    targetId?: string;
    position: { x: number; y: number; z: number };
    success: boolean;
    damageDealt?: number;
    latencyMs: number;
  };
}

export interface PositionUpdateEvent extends TelemetryEventBase {
  eventType: 'POSITION_UPDATE';
  payload: {
    position: { x: number; y: number; z: number };
    velocity: { x: number; y: number; z: number };
    rotation: number;
  };
}

export interface HealthChangeEvent extends TelemetryEventBase {
  eventType: 'HEALTH_CHANGE';
  payload: {
    previousHp: number;
    currentHp: number;
    maxHp: number;
    changeReason: string;
    sourceId?: string;
  };
}

export interface AbilityUseEvent extends TelemetryEventBase {
  eventType: 'ABILITY_USE';
  payload: {
    abilityId: string;
    abilityName: string;
    targetId?: string;
    cooldownMs: number;
    manaCost?: number;
  };
}

export interface KillEvent extends TelemetryEventBase {
  eventType: 'KILL';
  payload: {
    victimId: string;
    weaponUsed: string;
    position: { x: number; y: number; z: number };
    killStreak: number;
  };
}

export interface RoundEvent extends TelemetryEventBase {
  eventType: 'ROUND_START' | 'ROUND_END';
  payload: {
    roundNumber: number;
    scores?: Record<string, number>;
    winnerIds?: string[];
  };
}

export type AnyTelemetryEvent =
  | CombatActionEvent
  | PositionUpdateEvent
  | HealthChangeEvent
  | AbilityUseEvent
  | KillEvent
  | RoundEvent;

export interface TelemetryBatch {
  batchId: string;
  sessionId: string;
  agentId: string;
  events: AnyTelemetryEvent[];
  submittedAt: number;
  checksum: string;
}
