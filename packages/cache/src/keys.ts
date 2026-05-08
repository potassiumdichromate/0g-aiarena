export const CACHE_KEYS = {
  // Agent keys
  agent: (id: string) => `agent:${id}`,
  agentProfile: (id: string) => `agent:${id}:profile`,
  agentWorkingMemory: (id: string) => `agent:${id}:working_memory`,
  agentElo: (id: string) => `agent:${id}:elo`,

  // Battle keys
  battle: (id: string) => `battle:${id}`,
  battleState: (id: string) => `battle:${id}:state`,
  battleParticipants: (id: string) => `battle:${id}:participants`,

  // Matchmaking keys
  matchQueue: (gameId: string, mode: string) => `queue:${gameId}:${mode}`,
  queueEntry: (agentId: string) => `queue_entry:${agentId}`,

  // Inference keys
  inferenceCache: (agentId: string, stateHash: string) => `inference:${agentId}:${stateHash}`,

  // Leaderboard keys
  leaderboard: (id: string) => `leaderboard:${id}`,
  globalLeaderboard: () => `leaderboard:global`,

  // Session keys
  userSession: (userId: string) => `session:${userId}`,
  nonce: (address: string) => `nonce:${address}`,

  // Rate limiting
  rateLimit: (key: string) => `rate_limit:${key}`,

  // Notification keys
  userNotifications: (userId: string) => `notifications:${userId}`,

  // Token refresh
  refreshToken: (userId: string) => `refresh:${userId}`,
} as const;

export const TTL = {
  SESSION: 3600,          // 1 hour
  REFRESH_TOKEN: 604800,  // 7 days
  NONCE: 300,             // 5 minutes
  AGENT_CACHE: 300,       // 5 minutes
  INFERENCE_CACHE: 1,     // 1 second (50ms effective)
  BATTLE_STATE: 3600,     // 1 hour
  LEADERBOARD: 60,        // 1 minute
} as const;
