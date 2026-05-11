/**
 * Typed API client for the AI Arena backend.
 *
 * Auth flow:
 *   1. Privy login → POST /v1/auth/privy → stores JWT in localStorage
 *   2. All requests here include Bearer JWT automatically
 *   3. On 401, try refresh token → if that fails, clear storage (force re-login)
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';

export class ApiError extends Error {
  constructor(
    public status:  number,
    public code:    string,
    message:        string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// ── Token management ──────────────────────────────────────────────────────────

function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('accessToken');
}

async function refreshToken(): Promise<string | null> {
  const rt = localStorage.getItem('refreshToken');
  if (!rt) return null;
  try {
    const r = await fetch(`${API_BASE}/v1/auth/refresh`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ refreshToken: rt }),
    });
    if (!r.ok) throw new Error('refresh failed');
    const d = await r.json();
    localStorage.setItem('accessToken', d.accessToken);
    localStorage.setItem('tokenExpiresAt', String(Date.now() + d.expiresIn * 1000));
    return d.accessToken;
  } catch {
    // Refresh failed — clear everything, force re-login
    localStorage.clear();
    window.dispatchEvent(new CustomEvent('ai-arena:session-expired'));
    return null;
  }
}

// ── Core request ──────────────────────────────────────────────────────────────

async function request<T>(
  path:    string,
  options: RequestInit = {},
  retry =  true,
): Promise<T> {
  const token = getToken();

  const response = await fetch(`${API_BASE}/v1${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });

  // Auto-refresh on 401
  if (response.status === 401 && retry) {
    const newToken = await refreshToken();
    if (newToken) return request<T>(path, options, false);
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(response.status, body.error ?? 'UNKNOWN_ERROR', body.message ?? response.statusText);
  }

  return response.json() as Promise<T>;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export const authApi = {
  /** Exchange Privy access token for our JWT */
  loginWithPrivy: (accessToken: string) =>
    request<{
      accessToken:            string;
      refreshToken:           string;
      expiresIn:              number;
      userId:                 string;
      walletAddress:          string;
      custodialSolanaAddress: string;
      isNewUser:              boolean;
    }>('/auth/privy', { method: 'POST', body: JSON.stringify({ accessToken }) }),

  me: () =>
    request<{ user: { id: string; walletAddress: string; custodialSolanaAddress: string; username: string | null } }>(
      '/auth/me',
    ),

  refresh: (refreshToken: string) =>
    request<{ accessToken: string; expiresIn: number }>(
      '/auth/refresh',
      { method: 'POST', body: JSON.stringify({ refreshToken }) },
    ),
};

// ── Token / $ARENA ────────────────────────────────────────────────────────────

export const tokenApi = {
  price: () =>
    request<{ backingRatio: number; backingRatioBps: string; totalShares: string; isPaused: boolean }>(
      '/token/price',
    ),

  balance: (solanaAddress: string) =>
    request<{ raw: string; human: number; usdcEquivalent: number }>(
      `/token/balance/${solanaAddress}`,
    ),

  depositPreview: (usdcAmount: string) =>
    request<{ arenaOut: string; backingRatio: number; pricePerArena: number }>(
      '/token/deposit/preview',
      { method: 'POST', body: JSON.stringify({ usdcAmount }) },
    ),

  redeemPreview: (arenaAmount: string) =>
    request<{ grossUsdc: string; fee: string; netUsdc: string; feeBps: number }>(
      '/token/redeem/preview',
      { method: 'POST', body: JSON.stringify({ arenaAmount }) },
    ),

  registerDeposit: (body: {
    userId: string; sourceChain: string; sourceTxHash: string;
    solanaAddress: string; usdcAmount: string; depositId: string;
  }) => request<{ depositRecordId: string; status: string }>(
    '/token/bridge/deposit',
    { method: 'POST', body: JSON.stringify(body) },
  ),

  deposits: (solanaAddress: string) =>
    request<Array<{ id: string; status: string; usdcAmount: string; createdAt: string }>>(
      `/token/bridge/deposits?solanaAddress=${solanaAddress}`,
    ),
};

// ── Agents ────────────────────────────────────────────────────────────────────

export interface Agent {
  id:             string;
  name:           string;
  clan:           string;
  archetype:      string;
  evolutionStage: string;
  eloRating:      number;
  wins:           number;
  losses:         number;
  traits:         Record<string, number>;
  inftTokenId:    string | null;
  createdAt:      string;
}

export const agentApi = {
  list: async (params?: { page?: number; pageSize?: number; clan?: string }): Promise<{ agents: Agent[]; pagination: { page: number; total: number } }> => {
    const qs = new URLSearchParams(
      Object.entries(params ?? {})
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, String(v)]),
    ).toString();
    const res = await request<{ agents: Agent[]; pagination?: { page: number; total: number }; total?: number }>(
      `/agents${qs ? `?${qs}` : ''}`,
    );
    return {
      agents: res.agents ?? [],
      pagination: res.pagination ?? { page: params?.page ?? 1, total: res.total ?? (res.agents?.length ?? 0) },
    };
  },
  get:    (id: string) => request<Agent>(`/agents/${id}`),
  create: async (body: { name: string; clan: string; archetype: string; gameId: string }): Promise<Agent> => {
    const res = await request<{ agent: Agent } | Agent>('/agents', { method: 'POST', body: JSON.stringify(body) });
    // Agent service returns { agent: {...} } — unwrap if needed
    return ('agent' in res && res.agent) ? (res as { agent: Agent }).agent : res as Agent;
  },
};

// ── Battles ───────────────────────────────────────────────────────────────────

export interface Battle {
  id:        string;
  status:    string;
  agentIds:  string[];
  winnerId:  string | null;
  startedAt: string | null;
  endedAt:   string | null;
}

export const battleApi = {
  create:  (body: { agentIds: string[]; mode: string; stakeAmount?: number }) =>
    request<Battle>('/battles', { method: 'POST', body: JSON.stringify(body) }),
  get:     (id: string) => request<Battle>(`/battles/${id}`),
  history: (params?: { agentId?: string; limit?: number }) => {
    const qs = new URLSearchParams(Object.entries(params ?? {}).map(([k, v]) => [k, String(v)])).toString();
    return request<{ battles: Battle[] }>(`/battles/history${qs ? `?${qs}` : ''}`);
  },
};

// ── Matchmaking ───────────────────────────────────────────────────────────────

export const matchmakingApi = {
  join:   (body: { agentId: string; gameId: string; mode: string }) =>
    request<{ queueId: string; position: number }>('/matchmaking/join', { method: 'POST', body: JSON.stringify(body) }),
  leave:  (agentId: string) =>
    request<{ success: boolean }>('/matchmaking/leave', { method: 'DELETE', body: JSON.stringify({ agentId }) }),
  status: (agentId: string) =>
    request<{ position: number; estimatedWaitMs: number }>(`/matchmaking/status?agentId=${agentId}`),
};

// ── Leaderboard ───────────────────────────────────────────────────────────────

export const leaderboardApi = {
  global: (limit = 100) =>
    request<{ entries: Array<{ rank: number; agentId: string; name: string; score: number; eloRating: number }> }>(
      `/leaderboards/global?limit=${limit}`,
    ),
  byGame: (gameId: string, limit = 100) =>
    request<{ entries: Array<{ rank: number; agentId: string; name: string; score: number }> }>(
      `/leaderboards/${gameId}?limit=${limit}`,
    ),
};
