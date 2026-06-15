-- CreateEnum
CREATE TYPE "LeagueTribe" AS ENUM ('NEXUS_01', 'SHADOW_9', 'ATHENA', 'VOIDWALKER');

-- CreateEnum
CREATE TYPE "LeagueStage" AS ENUM ('GROUP', 'ROUND_OF_32', 'ROUND_OF_16', 'QUARTER_FINAL', 'SEMI_FINAL', 'THIRD_PLACE', 'FINAL');

-- CreateEnum
CREATE TYPE "LeagueMatchStatus" AS ENUM ('SCHEDULED', 'LIVE', 'FINISHED', 'POSTPONED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PredictionOutcome" AS ENUM ('HOME', 'DRAW', 'AWAY');

-- CreateEnum
CREATE TYPE "ConvictionLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "PredictionStatus" AS ENUM ('PENDING', 'LOCKED', 'SETTLED', 'VOID');

-- CreateEnum
CREATE TYPE "PredictionSource" AS ENUM ('AI', 'FALLBACK', 'USER_OVERRIDE');

-- CreateEnum
CREATE TYPE "LeagueBattleStatus" AS ENUM ('PENDING', 'ACCEPTED', 'LOCKED', 'SETTLED', 'VOID', 'DECLINED');

-- CreateEnum
CREATE TYPE "LeagueMomentType" AS ENUM ('VINDICATION', 'ROAST', 'UPSET', 'RIVALRY', 'STREAK', 'ASCENSION', 'EVOLUTION', 'FACTION');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TransactionType" ADD VALUE 'LEAGUE_PREDICTION_REWARD';
ALTER TYPE "TransactionType" ADD VALUE 'LEAGUE_BATTLE_WAGER';
ALTER TYPE "TransactionType" ADD VALUE 'LEAGUE_BATTLE_REWARD';
ALTER TYPE "TransactionType" ADD VALUE 'LEAGUE_BATTLE_REFUND';
ALTER TYPE "TransactionType" ADD VALUE 'STARTER_ALLOCATION';

-- AlterTable
ALTER TABLE "EscrowRecord" ADD COLUMN     "leagueBattleId" TEXT;

-- CreateTable
CREATE TABLE "LeagueSeason" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "providerId" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeagueSeason_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeagueMatch" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "stage" "LeagueStage" NOT NULL,
    "matchday" INTEGER,
    "homeTeam" TEXT NOT NULL,
    "awayTeam" TEXT NOT NULL,
    "venue" TEXT,
    "kickoffAt" TIMESTAMP(3) NOT NULL,
    "status" "LeagueMatchStatus" NOT NULL DEFAULT 'SCHEDULED',
    "result" JSONB,
    "resultVersion" INTEGER NOT NULL DEFAULT 0,
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeagueMatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaguePrediction" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "winner" "PredictionOutcome" NOT NULL,
    "scoreHome" INTEGER NOT NULL,
    "scoreAway" INTEGER NOT NULL,
    "conviction" "ConvictionLevel" NOT NULL DEFAULT 'LOW',
    "reasoning" TEXT,
    "source" "PredictionSource" NOT NULL DEFAULT 'AI',
    "status" "PredictionStatus" NOT NULL DEFAULT 'PENDING',
    "isCorrectWinner" BOOLEAN,
    "isExactScore" BOOLEAN,
    "isUpset" BOOLEAN,
    "basePoints" INTEGER,
    "arenaAwarded" DOUBLE PRECISION,
    "kpAwarded" INTEGER,
    "lockedAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "settlementVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeaguePrediction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeagueBattle" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "challengerId" TEXT NOT NULL,
    "opponentId" TEXT NOT NULL,
    "stakeArena" DOUBLE PRECISION NOT NULL,
    "status" "LeagueBattleStatus" NOT NULL DEFAULT 'PENDING',
    "escrowId" TEXT,
    "winnerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "LeagueBattle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeagueRivalry" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "agentLowId" TEXT NOT NULL,
    "agentHighId" TEXT NOT NULL,
    "agentLowWins" INTEGER NOT NULL DEFAULT 0,
    "agentHighWins" INTEGER NOT NULL DEFAULT 0,
    "disagreements" INTEGER NOT NULL DEFAULT 0,
    "totalMatchups" INTEGER NOT NULL DEFAULT 0,
    "lastMatchupAt" TIMESTAMP(3),
    "narrative" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeagueRivalry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeagueAgentSeasonStats" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "tribe" "LeagueTribe" NOT NULL,
    "reputation" DOUBLE PRECISION NOT NULL DEFAULT 1500,
    "reputationProvisional" BOOLEAN NOT NULL DEFAULT true,
    "predictionsTotal" INTEGER NOT NULL DEFAULT 0,
    "correctWinnerCount" INTEGER NOT NULL DEFAULT 0,
    "exactScoreCount" INTEGER NOT NULL DEFAULT 0,
    "currentStreak" INTEGER NOT NULL DEFAULT 0,
    "bestStreak" INTEGER NOT NULL DEFAULT 0,
    "battleWins" INTEGER NOT NULL DEFAULT 0,
    "battleLosses" INTEGER NOT NULL DEFAULT 0,
    "arenaEarnedSeason" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avgConvictionCorrect" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "avgConvictionWrong" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeagueAgentSeasonStats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeagueUserProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "factionId" "LeagueTribe",
    "factionJoinedAt" TIMESTAMP(3),
    "lastFactionSwitchAt" TIMESTAMP(3),
    "kpBalance" INTEGER NOT NULL DEFAULT 0,
    "kpWeekly" INTEGER NOT NULL DEFAULT 0,
    "weekStartAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dayStreak" INTEGER NOT NULL DEFAULT 0,
    "lastActiveDate" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeagueUserProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeagueKpLedger" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "refType" TEXT NOT NULL,
    "refId" TEXT NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeagueKpLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeagueMoment" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "type" "LeagueMomentType" NOT NULL,
    "agentId" TEXT,
    "matchId" TEXT,
    "text" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeagueMoment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeagueWeeklySnapshot" (
    "id" TEXT NOT NULL,
    "seasonId" TEXT NOT NULL,
    "weekStartAt" TIMESTAMP(3) NOT NULL,
    "scope" TEXT NOT NULL,
    "rankings" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeagueWeeklySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeagueSettlementLog" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "resultHash" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "errorDetail" TEXT,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeagueSettlementLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LeagueSeason_slug_key" ON "LeagueSeason"("slug");

-- CreateIndex
CREATE INDEX "LeagueSeason_isActive_idx" ON "LeagueSeason"("isActive");

-- CreateIndex
CREATE INDEX "LeagueMatch_status_kickoffAt_idx" ON "LeagueMatch"("status", "kickoffAt");

-- CreateIndex
CREATE INDEX "LeagueMatch_seasonId_stage_idx" ON "LeagueMatch"("seasonId", "stage");

-- CreateIndex
CREATE UNIQUE INDEX "LeagueMatch_seasonId_providerId_key" ON "LeagueMatch"("seasonId", "providerId");

-- CreateIndex
CREATE INDEX "LeaguePrediction_agentId_status_idx" ON "LeaguePrediction"("agentId", "status");

-- CreateIndex
CREATE INDEX "LeaguePrediction_matchId_status_idx" ON "LeaguePrediction"("matchId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "LeaguePrediction_matchId_agentId_key" ON "LeaguePrediction"("matchId", "agentId");

-- CreateIndex
CREATE UNIQUE INDEX "LeagueBattle_escrowId_key" ON "LeagueBattle"("escrowId");

-- CreateIndex
CREATE INDEX "LeagueBattle_matchId_status_idx" ON "LeagueBattle"("matchId", "status");

-- CreateIndex
CREATE INDEX "LeagueBattle_challengerId_idx" ON "LeagueBattle"("challengerId");

-- CreateIndex
CREATE INDEX "LeagueBattle_opponentId_idx" ON "LeagueBattle"("opponentId");

-- CreateIndex
CREATE UNIQUE INDEX "LeagueRivalry_seasonId_agentLowId_agentHighId_key" ON "LeagueRivalry"("seasonId", "agentLowId", "agentHighId");

-- CreateIndex
CREATE INDEX "LeagueAgentSeasonStats_seasonId_reputation_idx" ON "LeagueAgentSeasonStats"("seasonId", "reputation");

-- CreateIndex
CREATE INDEX "LeagueAgentSeasonStats_seasonId_tribe_reputation_idx" ON "LeagueAgentSeasonStats"("seasonId", "tribe", "reputation");

-- CreateIndex
CREATE UNIQUE INDEX "LeagueAgentSeasonStats_seasonId_agentId_key" ON "LeagueAgentSeasonStats"("seasonId", "agentId");

-- CreateIndex
CREATE UNIQUE INDEX "LeagueUserProfile_userId_key" ON "LeagueUserProfile"("userId");

-- CreateIndex
CREATE INDEX "LeagueKpLedger_userId_createdAt_idx" ON "LeagueKpLedger"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "LeagueKpLedger_refType_refId_reason_key" ON "LeagueKpLedger"("refType", "refId", "reason");

-- CreateIndex
CREATE UNIQUE INDEX "LeagueMoment_idempotencyKey_key" ON "LeagueMoment"("idempotencyKey");

-- CreateIndex
CREATE INDEX "LeagueMoment_seasonId_createdAt_idx" ON "LeagueMoment"("seasonId", "createdAt");

-- CreateIndex
CREATE INDEX "LeagueMoment_agentId_idx" ON "LeagueMoment"("agentId");

-- CreateIndex
CREATE UNIQUE INDEX "LeagueWeeklySnapshot_seasonId_weekStartAt_scope_key" ON "LeagueWeeklySnapshot"("seasonId", "weekStartAt", "scope");

-- CreateIndex
CREATE UNIQUE INDEX "LeagueSettlementLog_matchId_key" ON "LeagueSettlementLog"("matchId");

-- CreateIndex
CREATE UNIQUE INDEX "EscrowRecord_leagueBattleId_key" ON "EscrowRecord"("leagueBattleId");

-- AddForeignKey
ALTER TABLE "LeagueMatch" ADD CONSTRAINT "LeagueMatch_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "LeagueSeason"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaguePrediction" ADD CONSTRAINT "LeaguePrediction_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "LeagueMatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeagueBattle" ADD CONSTRAINT "LeagueBattle_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "LeagueMatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeagueBattle" ADD CONSTRAINT "LeagueBattle_escrowId_fkey" FOREIGN KEY ("escrowId") REFERENCES "EscrowRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeagueAgentSeasonStats" ADD CONSTRAINT "LeagueAgentSeasonStats_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "LeagueSeason"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeagueMoment" ADD CONSTRAINT "LeagueMoment_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "LeagueMatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeagueWeeklySnapshot" ADD CONSTRAINT "LeagueWeeklySnapshot_seasonId_fkey" FOREIGN KEY ("seasonId") REFERENCES "LeagueSeason"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

