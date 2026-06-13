import {
  PrismaClient,
  Prisma,
  LeagueSeason,
  LeagueMatch,
  LeaguePrediction,
  LeagueBattle,
  LeagueRivalry,
  LeagueAgentSeasonStats,
  LeagueUserProfile,
  LeagueMoment,
  LeagueWeeklySnapshot,
  LeagueSettlementLog,
  LeagueTribe,
  LeagueMatchStatus,
  LeagueStage,
  PredictionStatus,
  LeagueBattleStatus,
} from '@prisma/client';

export class LeagueRepository {
  constructor(private readonly db: PrismaClient) {}

  // ===== Season =====

  async getActiveSeason(): Promise<LeagueSeason | null> {
    return this.db.leagueSeason.findFirst({ where: { isActive: true }, orderBy: { startsAt: 'desc' } });
  }

  async getSeasonById(id: string): Promise<LeagueSeason | null> {
    return this.db.leagueSeason.findUnique({ where: { id } });
  }

  async getSeasonBySlug(slug: string): Promise<LeagueSeason | null> {
    return this.db.leagueSeason.findUnique({ where: { slug } });
  }

  async createSeason(data: Prisma.LeagueSeasonCreateInput): Promise<LeagueSeason> {
    return this.db.leagueSeason.create({ data });
  }

  // ===== Matches =====

  async findMatchById(id: string): Promise<LeagueMatch | null> {
    return this.db.leagueMatch.findUnique({ where: { id } });
  }

  async findMatchByProviderId(seasonId: string, providerId: string): Promise<LeagueMatch | null> {
    return this.db.leagueMatch.findUnique({ where: { seasonId_providerId: { seasonId, providerId } } });
  }

  /** Schedule sync (§8.3) — insert-or-update by (seasonId, providerId). */
  async upsertMatch(
    seasonId: string,
    providerId: string,
    create: Omit<Prisma.LeagueMatchCreateInput, 'season' | 'providerId'>,
    update: Prisma.LeagueMatchUpdateInput,
  ): Promise<LeagueMatch> {
    return this.db.leagueMatch.upsert({
      where: { seasonId_providerId: { seasonId, providerId } },
      create: { ...create, providerId, season: { connect: { id: seasonId } } },
      update,
    });
  }

  async listMatches(params: {
    seasonId: string;
    status?: LeagueMatchStatus;
    stage?: LeagueStage;
    from?: Date;
    to?: Date;
    page?: number;
    limit?: number;
  }): Promise<{ matches: LeagueMatch[]; total: number }> {
    const { seasonId, status, stage, from, to, page = 1, limit = 20 } = params;
    const where: Prisma.LeagueMatchWhereInput = {
      seasonId,
      ...(status && { status }),
      ...(stage && { stage }),
      ...((from || to) && { kickoffAt: { ...(from && { gte: from }), ...(to && { lte: to }) } }),
    };
    const [matches, total] = await Promise.all([
      this.db.leagueMatch.findMany({ where, skip: (page - 1) * limit, take: limit, orderBy: { kickoffAt: 'asc' } }),
      this.db.leagueMatch.count({ where }),
    ]);
    return { matches, total };
  }

  /** §10.1 — matches whose kickoff has passed but are not yet FINISHED/CANCELLED. */
  async listSettlementCandidates(now: Date = new Date()): Promise<Pick<LeagueMatch, 'id' | 'providerId' | 'resultVersion' | 'seasonId'>[]> {
    return this.db.leagueMatch.findMany({
      where: { status: { in: ['SCHEDULED', 'LIVE'] }, kickoffAt: { lte: now } },
      select: { id: true, providerId: true, resultVersion: true, seasonId: true },
    });
  }

  /** §6.2 pre-gen window — matches crossing the T-24h mark with no full prediction set yet. */
  async listMatchesInPreGenWindow(seasonId: string, from: Date, to: Date): Promise<LeagueMatch[]> {
    return this.db.leagueMatch.findMany({
      where: { seasonId, status: 'SCHEDULED', kickoffAt: { gte: from, lte: to } },
    });
  }

  async updateMatch(id: string, data: Prisma.LeagueMatchUpdateInput): Promise<LeagueMatch> {
    return this.db.leagueMatch.update({ where: { id }, data });
  }

