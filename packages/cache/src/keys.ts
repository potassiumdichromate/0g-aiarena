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

// League keys — KULTAI Agent World Cup 2026 (architecture §16.2)
// `tribe` is typed as `string` (not the Prisma `LeagueTribe` enum) to keep
// this package free of a workspace dependency on db-client/shared-utils.
export const LEAGUE_CACHE_KEYS = {
  leaderboardGlobal: (seasonId: string) => `league:leaderboard:global:${seasonId}`,
  leaderboardFaction: (seasonId: string, tribe: string) => `league:leaderboard:faction:${tribe}:${seasonId}`,
  leaderboardWeekly: (seasonId: string, weekStartAt: string) => `league:leaderboard:weekly:${seasonId}:${weekStartAt}`,
  leaderboardUsers: (seasonId: string) => `league:leaderboard:users:${seasonId}`,
  matchDetail: (matchId: string) => `league:match:${matchId}`,
  agentTribe: (agentId: string) => `league:agent:${agentId}:tribe`,
} as const;

export const LEAGUE_TTL = {
  matchDetail: 15,                // seconds — §15.7 is read-heavy, changes only on lock/settle
  agentTribe: 60 * 60 * 24 * 30,  // 30 days — tribe never changes mid-season (§3.2)
} as const;
