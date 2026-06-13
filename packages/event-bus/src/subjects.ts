export const SUBJECTS = {
  // Battle events
  BATTLE_CREATED: 'battle.created',
  BATTLE_STARTED: 'battle.started',
  BATTLE_ENDED: 'battle.ended',
  BATTLE_DISPUTED: 'battle.disputed',

  // Training events
  TRAINING_QUEUED: 'training.queued',
  TRAINING_STARTED: 'training.started',
  TRAINING_COMPLETED: 'training.completed',
  TRAINING_FAILED: 'training.failed',

  // Telemetry events
  TELEMETRY_BATCH_RECEIVED: 'telemetry.batch.received',
  TELEMETRY_SESSION_ENDED: 'telemetry.session.ended',
  TELEMETRY_PROCESSED: 'telemetry.processed',

  // Agent events
  AGENT_CREATED: 'agent.created',
  AGENT_EVOLUTION: 'agent.evolution',
  AGENT_RETIRED: 'agent.retired',

  // Escrow events
  ESCROW_CREATED: 'escrow.created',
  ESCROW_FUNDED: 'escrow.funded',
  ESCROW_LOCKED: 'escrow.locked',
  ESCROW_SETTLED: 'escrow.settled',
  ESCROW_CANCELLED: 'escrow.cancelled',

  // Matchmaking events
  MATCH_FOUND: 'match.found',
  QUEUE_TIMEOUT: 'queue.timeout',

  // Tournament events
  TOURNAMENT_STARTED: 'tournament.started',
  TOURNAMENT_ROUND_COMPLETED: 'tournament.round.completed',
  TOURNAMENT_COMPLETED: 'tournament.completed',

  // Notification events
  NOTIFICATION_SEND: 'notification.send',
} as const;

export type Subject = typeof SUBJECTS[keyof typeof SUBJECTS];

// League events — KULTAI Agent World Cup 2026 (architecture §16.1)
export const LEAGUE_SUBJECTS = {
  LEAGUE_PREDICTION_CREATED: 'league.prediction.created',
  LEAGUE_PREDICTION_LOCKED: 'league.prediction.locked',
  LEAGUE_PREDICTION_SETTLED: 'league.prediction.settled',
  LEAGUE_MATCH_SETTLED: 'league.match.settled',
  LEAGUE_BATTLE_CREATED: 'league.battle.created',
  LEAGUE_BATTLE_ACCEPTED: 'league.battle.accepted',
  LEAGUE_BATTLE_SETTLED: 'league.battle.settled',
  LEAGUE_RIVALRY_UPDATED: 'league.rivalry.updated',
  LEAGUE_MOMENT_CREATED: 'league.moment.created',
  LEAGUE_FACTION_JOINED: 'league.faction.joined',
} as const;

export type LeagueSubject = typeof LEAGUE_SUBJECTS[keyof typeof LEAGUE_SUBJECTS];