  // ===== Predictions =====

  async findPrediction(matchId: string, agentId: string): Promise<LeaguePrediction | null> {
    return this.db.leaguePrediction.findUnique({ where: { matchId_agentId: { matchId, agentId } } });
  }

  async createPrediction(data: Prisma.LeaguePredictionCreateInput): Promise<LeaguePrediction> {
    return this.db.leaguePrediction.create({ data });
  }

  async updatePrediction(id: string, data: Prisma.LeaguePredictionUpdateInput): Promise<LeaguePrediction> {
    return this.db.leaguePrediction.update({ where: { id }, data });
  }

  /** §6.5 — user override of a PENDING prediction. */
  async overridePrediction(matchId: string, agentId: string, data: Prisma.LeaguePredictionUpdateInput): Promise<LeaguePrediction> {
    return this.db.leaguePrediction.update({
      where: { matchId_agentId: { matchId, agentId } },
      data: { ...data, source: 'USER_OVERRIDE' },
    });
  }

  async listPredictionsByMatch(matchId: string, status?: PredictionStatus): Promise<LeaguePrediction[]> {
    return this.db.leaguePrediction.findMany({ where: { matchId, ...(status && { status }) } });
  }

  async listPredictionsByAgent(
    agentId: string,
    params: { status?: PredictionStatus; page?: number; limit?: number } = {},
  ): Promise<{ predictions: LeaguePrediction[]; total: number }> {
    const { status, page = 1, limit = 20 } = params;
    const where: Prisma.LeaguePredictionWhereInput = { agentId, ...(status && { status }) };
    const [predictions, total] = await Promise.all([
      this.db.leaguePrediction.findMany({ where, skip: (page - 1) * limit, take: limit, orderBy: { createdAt: 'desc' } }),
      this.db.leaguePrediction.count({ where }),
    ]);
    return { predictions, total };
  }

  /**
   * Lock-at-kickoff sweep (§6.4) — claim-based conditional UPDATE, no
   * separate find-then-update race. Returns the number of rows locked.
   */
  async lockDuePredictions(): Promise<number> {
    return this.db.$executeRaw`
      UPDATE "LeaguePrediction"
      SET status = 'LOCKED', "lockedAt" = now()
      WHERE status = 'PENDING'
        AND "matchId" IN (
          SELECT id FROM "LeagueMatch"
          WHERE status IN ('SCHEDULED', 'LIVE') AND "kickoffAt" <= now()
        )
    `;
  }

  /**
   * §10.2 step 2 — claim every LOCKED prediction for a match in one
   * statement. Returns only the rows THIS call is responsible for settling;
   * a repeated call for an already-settled match returns an empty array.
   */
  async claimPredictionsForSettlement(matchId: string, resultVersion: number): Promise<LeaguePrediction[]> {
    return this.db.$queryRaw<LeaguePrediction[]>`
      UPDATE "LeaguePrediction"
      SET status = 'SETTLED', "settledAt" = now(), "settlementVersion" = ${resultVersion}
      WHERE "matchId" = ${matchId} AND status = 'LOCKED'
      RETURNING *
    `;
  }

  /**
   * §10.3 — re-claim already-SETTLED predictions at `oldVersion` for
   * provider-correction re-scoring.
   */
  async claimPredictionsForResettlement(matchId: string, oldVersion: number, newVersion: number): Promise<LeaguePrediction[]> {
    return this.db.$queryRaw<LeaguePrediction[]>`
      UPDATE "LeaguePrediction"
      SET "settlementVersion" = ${newVersion}
      WHERE "matchId" = ${matchId} AND status = 'SETTLED' AND "settlementVersion" = ${oldVersion}
      RETURNING *
    `;
  }

  /** §10.4 — cancellation voids any non-terminal predictions for the match. */
  async voidPredictionsForMatch(matchId: string): Promise<number> {
    const result = await this.db.leaguePrediction.updateMany({
      where: { matchId, status: { in: ['PENDING', 'LOCKED'] } },
      data: { status: 'VOID' },
    });
    return result.count;
  }

  // ===== Battles =====

  async createBattle(data: Prisma.LeagueBattleCreateInput): Promise<LeagueBattle> {
    return this.db.leagueBattle.create({ data });
  }

