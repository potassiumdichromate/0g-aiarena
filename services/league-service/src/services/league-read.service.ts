import {
  prisma,
  LeagueMatch,
  LeagueMatchStatus,
  LeagueStage,
  LeagueSeason,
  LeaguePrediction,
  LeagueRivalry,
  LeagueTribe,
} from '@ai-arena/db-client';
import { mapAgentToTribe, normalizeTraits } from '@ai-arena/shared-utils';
import { leagueRepo, requireActiveSeason, configFor } from '../lib/season';
import {
  computeConsensus,
  convictionToConfidencePct,
  pickLabel,
  matchResultPickLabel,
  potentialArenaPayout,
  predictionRecord,
  scoreFromResult,
  sumPredictionPool,
} from '../lib/dto';
import { getReputationLeaderboard, getUserGlobalRank, ReputationLeaderboardRow } from '../lib/leaderboard';
import { NotFoundError } from '../lib/errors';
import {
  AgentBetDTO,
  KpLeaderboardRowDTO,
  LeaguePredictionQuestionAgentDTO,
  LeaguePredictionQuestionDTO,
  LineupRowDTO,
  MatchDetailDTO,
  MatchListResultDTO,
  MatchSummaryDTO,
  MeSummaryDTO,
  MomentDTO,
  OpenBattleDTO,
  RecentPickDTO,
  RivalryDTO,
  TodayPredictionDTO,
  UserAgentPickDTO,
} from '../types/dto.types';

class LeagueReadService {
  /** §15.2 — GET /v1/league/me/summary */
  async getMeSummary(userId: string): Promise<MeSummaryDTO> {
    const season = await requireActiveSeason();
    const config = configFor(season);
    const profile = await leagueRepo.getOrCreateUserProfile(userId);
    const globalRank = await getUserGlobalRank(season.id, userId);

    return {
      kpBalance: profile.kpBalance,
      kpWeekly: profile.kpWeekly,
      kpWeeklyTarget: config.kpWeeklyTarget,
      globalRank,
      dayStreak: profile.dayStreak,
      factionId: profile.factionId,
    };
  }

  /** §15.1 — GET /v1/league/matches */
  async listMatches(params: {
    status?: LeagueMatchStatus;
    stage?: LeagueStage;
    page?: number;
    limit?: number;
  }): Promise<MatchListResultDTO> {
    const season = await requireActiveSeason();
    const { matches, total } = await leagueRepo.listMatches({ seasonId: season.id, ...params });

    return {
      matches: matches.map((m) => ({
        id: m.id,
        home: m.homeTeam,
        away: m.awayTeam,
        stage: m.stage,
        matchday: m.matchday,
        venue: m.venue,
        kickoffAt: m.kickoffAt.toISOString(),
        status: m.status,
      })),
      total,
    };
  }

  /** §15.3 — GET /v1/league/matches/featured */
  async getFeaturedMatch(userId?: string): Promise<MatchSummaryDTO | null> {
    const season = await requireActiveSeason();
    const config = configFor(season);

    const { matches: liveMatches } = await leagueRepo.listMatches({ seasonId: season.id, status: 'LIVE', limit: 50 });

    let chosen: LeagueMatch | null = null;
    let chosenPredictions: LeaguePrediction[] | undefined;

    if (liveMatches.length > 0) {
      let bestPool = -1;
      for (const m of liveMatches) {
        const predictions = await leagueRepo.listPredictionsByMatch(m.id);
        const pool = sumPredictionPool(predictions, m.stage, config.scoring);
        if (pool > bestPool) {
          bestPool = pool;
          chosen = m;
          chosenPredictions = predictions;
        }
      }
    } else {
      const { matches } = await leagueRepo.listMatches({ seasonId: season.id, status: 'SCHEDULED', limit: 1 });
      chosen = matches[0] ?? null;
    }

    if (!chosen) return null;
    return this.buildMatchSummary(chosen, season, userId, chosenPredictions);
  }

