-- CreateEnum
CREATE TYPE "A2AJobStatus" AS ENUM ('DRAFT', 'POSTING', 'POSTED', 'NEGOTIATING', 'ESCROWED', 'EXECUTING', 'DELIVERED', 'SETTLED', 'REFUNDED', 'CANCELLED', 'DISPUTED', 'FAILED');

-- CreateTable
CREATE TABLE "A2AJob" (
    "id" TEXT NOT NULL,
    "status" "A2AJobStatus" NOT NULL DEFAULT 'DRAFT',
    "creatorAgentId" TEXT NOT NULL,
    "creatorErc8004Id" TEXT NOT NULL,
    "creatorWallet" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "requirementsJson" TEXT NOT NULL,
    "requirementsHash" TEXT NOT NULL,
    "requirementsRootHash" TEXT,
    "targetMetric" TEXT NOT NULL,
    "targetOp" TEXT NOT NULL,
    "targetValue" INTEGER NOT NULL,
    "providerRequirements" JSONB NOT NULL,
    "budgetMinBaseUnits" TEXT NOT NULL,
    "budgetMaxBaseUnits" TEXT NOT NULL,
    "executionWindowSeconds" INTEGER NOT NULL,
    "parseMethod" TEXT NOT NULL,
    "parseConfidence" DOUBLE PRECISION NOT NULL,
    "parseWarnings" JSONB NOT NULL DEFAULT '[]',
    "postTxHash" TEXT,
    "postBlock" BIGINT,
    "lastError" TEXT,
    "onChainAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "A2AJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "A2AJob_status_idx" ON "A2AJob"("status");

-- CreateIndex
CREATE INDEX "A2AJob_gameId_status_idx" ON "A2AJob"("gameId", "status");

-- CreateIndex
CREATE INDEX "A2AJob_creatorAgentId_idx" ON "A2AJob"("creatorAgentId");

-- CreateIndex
CREATE INDEX "A2AJob_requirementsHash_idx" ON "A2AJob"("requirementsHash");
