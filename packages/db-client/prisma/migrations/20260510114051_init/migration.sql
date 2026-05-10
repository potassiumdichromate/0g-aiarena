-- CreateEnum
CREATE TYPE "ClanType" AS ENUM ('CYBER', 'BIO', 'ARCANE', 'MECH', 'SHADOW');

-- CreateEnum
CREATE TYPE "CombatArchetype" AS ENUM ('BERSERKER', 'TACTICIAN', 'SUPPORT', 'ASSASSIN', 'DEFENDER', 'HYBRID');

-- CreateEnum
CREATE TYPE "EvolutionStage" AS ENUM ('GENESIS', 'AWAKENED', 'ASCENDED', 'LEGENDARY', 'MYTHIC');

-- CreateEnum
CREATE TYPE "BattleMode" AS ENUM ('RANKED', 'CASUAL', 'WAGER', 'TOURNAMENT', 'EXHIBITION');

-- CreateEnum
CREATE TYPE "BattleStatus" AS ENUM ('PENDING', 'INITIALIZING', 'IN_PROGRESS', 'COMPLETED', 'DISPUTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TrainingStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TrainingType" AS ENUM ('BEHAVIOUR_CLONING', 'REINFORCEMENT_LEARNING', 'LORA_FINETUNE');

-- CreateEnum
CREATE TYPE "EscrowState" AS ENUM ('OPEN', 'FUNDED', 'LOCKED', 'SETTLED', 'CANCELLED', 'DISPUTED');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('DEPOSIT', 'WITHDRAWAL', 'BATTLE_WAGER', 'BATTLE_REWARD', 'TOURNAMENT_ENTRY', 'TOURNAMENT_PRIZE', 'STAKE', 'UNSTAKE', 'TRANSFER');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('PENDING', 'CONFIRMED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TournamentStatus" AS ENUM ('REGISTRATION', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "BridgeDepositStatus" AS ENUM ('PENDING', 'CONFIRMED', 'FAILED', 'MANUAL_REVIEW');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "privyUserId" TEXT,
    "username" TEXT,
    "email" TEXT,
    "avatarUrl" TEXT,
    "nonce" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "custodialSolanaAddress" TEXT,
    "custodialSolanaKeyEnc" TEXT,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "clan" "ClanType" NOT NULL,
    "archetype" "CombatArchetype" NOT NULL DEFAULT 'HYBRID',
    "evolutionStage" "EvolutionStage" NOT NULL DEFAULT 'GENESIS',
    "eloRating" INTEGER NOT NULL DEFAULT 1000,
    "wins" INTEGER NOT NULL DEFAULT 0,
    "losses" INTEGER NOT NULL DEFAULT 0,
    "draws" INTEGER NOT NULL DEFAULT 0,
    "inftTokenId" TEXT,
    "activeModelId" TEXT,
    "isRetired" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "traits" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIModel" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "baseModel" TEXT NOT NULL,
    "loraAdapterPath" TEXT,
    "checkpointPath" TEXT,
    "trainingJobId" TEXT,
    "performanceMetrics" JSONB NOT NULL DEFAULT '{}',
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AIModel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Battle" (
    "id" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "mode" "BattleMode" NOT NULL,
    "status" "BattleStatus" NOT NULL DEFAULT 'PENDING',
    "agentIds" TEXT[],
    "config" JSONB NOT NULL,
    "result" JSONB,
    "replayId" TEXT,
    "escrowId" TEXT,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Battle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tournament" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "status" "TournamentStatus" NOT NULL DEFAULT 'REGISTRATION',
    "maxParticipants" INTEGER NOT NULL,
    "entryFee" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "prizePool" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "bracket" JSONB NOT NULL DEFAULT '{}',
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tournament_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentWallet" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "solanaAddress" TEXT NOT NULL,
    "balanceArena" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "balanceSol" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "isFrozen" BOOLEAN NOT NULL DEFAULT false,
    "policy" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrainingJob" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "type" "TrainingType" NOT NULL,
    "status" "TrainingStatus" NOT NULL DEFAULT 'QUEUED',
    "priority" INTEGER NOT NULL DEFAULT 5,
    "config" JSONB NOT NULL,
    "metrics" JSONB NOT NULL DEFAULT '{}',
    "errorLog" TEXT,
    "modelId" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrainingJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentMemory" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "importance" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "accessCount" INTEGER NOT NULL DEFAULT 0,
    "lastAccessed" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "embedding" DOUBLE PRECISION[],
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentMemory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntelligenceLayer" (
    "id" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "actionSpace" JSONB NOT NULL,
    "observationSpace" JSONB NOT NULL,
    "rewardConfig" JSONB NOT NULL,
    "modelConfig" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntelligenceLayer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EscrowRecord" (
    "id" TEXT NOT NULL,
    "battleId" TEXT,
    "tournamentId" TEXT,
    "agentIds" TEXT[],
    "amounts" JSONB NOT NULL,
    "solanaAddress" TEXT NOT NULL,
    "state" "EscrowState" NOT NULL DEFAULT 'OPEN',
    "winnerId" TEXT,
    "txHashes" JSONB NOT NULL DEFAULT '{}',
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EscrowRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "type" "TransactionType" NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "TransactionStatus" NOT NULL DEFAULT 'PENDING',
    "txHash" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StakingRecord" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "stakedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unstakedAt" TIMESTAMP(3),
    "lockPeriod" INTEGER NOT NULL DEFAULT 0,
    "txHash" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "StakingRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaderboardEntry" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "gameId" TEXT,
    "leaderboardId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "eloRating" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeaderboardEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StorageIndex" (
    "id" TEXT NOT NULL,
    "logicalPath" TEXT NOT NULL,
    "rootHash" TEXT NOT NULL,
    "txHash" TEXT,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "uploadedBy" TEXT,
    "tags" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StorageIndex_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BridgeDeposit" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "sourceChain" TEXT NOT NULL,
    "sourceTxHash" TEXT NOT NULL,
    "depositId" TEXT NOT NULL,
    "depositorEvm" TEXT,
    "solanaAddress" TEXT NOT NULL,
    "usdcAmount" TEXT NOT NULL,
    "solanaTxHash" TEXT,
    "status" "BridgeDepositStatus" NOT NULL DEFAULT 'PENDING',
    "flagReason" TEXT,
    "errorMessage" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BridgeDeposit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TreasuryAllocation" (
    "id" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceTxHash" TEXT,
    "totalUsdc" TEXT NOT NULL,
    "reserveUsdc" TEXT NOT NULL,
    "opsUsdc" TEXT NOT NULL,
    "onChainTxHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TreasuryAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReserveRebalance" (
    "id" TEXT NOT NULL,
    "triggerReason" TEXT NOT NULL,
    "usdcBefore" TEXT NOT NULL,
    "usdtBefore" TEXT NOT NULL,
    "usdcAfter" TEXT NOT NULL,
    "usdtAfter" TEXT NOT NULL,
    "txHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReserveRebalance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ZeroGFineTuneJob" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "trainingJobId" TEXT NOT NULL,
    "providerAddress" TEXT NOT NULL,
    "baseModel" TEXT NOT NULL,
    "datasetRootHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SUBMITTED',
    "outputRootHash" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ZeroGFineTuneJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_walletAddress_key" ON "User"("walletAddress");

-- CreateIndex
CREATE UNIQUE INDEX "User_privyUserId_key" ON "User"("privyUserId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_custodialSolanaAddress_key" ON "User"("custodialSolanaAddress");

-- CreateIndex
CREATE INDEX "User_walletAddress_idx" ON "User"("walletAddress");

-- CreateIndex
CREATE INDEX "User_privyUserId_idx" ON "User"("privyUserId");

-- CreateIndex
CREATE INDEX "Agent_userId_idx" ON "Agent"("userId");

-- CreateIndex
CREATE INDEX "Agent_eloRating_idx" ON "Agent"("eloRating");

-- CreateIndex
CREATE INDEX "Agent_clan_idx" ON "Agent"("clan");

-- CreateIndex
CREATE INDEX "AIModel_agentId_idx" ON "AIModel"("agentId");

-- CreateIndex
CREATE INDEX "AIModel_isActive_idx" ON "AIModel"("isActive");

-- CreateIndex
CREATE INDEX "Battle_status_idx" ON "Battle"("status");

-- CreateIndex
CREATE INDEX "Battle_gameId_idx" ON "Battle"("gameId");

-- CreateIndex
CREATE INDEX "Battle_createdAt_idx" ON "Battle"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentWallet_agentId_key" ON "AgentWallet"("agentId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentWallet_solanaAddress_key" ON "AgentWallet"("solanaAddress");

-- CreateIndex
CREATE INDEX "AgentWallet_solanaAddress_idx" ON "AgentWallet"("solanaAddress");

-- CreateIndex
CREATE INDEX "TrainingJob_agentId_idx" ON "TrainingJob"("agentId");

-- CreateIndex
CREATE INDEX "TrainingJob_status_idx" ON "TrainingJob"("status");

-- CreateIndex
CREATE INDEX "TrainingJob_priority_idx" ON "TrainingJob"("priority");

-- CreateIndex
CREATE INDEX "AgentMemory_agentId_idx" ON "AgentMemory"("agentId");

-- CreateIndex
CREATE INDEX "AgentMemory_type_idx" ON "AgentMemory"("type");

-- CreateIndex
CREATE INDEX "AgentMemory_importance_idx" ON "AgentMemory"("importance");

-- CreateIndex
CREATE UNIQUE INDEX "IntelligenceLayer_gameId_key" ON "IntelligenceLayer"("gameId");

-- CreateIndex
CREATE UNIQUE INDEX "EscrowRecord_solanaAddress_key" ON "EscrowRecord"("solanaAddress");

-- CreateIndex
CREATE INDEX "EscrowRecord_state_idx" ON "EscrowRecord"("state");

-- CreateIndex
CREATE INDEX "EscrowRecord_solanaAddress_idx" ON "EscrowRecord"("solanaAddress");

-- CreateIndex
CREATE INDEX "LedgerEntry_walletId_idx" ON "LedgerEntry"("walletId");

-- CreateIndex
CREATE INDEX "LedgerEntry_status_idx" ON "LedgerEntry"("status");

-- CreateIndex
CREATE INDEX "LedgerEntry_createdAt_idx" ON "LedgerEntry"("createdAt");

-- CreateIndex
CREATE INDEX "StakingRecord_agentId_idx" ON "StakingRecord"("agentId");

-- CreateIndex
CREATE INDEX "StakingRecord_isActive_idx" ON "StakingRecord"("isActive");

-- CreateIndex
CREATE INDEX "LeaderboardEntry_leaderboardId_rank_idx" ON "LeaderboardEntry"("leaderboardId", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "LeaderboardEntry_leaderboardId_agentId_key" ON "LeaderboardEntry"("leaderboardId", "agentId");

-- CreateIndex
CREATE UNIQUE INDEX "StorageIndex_logicalPath_key" ON "StorageIndex"("logicalPath");

-- CreateIndex
CREATE INDEX "StorageIndex_rootHash_idx" ON "StorageIndex"("rootHash");

-- CreateIndex
CREATE INDEX "StorageIndex_uploadedBy_idx" ON "StorageIndex"("uploadedBy");

-- CreateIndex
CREATE INDEX "BridgeDeposit_solanaAddress_idx" ON "BridgeDeposit"("solanaAddress");

-- CreateIndex
CREATE INDEX "BridgeDeposit_status_idx" ON "BridgeDeposit"("status");

-- CreateIndex
CREATE INDEX "BridgeDeposit_userId_idx" ON "BridgeDeposit"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "BridgeDeposit_sourceTxHash_sourceChain_key" ON "BridgeDeposit"("sourceTxHash", "sourceChain");

-- CreateIndex
CREATE INDEX "TreasuryAllocation_sourceType_idx" ON "TreasuryAllocation"("sourceType");

-- CreateIndex
CREATE INDEX "TreasuryAllocation_createdAt_idx" ON "TreasuryAllocation"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ZeroGFineTuneJob_trainingJobId_key" ON "ZeroGFineTuneJob"("trainingJobId");

-- CreateIndex
CREATE INDEX "ZeroGFineTuneJob_agentId_idx" ON "ZeroGFineTuneJob"("agentId");

-- CreateIndex
CREATE INDEX "ZeroGFineTuneJob_status_idx" ON "ZeroGFineTuneJob"("status");

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIModel" ADD CONSTRAINT "AIModel_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Battle" ADD CONSTRAINT "Battle_escrowId_fkey" FOREIGN KEY ("escrowId") REFERENCES "EscrowRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentWallet" ADD CONSTRAINT "AgentWallet_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingJob" ADD CONSTRAINT "TrainingJob_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentMemory" ADD CONSTRAINT "AgentMemory_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "AgentWallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StakingRecord" ADD CONSTRAINT "StakingRecord_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaderboardEntry" ADD CONSTRAINT "LeaderboardEntry_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BridgeDeposit" ADD CONSTRAINT "BridgeDeposit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

