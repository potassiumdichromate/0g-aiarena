export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
  pagination?: PaginationMeta;
}

export interface PaginationMeta {
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

export interface PaginationQuery {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface CreateAgentRequest {
  name: string;
  clan: string;
  archetype?: string;
  backstory?: string;
  gameId?: string;
}

export interface UpdateAgentRequest {
  name?: string;
  metadata?: Record<string, unknown>;
}

export interface LoginRequest {
  message: string;
  signature: string;
  walletAddress: string;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  userId: string;
}

export interface CreateBattleRequest {
  agentId: string;
  opponentId: string;
  mode: string;
  gameId: string;
  wagerAmount?: number;
}

export interface QueueJoinRequest {
  agentId: string;
  gameId: string;
  mode: string;
  eloRange?: number;
}
