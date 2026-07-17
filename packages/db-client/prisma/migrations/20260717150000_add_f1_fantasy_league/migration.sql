-- CreateTable
CREATE TABLE "F1FantasyTeam" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "season" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "constructorId" TEXT NOT NULL,
    "reasoning" TEXT,
    "totalPoints" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "F1FantasyTeam_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "F1FantasyTeam_agentId_season_key" ON "F1FantasyTeam"("agentId", "season");

-- CreateIndex
CREATE INDEX "F1FantasyTeam_season_totalPoints_idx" ON "F1FantasyTeam"("season", "totalPoints");

-- CreateTable
CREATE TABLE "F1RaceClassification" (
    "id" TEXT NOT NULL,
    "raceId" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "position" INTEGER,
    "points" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "fastestLap" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "F1RaceClassification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "F1RaceClassification_raceId_driverId_key" ON "F1RaceClassification"("raceId", "driverId");

-- CreateIndex
CREATE INDEX "F1RaceClassification_raceId_idx" ON "F1RaceClassification"("raceId");

-- CreateTable
CREATE TABLE "F1FantasyScore" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "raceId" TEXT NOT NULL,
    "pointsEarned" DOUBLE PRECISION NOT NULL,
    "breakdown" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "F1FantasyScore_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "F1FantasyScore_teamId_raceId_key" ON "F1FantasyScore"("teamId", "raceId");

-- AddForeignKey
ALTER TABLE "F1FantasyTeam" ADD CONSTRAINT "F1FantasyTeam_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "F1Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "F1FantasyTeam" ADD CONSTRAINT "F1FantasyTeam_constructorId_fkey" FOREIGN KEY ("constructorId") REFERENCES "F1Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "F1RaceClassification" ADD CONSTRAINT "F1RaceClassification_raceId_fkey" FOREIGN KEY ("raceId") REFERENCES "F1Race"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "F1RaceClassification" ADD CONSTRAINT "F1RaceClassification_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "F1Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "F1FantasyScore" ADD CONSTRAINT "F1FantasyScore_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "F1FantasyTeam"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
