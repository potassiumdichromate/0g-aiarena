-- CreateTable
CREATE TABLE "F1RaceResult" (
    "id" TEXT NOT NULL,
    "season" INTEGER NOT NULL,
    "round" INTEGER NOT NULL,
    "raceName" TEXT NOT NULL,
    "circuitId" TEXT NOT NULL,
    "raceDate" TIMESTAMP(3) NOT NULL,
    "driverCode" TEXT NOT NULL,
    "driverAbbr" TEXT,
    "driverName" TEXT NOT NULL,
    "constructorId" TEXT NOT NULL,
    "constructorName" TEXT NOT NULL,
    "grid" INTEGER,
    "finishPosition" INTEGER,
    "points" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL,
    "laps" INTEGER,
    "fastestLapRank" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "F1RaceResult_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "F1RaceResult_driverCode_season_idx" ON "F1RaceResult"("driverCode", "season");

-- CreateIndex
CREATE INDEX "F1RaceResult_season_round_idx" ON "F1RaceResult"("season", "round");

-- CreateIndex
CREATE UNIQUE INDEX "F1RaceResult_season_round_driverCode_key" ON "F1RaceResult"("season", "round", "driverCode");

-- CreateTable
CREATE TABLE "F1SeasonStanding" (
    "id" TEXT NOT NULL,
    "season" INTEGER NOT NULL,
    "round" INTEGER NOT NULL,
    "driverCode" TEXT NOT NULL,
    "driverAbbr" TEXT,
    "driverName" TEXT NOT NULL,
    "constructorId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "points" DOUBLE PRECISION NOT NULL,
    "wins" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "F1SeasonStanding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "F1SeasonStanding_driverCode_season_idx" ON "F1SeasonStanding"("driverCode", "season");

-- CreateIndex
CREATE UNIQUE INDEX "F1SeasonStanding_season_round_driverCode_key" ON "F1SeasonStanding"("season", "round", "driverCode");
