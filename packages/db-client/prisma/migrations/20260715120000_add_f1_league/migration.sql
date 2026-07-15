-- CreateEnum
CREATE TYPE "F1RaceStatus" AS ENUM ('SCHEDULED', 'LIVE', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "F1Team" (
    "id" TEXT NOT NULL,
    "providerId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "logo" TEXT,
    "base" TEXT,
    "firstTeamEntry" INTEGER,
    "worldChampionships" INTEGER,
    "chassis" TEXT,
    "engine" TEXT,
    "tyres" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "F1Team_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "F1Team_providerId_key" ON "F1Team"("providerId");

-- CreateTable
CREATE TABLE "F1Driver" (
    "id" TEXT NOT NULL,
    "providerId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "abbr" TEXT,
    "image" TEXT,
    "nationality" TEXT,
    "countryCode" TEXT,
    "birthdate" TIMESTAMP(3),
    "number" INTEGER,
    "podiums" INTEGER,
    "careerPoints" TEXT,
    "currentTeamId" TEXT,
    "teamHistory" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "F1Driver_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "F1Driver_providerId_key" ON "F1Driver"("providerId");

-- CreateIndex
CREATE INDEX "F1Driver_currentTeamId_idx" ON "F1Driver"("currentTeamId");

-- CreateTable
CREATE TABLE "F1Race" (
    "id" TEXT NOT NULL,
    "providerId" INTEGER NOT NULL,
    "grandPrixId" INTEGER NOT NULL,
    "grandPrixName" TEXT NOT NULL,
    "circuitName" TEXT,
    "circuitImage" TEXT,
    "season" INTEGER NOT NULL,
    "sessionType" TEXT NOT NULL,
    "status" "F1RaceStatus" NOT NULL DEFAULT 'SCHEDULED',
    "startsAt" TIMESTAMP(3) NOT NULL,
    "laps" INTEGER,
    "distance" TEXT,
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "F1Race_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "F1Race_providerId_key" ON "F1Race"("providerId");

-- CreateIndex
CREATE INDEX "F1Race_grandPrixId_season_idx" ON "F1Race"("grandPrixId", "season");

-- CreateIndex
CREATE INDEX "F1Race_status_startsAt_idx" ON "F1Race"("status", "startsAt");

-- CreateTable
CREATE TABLE "F1Prediction" (
    "id" TEXT NOT NULL,
    "raceId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "predictedDriverId" TEXT NOT NULL,
    "reasoning" TEXT,
    "isCorrect" BOOLEAN,
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "F1Prediction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "F1Prediction_agentId_idx" ON "F1Prediction"("agentId");

-- CreateIndex
CREATE UNIQUE INDEX "F1Prediction_raceId_agentId_key" ON "F1Prediction"("raceId", "agentId");

-- AddForeignKey
ALTER TABLE "F1Driver" ADD CONSTRAINT "F1Driver_currentTeamId_fkey" FOREIGN KEY ("currentTeamId") REFERENCES "F1Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "F1Prediction" ADD CONSTRAINT "F1Prediction_raceId_fkey" FOREIGN KEY ("raceId") REFERENCES "F1Race"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "F1Prediction" ADD CONSTRAINT "F1Prediction_predictedDriverId_fkey" FOREIGN KEY ("predictedDriverId") REFERENCES "F1Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