  async findBattleById(id: string): Promise<LeagueBattle | null> {
    return this.db.leagueBattle.findUnique({ where: { id } });
  }

  async listBattles(
    params: { status?: LeagueBattleStatus; agentId?: string; matchId?: string; page?: number; limit?: number } = {},
  ): Promise<{ battles: LeagueBattle[]; total: number }> {
    const { status, agentId, matchId, page = 1, limit = 20 } = params;
    const where: Prisma.LeagueBattleWhereInput = {
      ...(status && { status }),
      ...(matchId && { matchId }),
      ...(agentId && { OR: [{ challengerId: agentId }, { opponentId: agentId }] }),
    };
    const [battles, total] = await Promise.all([
      this.db.leagueBattle.findMany({ where, skip: (page - 1) * limit, take: limit, orderBy: { createdAt: 'desc' } }),
      this.db.leagueBattle.count({ where }),
    ]);
    return { battles, total };
  }

  /** §9.5 anti-farm — daily creation cap per challenger. */
  async countBattlesCreatedSince(challengerIds: string[], since: Date): Promise<number> {
    return this.db.leagueBattle.count({ where: { challengerId: { in: challengerIds }, createdAt: { gte: since } } });
  }

  /** §9.5 anti-farm — daily acceptance cap per opponent. */
  async countBattlesAcceptedSince(opponentIds: string[], since: Date): Promise<number> {
    return this.db.leagueBattle.count({
      where: { opponentId: { in: opponentIds }, status: { not: 'PENDING' }, acceptedAt: { gte: since } },
    });
  }

  /**
   * Claim-based status transition — returns the updated row only if the
   * current status matched `fromStatus`; returns null if another caller
   * already transitioned it (idempotency guard, §17.4).
   */
  async transitionBattleStatus(
    id: string,
    fromStatus: LeagueBattleStatus,
    toStatus: LeagueBattleStatus,
    data: Prisma.LeagueBattleUpdateInput = {},
  ): Promise<LeagueBattle | null> {
    const result = await this.db.leagueBattle.updateMany({
      where: { id, status: fromStatus },
      data: { ...data, status: toStatus },
    });
    if (result.count === 0) return null;
    return this.db.leagueBattle.findUnique({ where: { id } });
  }

  /** §10.2 step 5 — battles ready to settle once both predictions are SETTLED. */
  async listLockedBattlesForMatch(matchId: string): Promise<LeagueBattle[]> {
    return this.db.leagueBattle.findMany({ where: { matchId, status: 'LOCKED' } });
  }

  /** §9.1 — PENDING battles past their expiry cutoff transition to DECLINED. */
  async expirePendingBattles(cutoff: Date): Promise<number> {
    const result = await this.db.leagueBattle.updateMany({
      where: { status: 'PENDING', createdAt: { lte: cutoff } },
      data: { status: 'DECLINED' },
    });
    return result.count;
  }

  /** §9.5 win-trading detection — recent battles between the same agent pair. */
  async listBattlesBetweenAgents(seasonId: string, agentAId: string, agentBId: string): Promise<LeagueBattle[]> {
    return this.db.leagueBattle.findMany({
      where: {
        seasonId,
        status: 'SETTLED',
        OR: [
          { challengerId: agentAId, opponentId: agentBId },
          { challengerId: agentBId, opponentId: agentAId },
        ],
      },
      orderBy: { settledAt: 'asc' },
    });
  }

  // ===== Rivalries =====

  /**
   * Canonical pairwise row — agentLowId/agentHighId ordered lexicographically
   * so (A,B) and (B,A) always resolve to the same row (§11.1).
   */
  async getOrCreateRivalry(seasonId: string, agentAId: string, agentBId: string): Promise<LeagueRivalry> {
    const [agentLowId, agentHighId] = [agentAId, agentBId].sort();
    return this.db.leagueRivalry.upsert({
      where: { seasonId_agentLowId_agentHighId: { seasonId, agentLowId, agentHighId } },
      create: { seasonId, agentLowId, agentHighId },
      update: {},
    });
  }

