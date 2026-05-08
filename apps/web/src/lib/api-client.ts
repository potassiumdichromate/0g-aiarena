/**
 * Typed API client for the AI Arena backend.
 * Wraps fetch with auth headers, error handling, and response typing.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = typeof window !== "undefined"
    ? localStorage.getItem("accessToken")
    : null;

  const response = await fetch(`${API_BASE}/v1${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(
      response.status,
      body.error ?? "UNKNOWN_ERROR",
      body.message ?? response.statusText,
    );
  }

  return response.json() as Promise<T>;
}

// Auth
export const authApi = {
  getNonce: (address: string) =>
    request<{ nonce: string }>(`/auth/nonce?address=${encodeURIComponent(address)}`),

  login: (body: { message: string; signature: string; walletAddress: string }) =>
    request<{ accessToken: string; refreshToken: string; expiresIn: number }>(
      "/auth/login",
      { method: "POST", body: JSON.stringify(body) },
    ),
};

// Agents
export interface Agent {
  id: string;
  name: string;
  clan: string;
  archetype: string;
  evolutionStage: string;
  elo: number;
  traits: Record<string, number>;
  inftTokenId: string | null;
  createdAt: string;
}

export const agentApi = {
  list: (params?: { page?: number; pageSize?: number; clan?: string }) => {
    const qs = new URLSearchParams(
      Object.entries(params ?? {})
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, String(v)]),
    ).toString();
    return request<{ agents: Agent[]; pagination: { page: number; total: number } }>(
      `/agents${qs ? `?${qs}` : ""}`,
    );
  },

  get: (id: string) => request<Agent>(`/agents/${id}`),

  create: (body: { name: string; clan: string; archetype: string; gameId: string }) =>
    request<Agent>("/agents", { method: "POST", body: JSON.stringify(body) }),
};

// Battles
export interface Battle {
  id: string;
  status: string;
  agentIds: string[];
  winnerId: string | null;
  startedAt: string | null;
  endedAt: string | null;
}

export const battleApi = {
  create: (body: { agentIds: string[]; mode: string; stakeAmount?: number }) =>
    request<Battle>("/battles", { method: "POST", body: JSON.stringify(body) }),

  get: (id: string) => request<Battle>(`/battles/${id}`),
};

// Leaderboard
export interface LeaderboardEntry {
  rank: number;
  agentId: string;
  name: string;
  score: number;
}

export const leaderboardApi = {
  get: (id: string, limit = 100) =>
    request<{ entries: LeaderboardEntry[] }>(`/leaderboard/${id}?limit=${limit}`),
};
