export type TransactionType = 'DEPOSIT' | 'WITHDRAWAL' | 'BATTLE_WAGER' | 'BATTLE_REWARD' | 'TOURNAMENT_ENTRY' | 'TOURNAMENT_PRIZE' | 'STAKE' | 'UNSTAKE' | 'TRANSFER';
export type TransactionStatus = 'PENDING' | 'CONFIRMED' | 'FAILED' | 'CANCELLED';
export type EscrowState = 'OPEN' | 'FUNDED' | 'LOCKED' | 'SETTLED' | 'CANCELLED' | 'DISPUTED';

export interface SpendingPolicy {
  agentId: string;
  maxSingleWager: number;
  maxDailySpend: number;
  allowedGameIds: string[];
  requireApprovalAbove: number;
  isActive: boolean;
  updatedAt: Date;
}

export interface AgentWallet {
  id: string;
  agentId: string;
  solanaAddress: string;
  balanceArena: number;
  balanceSol: number;
  isFrozen: boolean;
  policy: SpendingPolicy;
  createdAt: Date;
}

export interface EscrowRecord {
  id: string;
  battleId: string;
  agentIds: string[];
  amounts: Record<string, number>;
  solanaAddress: string;
  state: EscrowState;
  winnerId?: string;
  settledAt?: Date;
  createdAt: Date;
}

export interface Transaction {
  id: string;
  agentId: string;
  type: TransactionType;
  amount: number;
  currency: 'ARENA' | 'SOL' | 'USDC';
  status: TransactionStatus;
  txHash?: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface X402Challenge {
  challengeId: string;
  amount: number;
  currency: string;
  recipient: string;
  expiresAt: number;
  paymentUrl: string;
}