  /** §15.7 — GET /v1/league/matches/:matchId */
  async getMatchDetail(matchId: string, userId?: string): Promise<MatchDetailDTO> {
    const season = await requireActiveSeason();
    const match = await leagueRepo.findMatchById(matchId);
    if (!match) throw new NotFoundError('match not found');

    const predictions = await leagueRepo.listPredictionsByMatch(matchId);
    const summary = await this.buildMatchSummary(match, season, userId, predictions);

    const agentIds = [...new Set(predictions.map((p) => p.agentId))];
    const agents = await prisma.agent.findMany({ where: { id: { in: agentIds } }, select: { id: true, name: true } });
    const agentNameMap = new Map(agents.map((a) => [a.id, a.name]));

    const agentBets: AgentBetDTO[] = predictions
      .filter((p) => p.status === 'LOCKED' || p.status === 'SETTLED')
      .map((p) => ({
        agentId: p.agentId,
        agentName: agentNameMap.get(p.agentId) ?? 'Unknown',
        winner: p.winner,
        scoreHome: p.scoreHome,
        scoreAway: p.scoreAway,
        conviction: p.conviction,
        reasoning: p.reasoning,
      }));

    const questions = await this.buildQuestions(match, season, predictions, agentNameMap);

    return { ...summary, questions, agentBets };
  }

  /** GET /v1/league/predictions/today */
  async getTodayPredictions(limit: number): Promise<TodayPredictionDTO[]> {
    const season = await requireActiveSeason();
    const now = new Date();
    const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000 - 1);

    const { matches } = await leagueRepo.listMatches({ seasonId: season.id, from: startOfDay, to: endOfDay, limit: 50 });
    if (matches.length === 0) return [];

