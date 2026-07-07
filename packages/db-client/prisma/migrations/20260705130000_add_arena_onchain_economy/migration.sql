-- CreateEnum
CREATE TYPE "ArenaEventName" AS ENUM ('AGENT_REWARD_GRANTED', 'REWARD_GRANTED', 'DAILY_REWARD_CLAIMED', 'REFERRAL_REWARD_GRANTED', 'TOURNAMENT_REWARD_GRANTED', 'MATCH_CREATED', 'MATCH_JOINED', 'MATCH_STARTED', 'MATCH_SETTLED', 'MATCH_CANCELLED', 'COMMISSION_COLLECTED', 'TREASURY_UPDATED');

-- CreateTable
CREATE TABLE "OnChainEvent" (
    "id" TEXT NOT NULL,
    "eventName" "ArenaEventName" NOT NULL,
    "contractAddress" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "playerAddress" TEXT,
    "args" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OnChainEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OnChainEvent_playerAddress_idx" ON "OnChainEvent"("playerAddress");

-- CreateIndex
CREATE INDEX "OnChainEvent_eventName_idx" ON "OnChainEvent"("eventName");

-- CreateIndex
CREATE INDEX "OnChainEvent_blockNumber_idx" ON "OnChainEvent"("blockNumber");

-- CreateIndex
CREATE UNIQUE INDEX "OnChainEvent_txHash_logIndex_key" ON "OnChainEvent"("txHash", "logIndex");

-- CreateTable
CREATE TABLE "TreasurySnapshot" (
    "id" TEXT NOT NULL,
    "balance" TEXT NOT NULL,
    "totalDistributed" TEXT NOT NULL,
    "totalCommissions" TEXT NOT NULL,
    "totalRewardsPaid" TEXT NOT NULL,
    "circulatingSupply" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TreasurySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TreasurySnapshot_capturedAt_idx" ON "TreasurySnapshot"("capturedAt");
