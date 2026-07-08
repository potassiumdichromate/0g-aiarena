/**
 * Thin HTTP client for arena-chain-service — the only holder of the relayer
 * signer for the $ARENA 0G Chain economy. financial-service no longer writes
 * escrow settlement math into Postgres directly; it calls arena-chain-service
 * to create/join/start/settle/cancel on-chain matches instead, keyed by the
 * existing battleId string as the escrow's matchId (arena-chain-service
 * hashes it into the bytes32 the ArenaEscrow contract expects).
 *
 * Auth: X-Service-Key header (INTERNAL_SERVICE_SECRET) — same pattern used
 * by agent-service -> inft-service (see agent-service/src/services/agent.service.ts).
 */
const ARENA_CHAIN_SERVICE_URL = process.env.ARENA_CHAIN_SERVICE_URL ?? 'http://localhost:8050';

function serviceHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Service-Key': process.env.INTERNAL_SERVICE_SECRET ?? '',
  };
}

export class ArenaChainError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'ArenaChainError';
  }
}

async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${ARENA_CHAIN_SERVICE_URL}${path}`, {
    method: 'POST',
    headers: serviceHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new ArenaChainError((payload as { error?: string }).error ?? `arena-chain-service ${path} failed (${res.status})`, res.status);
  }
  return res.json() as Promise<T>;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${ARENA_CHAIN_SERVICE_URL}${path}`, { headers: serviceHeaders() });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    throw new ArenaChainError((payload as { error?: string }).error ?? `arena-chain-service ${path} failed (${res.status})`, res.status);
  }
  return res.json() as Promise<T>;
}

export interface EscrowMatchState {
  matchId: string;
  playerA: string;
  playerB: string;
  stakeAmountArena: string;
  state: 'NONE' | 'CREATED' | 'JOINED' | 'STARTED' | 'SETTLED' | 'CANCELLED';
}

export const arenaChain = {
  createMatch: (matchId: string, playerAAddress: string, stakeAmountArena: string) =>
    post<{ txHash: string; matchId: string }>('/v1/arena/escrow/create', { matchId, playerAAddress, stakeAmountArena }),

  joinMatch: (matchId: string, playerBAddress: string) =>
    post<{ txHash: string; matchId: string }>('/v1/arena/escrow/join', { matchId, playerBAddress }),

  startMatch: (matchId: string) =>
    post<{ txHash: string; matchId: string }>('/v1/arena/escrow/start', { matchId }),

  settleMatch: (matchId: string, winnerAddress: string) =>
    post<{ txHash: string; matchId: string; winnerAddress: string }>('/v1/arena/escrow/settle', { matchId, winnerAddress }),

  cancelMatch: (matchId: string) =>
    post<{ txHash: string; matchId: string }>('/v1/arena/escrow/cancel', { matchId }),

  getMatch: (matchId: string) =>
    get<EscrowMatchState>(`/v1/arena/escrow/${encodeURIComponent(matchId)}`),

  grantTrainingReward: (playerAddress: string, amountArena: string, reason: string) =>
    post<{ txHash: string; amountArena: string }>('/v1/arena/rewards/training', { playerAddress, amountArena, reason }),

  /**
   * Relays a player's off-chain EIP-2612 permit signature into
   * `token.permit()` on arena-chain-service, gas-paid by the relayer. This is
   * what lets a player authorize ArenaEscrow/ArenaTournament to spend their
   * ARENA without ever submitting an on-chain approve() tx themselves (see
   * useArenaStaking.ts on the frontend, which builds and signs the message).
   */
  permit: (params: { owner: string; spender: string; value: string; deadline: number; v: number; r: string; s: string }) =>
    post<{ txHash: string; owner: string; spender: string; valueArena: string }>('/v1/arena/permit', params),
};
