-- CreateEnum
CREATE TYPE "F1PredictionMarket" AS ENUM ('WINNER', 'PODIUM', 'FASTEST_LAP');

-- DropIndex
DROP INDEX "F1Prediction_raceId_agentId_key";

-- AlterTable
ALTER TABLE "F1Prediction" ADD COLUMN "market" "F1PredictionMarket" NOT NULL DEFAULT 'WINNER';

-- CreateIndex
CREATE UNIQUE INDEX "F1Prediction_raceId_agentId_market_key" ON "F1Prediction"("raceId", "agentId", "market");