  /** §11.1 — records a battle result or a same-match prediction disagreement. */
  async recordRivalryMatchup(
    seasonId: string,
    agentAId: string,
    agentBId: string,
    winnerId: string | null,
    kind: 'battle' | 'disagreement',
  ): Promise<LeagueRivalry> {
    const [agentLowId, agentHighId] = [agentAId, agentBId].sort();
    const lowWon = winnerId === agentLowId;
    const highWon = winnerId === agentHighId;
    return this.db.leagueRivalry.upsert({
      where: { seasonId_agentLowId_agentHighId: { seasonId, agentLowId, agentHighId } },
      create: {
        seasonId,
        agentLowId,
        agentHighId,
        agentLowWins: lowWon ? 1 : 0,
        agentHighWins: highWon ? 1 : 0,
        disagreements: kind === 'disagreement' ? 1 : 0,
        totalMatchups: 1,
        lastMatchupAt: new Date(),
      },
      update: {
        agentLowWins: lowWon ? { increment: 1 } : undefined,
        agentHighWins: highWon ? { increment: 1 } : undefined,
        disagreements: kind === 'disagreement' ? { increment: 1 } : undefined,
        totalMatchups: { increment: 1 },
        lastMatchupAt: new Date(),
      },
    });
  }

  async updateRivalryNarrative(id: string, narrative: string): Promise<LeagueRivalry> {
    return this.db.leagueRivalry.update({ where: { id }, data: { narrative } });
  }

  async listFeaturedRivalries(seasonId: string, limit = 5): Promise<LeagueRivalry[]> {
    return this.db.leagueRivalry.findMany({ where: { seasonId }, orderBy: { totalMatchups: 'desc' }, take: limit });
  }

  /**
   * §13 — win-rate across this agent's "serious" rivalries (totalMatchups >= 3),
   * fed into `computeReputation`'s rivalry bonus. Returns 0 if the agent has
   * no rivalry that has reached the seriousness threshold yet.
   */
  async getSeriousRivalryRate(seasonId: string, agentId: string): Promise<number> {
    const rivalries = await this.db.leagueRivalry.findMany({
      where: {
        seasonId,
        totalMatchups: { gte: 3 },
        OR: [{ agentLowId: agentId }, { agentHighId: agentId }],
      },
    });
    if (rivalries.length === 0) return 0;

    let wins = 0;
    let total = 0;
    for (const r of rivalries) {
      wins += r.agentLowId === agentId ? r.agentLowWins : r.agentHighWins;
      total += r.totalMatchups;
    }
    return total > 0 ? wins / total : 0;
  }

  // ===== Agent season stats =====

  async getAgentStats(seasonId: string, agentId: string): Promise<LeagueAgentSeasonStats | null> {
    return this.db.leagueAgentSeasonStats.findUnique({ where: { seasonId_agentId: { seasonId, agentId } } });
  }

  /** §3.1 enrollment — tribe is fixed at creation and never recomputed. */
  async enrollAgent(seasonId: string, agentId: string, tribe: LeagueTribe): Promise<LeagueAgentSeasonStats> {
    return this.db.leagueAgentSeasonStats.upsert({
      where: { seasonId_agentId: { seasonId, agentId } },
      create: { seasonId, agentId, tribe },
      update: {},
    });
  }

  async updateAgentStats(seasonId: string, agentId: string, data: Prisma.LeagueAgentSeasonStatsUpdateInput): Promise<LeagueAgentSeasonStats> {
    return this.db.leagueAgentSeasonStats.update({ where: { seasonId_agentId: { seasonId, agentId } }, data });
  }

  /** §14.4 Postgres fallback / rebuild source for the reputation leaderboard. */
  async getLeaderboard(seasonId: string, params: { tribe?: LeagueTribe; limit?: number } = {}): Promise<LeagueAgentSeasonStats[]> {
    const { tribe, limit = 50 } = params;
    return this.db.leagueAgentSeasonStats.findMany({
      where: { seasonId, ...(tribe && { tribe }) },
      orderBy: { reputation: 'desc' },
      take: limit,
    });
  }

  // ===== User profile (KP + factions) =====

  async getUserProfile(userId: string): Promise<LeagueUserProfile | null> {
    return this.db.leagueUserProfile.findUnique({ where: { userId } });
  }

