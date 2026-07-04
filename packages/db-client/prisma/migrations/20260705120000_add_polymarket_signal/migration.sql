-- CreateEnum
CREATE TYPE "PolymarketSignalOutcome" AS ENUM ('YES', 'NO');

-- CreateTable
CREATE TABLE "PolymarketSignal" (
    "id" TEXT NOT NULL,
    "marketId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "signal" "PolymarketSignalOutcome" NOT NULL,
    "confidence" "ConvictionLevel" NOT NULL DEFAULT 'LOW',
    "reasoning" TEXT,
    "source" "PredictionSource" NOT NULL DEFAULT 'AI',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PolymarketSignal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PolymarketSignal_agentId_idx" ON "PolymarketSignal"("agentId");

-- CreateIndex
CREATE INDEX "PolymarketSignal_marketId_idx" ON "PolymarketSignal"("marketId");

-- CreateIndex
CREATE UNIQUE INDEX "PolymarketSignal_marketId_agentId_key" ON "PolymarketSignal"("marketId", "agentId");