    const matchMap = new Map(matches.map((m) => [m.id, m]));
    const predictions = await prisma.leaguePrediction.findMany({
      where: { matchId: { in: matches.map((m) => m.id) } },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    if (predictions.length === 0) return [];

    const agentIds = [...new Set(predictions.map((p) => p.agentId))];
    const agents = await prisma.agent.findMany({ where: { id: { in: agentIds } }, select: { id: true, name: true } });
    const agentNameMap = new Map(agents.map((a) => [a.id, a.name]));

    return predictions.map((p) => {
      const match = matchMap.get(p.matchId)!;
      return {
        agentName: agentNameMap.get(p.agentId) ?? 'Unknown',
        quote: p.reasoning ?? 'Agent is thinking...',
        confidence: convictionToConfidencePct(p.conviction),
        pick: `${pickLabel(p.winner, match.homeTeam, match.awayTeam)} ${p.scoreHome}-${p.scoreAway}`,
      };
    });
  }

  /** GET /v1/league/me/predictions?status=settled */
  async getMyRecentPicks(userId: string, limit: number): Promise<RecentPickDTO[]> {
    const agentIds = (await prisma.agent.findMany({ where: { userId }, select: { id: true } })).map((a) => a.id);
    if (agentIds.length === 0) return [];

    const predictions = await prisma.leaguePrediction.findMany({
      where: { agentId: { in: agentIds }, status: 'SETTLED' },
      include: { match: true },
      orderBy: { settledAt: 'desc' },
      take: limit,
    });

    return predictions.map((p) => {
      const actual = (p.match.result ?? {}) as { winner?: string; scoreHome?: number; scoreAway?: number };
      return {
        id: p.id,
        home: p.match.homeTeam,
        away: p.match.awayTeam,
        pick: `${pickLabel(p.winner, p.match.homeTeam, p.match.awayTeam)} ${p.scoreHome}-${p.scoreAway}`,
        confidence: convictionToConfidencePct(p.conviction),
        result: actual.scoreHome != null && actual.scoreAway != null ? `${actual.scoreHome}-${actual.scoreAway}` : '',
        outcome: p.isCorrectWinner ? 'WIN' : actual.winner === 'DRAW' ? 'DRAW' : 'LOSS',
        kpEarned: p.kpAwarded ?? 0,
      };
    });
  }

  /** §15.4 — GET /v1/league/rivalries/featured */
  async getFeaturedRivalry(userId?: string): Promise<RivalryDTO | null> {
    const season = await requireActiveSeason();
    const config = configFor(season);

    let rivalry: LeagueRivalry | null = null;
    let userAgentIds = new Set<string>();

    if (userId) {
      const agents = await prisma.agent.findMany({ where: { userId }, select: { id: true } });
      userAgentIds = new Set(agents.map((a) => a.id));
      if (userAgentIds.size > 0) {
        rivalry = await prisma.leagueRivalry.findFirst({
          where: {
            seasonId: season.id,
            OR: [{ agentLowId: { in: [...userAgentIds] } }, { agentHighId: { in: [...userAgentIds] } }],
          },
          orderBy: { totalMatchups: 'desc' },
        });
      }
    }

    if (!rivalry) {
      const featured = await leagueRepo.listFeaturedRivalries(season.id, 1);
      rivalry = featured[0] ?? null;
    }

    if (!rivalry) return null;

    let leftAgentId = rivalry.agentLowId;
    let rightAgentId = rivalry.agentHighId;
    let leftWins = rivalry.agentLowWins;
    let rightWins = rivalry.agentHighWins;
    if (userAgentIds.has(rivalry.agentHighId) && !userAgentIds.has(rivalry.agentLowId)) {
      leftAgentId = rivalry.agentHighId;
      rightAgentId = rivalry.agentLowId;
      leftWins = rivalry.agentHighWins;
      rightWins = rivalry.agentLowWins;
    }

    const agents = await prisma.agent.findMany({ where: { id: { in: [leftAgentId, rightAgentId] } }, select: { id: true, name: true } });
    const nameMap = new Map(agents.map((a) => [a.id, a.name]));

    return {
      leftAgentId,
      leftAgentName: nameMap.get(leftAgentId) ?? 'Unknown',
      rightAgentId,
      rightAgentName: nameMap.get(rightAgentId) ?? 'Unknown',
      leftWins,
      rightWins,
      reputationReward: config.rivalry.reputationRewardBase + rivalry.totalMatchups * config.rivalry.reputationRewardPerMatchup,
      kpReward: config.rivalry.kpRewardBase + rivalry.totalMatchups * config.rivalry.kpRewardPerMatchup,
      narrative: rivalry.narrative,
    };
  }

  /** §15.5 — GET /v1/league/me/agents */
  async getMyAgents(userId: string): Promise<LineupRowDTO[]> {
    const season = await requireActiveSeason();
    const agents = await prisma.agent.findMany({
      where: { userId, isRetired: false },
      select: { id: true, name: true, archetype: true, traits: true },
    });
    if (agents.length === 0) return [];

    const agentIds = agents.map((a) => a.id);
    const [statsRows, wallets] = await Promise.all([
      prisma.leagueAgentSeasonStats.findMany({ where: { seasonId: season.id, agentId: { in: agentIds } } }),
      prisma.agentWallet.findMany({ where: { agentId: { in: agentIds } } }),
    ]);
    const statsMap = new Map(statsRows.map((s) => [s.agentId, s]));
    const walletMap = new Map(wallets.map((w) => [w.agentId, w]));

    const rows: LineupRowDTO[] = [];
    for (const agent of agents) {
      let stats = statsMap.get(agent.id);
      if (!stats) {
        const tribe = mapAgentToTribe(agent.id, agent.archetype, normalizeTraits(agent.traits));
        stats = await leagueRepo.enrollAgent(season.id, agent.id, tribe);
      }
      rows.push({
        agentId: agent.id,
        agentName: agent.name,
        tribe: stats.tribe,
        reputation: Math.round(stats.reputation),
        record: predictionRecord(stats),
        balanceArena: walletMap.get(agent.id)?.balanceArena ?? 0,
      });
    }
    return rows;
  }

  /** §15.6 — GET /v1/league/battles/open */
  async getOpenBattles(limit: number): Promise<OpenBattleDTO[]> {
    const season = await requireActiveSeason();
    const { battles } = await leagueRepo.listBattles({ status: 'PENDING', limit });
    if (battles.length === 0) return [];

    const agentIds = [...new Set(battles.flatMap((b) => [b.challengerId, b.opponentId]))];
    const [agents, statsRows] = await Promise.all([
      prisma.agent.findMany({ where: { id: { in: agentIds } }, select: { id: true, name: true } }),
      prisma.leagueAgentSeasonStats.findMany({ where: { seasonId: season.id, agentId: { in: agentIds } } }),
    ]);
    const nameMap = new Map(agents.map((a) => [a.id, a.name]));
    const statsMap = new Map(statsRows.map((s) => [s.agentId, s]));

    const rows: OpenBattleDTO[] = [];
    for (const battle of battles) {
      const [agentLowId, agentHighId] = [battle.challengerId, battle.opponentId].sort();
      const rivalry = await prisma.leagueRivalry.findUnique({
        where: { seasonId_agentLowId_agentHighId: { seasonId: season.id, agentLowId, agentHighId } },
      });

      const challengerStats = statsMap.get(battle.challengerId);
      const opponentStats = statsMap.get(battle.opponentId);

      let title = 'Open challenge';
      if (rivalry && rivalry.totalMatchups > 0) {
        title = 'Rivalry rematch';
      } else if (
        challengerStats &&
        opponentStats &&
        challengerStats.tribe !== opponentStats.tribe &&
        Math.abs(challengerStats.reputation - opponentStats.reputation) < 100
      ) {
        title = 'Meta breaker';
      }

      rows.push({
        id: battle.id,
        matchId: battle.matchId,
        challengerAgentId: battle.challengerId,
        challengerAgentName: nameMap.get(battle.challengerId) ?? 'Unknown',
        opponentAgentId: battle.opponentId,
        opponentAgentName: nameMap.get(battle.opponentId) ?? 'Unknown',
        title,
        stakeArena: battle.stakeArena,
        status: battle.status,
      });
    }
    return rows;
  }

  /** GET /v1/league/leaderboard?scope=global|faction */
  async getReputationLeaderboard(tribe: LeagueTribe | undefined, limit: number): Promise<ReputationLeaderboardRow[]> {
    const season = await requireActiveSeason();
    return getReputationLeaderboard(season.id, { tribe, limit });
  }

  /** GET /v1/league/leaderboard?scope=weekly */
  async getKpLeaderboard(limit: number): Promise<KpLeaderboardRowDTO[]> {
    const profiles = await leagueRepo.getKpLeaderboard({ scope: 'weekly', limit });
    return profiles.map((p, idx) => ({ rank: idx + 1, userId: p.userId, kpWeekly: p.kpWeekly, kpBalance: p.kpBalance }));
  }

  /** GET /v1/league/moments */
  async getMoments(limit: number, agentId?: string): Promise<MomentDTO[]> {
    const season = await requireActiveSeason();
    const moments = await prisma.leagueMoment.findMany({
      where: { seasonId: season.id, ...(agentId && { agentId }) },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    if (moments.length === 0) return [];

    const agentIds = [...new Set(moments.map((m) => m.agentId).filter((id): id is string => !!id))];
    const agents = await prisma.agent.findMany({ where: { id: { in: agentIds } }, select: { id: true, name: true } });
    const nameMap = new Map(agents.map((a) => [a.id, a.name]));

    return moments.map((m) => {
      const payload = (m.payload ?? {}) as { kpAwarded?: number };
      return {
        id: m.id,
        agentName: m.agentId ? nameMap.get(m.agentId) ?? 'Unknown' : 'KULTAI',
        agentImg: '',
        text: m.text,
        ...(payload.kpAwarded !== undefined && { kp: payload.kpAwarded }),
      };
    });
  }

  /** Shared §15.3/§15.7 builder — pool/consensus/userAgentPick from a match's predictions. */
  private async buildMatchSummary(
    match: LeagueMatch,
    season: LeagueSeason,
    userId: string | undefined,
    predictions?: LeaguePrediction[],
  ): Promise<MatchSummaryDTO> {
    const config = configFor(season);
    const preds = predictions ?? (await leagueRepo.listPredictionsByMatch(match.id));

    const predictionPool = sumPredictionPool(preds, match.stage, config.scoring);
    const consensus = computeConsensus(preds.map((p) => p.winner));
    const { homeScore, awayScore, liveMinute } = scoreFromResult(match.result);

    let userAgentPick: UserAgentPickDTO | null = null;
    if (userId) {
      const userAgents = await prisma.agent.findMany({ where: { userId }, select: { id: true, name: true } });
      const userAgentIds = new Set(userAgents.map((a) => a.id));
      const pick = preds.find((p) => userAgentIds.has(p.agentId));
      if (pick) {
        const agent = userAgents.find((a) => a.id === pick.agentId)!;
        userAgentPick = {
          agentId: pick.agentId,
          agentName: agent.name,
          conviction: pick.conviction,
          scoreHome: pick.scoreHome,
          scoreAway: pick.scoreAway,
          predictedWinner: pick.winner,
        };
      }
    }

    return {
      id: match.id,
      home: match.homeTeam,
      away: match.awayTeam,
      stage: match.stage,
      matchday: match.matchday,
      venue: match.venue,
      kickoffAt: match.kickoffAt.toISOString(),
      status: match.status,
      isLive: match.status === 'LIVE',
      homeScore,
      awayScore,
      liveMinute,
      predictionPool: Math.round(predictionPool),
      totalAgentBets: preds.length,
      consensus,
      userAgentPick,
    };
  }

  /**
   * §15.7.1 — derive up to 3 head-to-head questions (Match Result, Goals
   * O/U 2.5, Margin) from the two highest-reputation agents whose picks
   * disagree on the match winner. Returns [] if fewer than 2 predictions
   * exist or no disagreement is found.
   */
  private async buildQuestions(
    match: LeagueMatch,
    season: LeagueSeason,
    predictions: LeaguePrediction[],
    agentNameMap: Map<string, string>,
  ): Promise<LeaguePredictionQuestionDTO[]> {
    if (predictions.length < 2) return [];

    const agentIds = [...new Set(predictions.map((p) => p.agentId))];
    const stats = await prisma.leagueAgentSeasonStats.findMany({
      where: { seasonId: season.id, agentId: { in: agentIds } },
    });
    const repMap = new Map(stats.map((s) => [s.agentId, s.reputation]));

    const sorted = [...predictions].sort((a, b) => (repMap.get(b.agentId) ?? 0) - (repMap.get(a.agentId) ?? 0));
    const top = sorted[0];
    const opposing = sorted.find((p) => p.agentId !== top.agentId && p.winner !== top.winner);
    if (!opposing) return [];

    const config = configFor(season);
    const stake = (p: LeaguePrediction) => Math.round(potentialArenaPayout(p.conviction, match.stage, config.scoring));
    const confidence = (p: LeaguePrediction) => convictionToConfidencePct(p.conviction);
    const agentName = (p: LeaguePrediction) => agentNameMap.get(p.agentId) ?? 'Unknown';

    const resultSide = (p: LeaguePrediction): LeaguePredictionQuestionAgentDTO => ({
      agentName: agentName(p),
      pick: matchResultPickLabel(p.winner, match.homeTeam, match.awayTeam),
      stake: stake(p),
      confidence: confidence(p),
    });

    const goalsSide = (p: LeaguePrediction): LeaguePredictionQuestionAgentDTO => ({
      agentName: agentName(p),
      pick: p.scoreHome + p.scoreAway > 2.5 ? 'Over 2.5' : 'Under 2.5',
      stake: stake(p),
      confidence: confidence(p),
    });

    const marginSide = (p: LeaguePrediction): LeaguePredictionQuestionAgentDTO => ({
      agentName: agentName(p),
      pick: Math.abs(p.scoreHome - p.scoreAway) >= 2 ? 'Yes' : 'No',
      stake: stake(p),
      confidence: confidence(p),
    });

    return [
      {
        id: `${match.id}:result`,
        category: 'Match Result',
        question: 'Who wins the match?',
        agentA: resultSide(top),
        agentB: resultSide(opposing),
      },
      {
        id: `${match.id}:goals`,
        category: 'Goals O/U 2.5',
        question: 'Total goals — over or under 2.5?',
        agentA: goalsSide(top),
        agentB: goalsSide(opposing),
      },
      {
        id: `${match.id}:margin`,
        category: 'Margin',
        question: 'Will the winner lead by 2+ goals?',
        agentA: marginSide(top),
        agentB: marginSide(opposing),
      },
    ];
  }
}

export const leagueReadService = new LeagueReadService();