  async getOrCreateUserProfile(userId: string): Promise<LeagueUserProfile> {
    return this.db.leagueUserProfile.upsert({ where: { userId }, create: { userId }, update: {} });
  }

  /**
   * §12.1 — join/switch faction; cooldown enforced by the caller
   * (config.faction.switchCooldownDays). `isFirstJoin` mirrors the
   * `profile.factionId ? profile.factionJoinedAt : new Date()` branch in the
   * §12.1 snippet — `factionJoinedAt` is set once and preserved across switches.
   */
  async setFaction(userId: string, factionId: LeagueTribe, isFirstJoin: boolean): Promise<LeagueUserProfile> {
    return this.db.leagueUserProfile.upsert({
      where: { userId },
      create: { userId, factionId, factionJoinedAt: new Date(), lastFactionSwitchAt: new Date() },
      update: {
        factionId,
        lastFactionSwitchAt: new Date(),
        ...(isFirstJoin && { factionJoinedAt: new Date() }),
      },
    });
  }

  /**
   * §5.7 KP ledger credit. The unique constraint on (refType, refId, reason)
   * is the idempotency boundary — a duplicate call throws P2002, which the
   * caller should treat as "already credited", not an error.
   */
  async creditKp(userId: string, amount: number, reason: string, refType: string, refId: string): Promise<LeagueUserProfile> {
    return this.db.$transaction(async (tx) => {
      const profile = await tx.leagueUserProfile.upsert({
        where: { userId },
        create: { userId, kpBalance: amount, kpWeekly: amount },
        update: { kpBalance: { increment: amount }, kpWeekly: { increment: amount } },
      });
      await tx.leagueKpLedger.create({
        data: { userId, amount, reason, refType, refId, balanceAfter: profile.kpBalance },
      });
      return profile;
    });
  }

  /** §14.3 weekly reset — Sunday 00:00 UTC, called after snapshotting. */
  async resetWeeklyKp(weekStartAt: Date): Promise<number> {
    const result = await this.db.leagueUserProfile.updateMany({ data: { kpWeekly: 0, weekStartAt } });
    return result.count;
  }

  async getKpLeaderboard(params: { scope?: 'weekly' | 'allTime'; limit?: number } = {}): Promise<LeagueUserProfile[]> {
    const { scope = 'weekly', limit = 50 } = params;
    return this.db.leagueUserProfile.findMany({
      orderBy: scope === 'weekly' ? { kpWeekly: 'desc' } : { kpBalance: 'desc' },
      take: limit,
    });
  }

  // ===== KULT Moments =====

  /**
   * §13.1 — idempotent create via the `idempotencyKey` unique constraint.
   * A duplicate call (settlement retry) returns null instead of throwing.
   */
  async createMoment(data: Prisma.LeagueMomentCreateInput): Promise<LeagueMoment | null> {
    try {
      return await this.db.leagueMoment.create({ data });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return null;
      throw err;
    }
  }

  async listMoments(seasonId: string, limit = 20): Promise<LeagueMoment[]> {
    return this.db.leagueMoment.findMany({ where: { seasonId }, orderBy: { createdAt: 'desc' }, take: limit });
  }

  // ===== Weekly snapshots =====

  async createWeeklySnapshot(data: Prisma.LeagueWeeklySnapshotCreateInput): Promise<LeagueWeeklySnapshot> {
    return this.db.leagueWeeklySnapshot.create({ data });
  }

  async getLatestWeeklySnapshot(seasonId: string, scope: string): Promise<LeagueWeeklySnapshot | null> {
    return this.db.leagueWeeklySnapshot.findFirst({ where: { seasonId, scope }, orderBy: { weekStartAt: 'desc' } });
  }

  // ===== Settlement log (§10.2 step 7 / §10.3 audit trail) =====

  async upsertSettlementLog(
    matchId: string,
    data: { resultHash: string; version: number; status: string; errorDetail?: string },
  ): Promise<LeagueSettlementLog> {
    return this.db.leagueSettlementLog.upsert({
      where: { matchId },
      create: { matchId, ...data },
      update: { ...data, processedAt: new Date() },
    });
  }

  async getSettlementLog(matchId: string): Promise<LeagueSettlementLog | null> {
    return this.db.leagueSettlementLog.findUnique({ where: { matchId } });
  }
}
