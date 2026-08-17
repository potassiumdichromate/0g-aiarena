-- CreateEnum
CREATE TYPE "CapabilitySnapshotKind" AS ENUM ('BASELINE', 'FINAL', 'VERIFICATION');

-- AlterTable: real execution tracking for training jobs
ALTER TABLE "TrainingJob" ADD COLUMN     "claimedBy" TEXT,
                          ADD COLUMN     "claimedAt" TIMESTAMP(3),
                          ADD COLUMN     "heartbeatAt" TIMESTAMP(3),
                          ADD COLUMN     "stage" TEXT,
                          ADD COLUMN     "stageStep" INTEGER,
                          ADD COLUMN     "stageTotal" INTEGER,
                          ADD COLUMN     "progress" DOUBLE PRECISION,
                          ADD COLUMN     "currentMetric" JSONB;

-- AlterTable: mark simulator-generated battles so capability/reputation can exclude them
ALTER TABLE "Battle" ADD COLUMN "isSimulated" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "AgentCapabilitySnapshot" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "trainingJobId" TEXT,
    "kind" "CapabilitySnapshotKind" NOT NULL,
    "formulaVersion" TEXT NOT NULL,
    "protocolVersion" TEXT NOT NULL,
    "combatSkill" INTEGER NOT NULL,
    "traits" JSONB NOT NULL,
    "components" JSONB NOT NULL,
    "counters" JSONB NOT NULL,
    "seedRoot" TEXT NOT NULL,
    "seeds" JSONB NOT NULL,
    "difficulties" JSONB NOT NULL,
    "episodesRun" INTEGER NOT NULL,
    "checkpointDigest" TEXT,
    "reportDigest" TEXT NOT NULL,
    "reportRootHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentCapabilitySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TrainingJob_status_heartbeatAt_idx" ON "TrainingJob"("status", "heartbeatAt");

-- CreateIndex
CREATE INDEX "Battle_gameId_isSimulated_idx" ON "Battle"("gameId", "isSimulated");

-- CreateIndex
CREATE INDEX "AgentCapabilitySnapshot_agentId_kind_idx" ON "AgentCapabilitySnapshot"("agentId", "kind");

-- CreateIndex
CREATE INDEX "AgentCapabilitySnapshot_trainingJobId_idx" ON "AgentCapabilitySnapshot"("trainingJobId");

-- CreateIndex
CREATE INDEX "AgentCapabilitySnapshot_createdAt_idx" ON "AgentCapabilitySnapshot"("createdAt");

-- AddForeignKey
ALTER TABLE "AgentCapabilitySnapshot" ADD CONSTRAINT "AgentCapabilitySnapshot_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentCapabilitySnapshot" ADD CONSTRAINT "AgentCapabilitySnapshot_trainingJobId_fkey" FOREIGN KEY ("trainingJobId") REFERENCES "TrainingJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;
