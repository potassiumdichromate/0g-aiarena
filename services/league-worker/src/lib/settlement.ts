import { prisma, Prisma, LeaguePrediction, LeagueTribe, PredictionOutcome, ConvictionLevel } from '@ai-arena/db-client';
import { getEventBus, LEAGUE_SUBJECTS } from '@ai-arena/event-bus';
import {
  scoreLeaguePrediction,
  computeReputation,
  isReputationProvisional,
  mapAgentToTribe,
  normalizeTraits,
  AgentStatsForReputation,
  ScoreResult,
  NormalizedMatchResult,
  LeagueConfig,
} from '@ai-arena/shared-utils';
import { leagueRepo, configFor } from './season';
import { resolveAgentOwner, AgentLeagueInfo } from './resolve';
import { creditLeaguePredictionReward, settleLeagueBattleRemote } from './financial';
import { updateLeaderboards } from './leaderboard';
import { updateRivalryDisagreements, recordBattleOutcome, PredictionForRivalry } from './rivalry';
import { generateMoments, SettledPredictionForMoments } from './moments';
import { hashResult } from './hash';

/** Shape of `LeagueMatch.result` once a provider reports a FINISHED fixture (§8.1/§10.1). */
interface StoredMatchResult {
  winner: PredictionOutcome | null;
  scoreHome: number | null;
  scoreAway: number | null;
  consensus?: PredictionOutcome;
}

const CONVICTION_VALUE: Record<ConvictionLevel, number> = { LOW: 0, MEDIUM: 0.5, HIGH: 1 };

/** §9.3 — winner is whichever agent earned more $ARENA on this match; equal awards (incl. both wrong) is a tie -> void. */
export function determineBattleWinner(challenger: LeaguePrediction, opponent: LeaguePrediction): string | null {
  const challengerScore = challenger.arenaAwarded ?? 0;
  const opponentScore = opponent.arenaAwarded ?? 0;
  if (challengerScore > opponentScore) return challenger.agentId;
  if (opponentScore > challengerScore) return opponent.agentId;
  return null;
}

/**
 * §10.2 — settles every LOCKED prediction for a FINISHED match, then any
 * LOCKED battles whose both predictions are now settled, then derived
 * rivalry/moment side-effects. Idempotent: `claimPredictionsForSettlement`
 * returns an empty array on a repeat call for an already-settled match, so a
 * re-run only refreshes the settlement log and battle/rivalry pass (both of
 * which are themselves idempotent).
 */
export async function settleMatch(matchId: string): Promise<void> {
  const match = await leagueRepo.findMatchById(matchId);
  if (!match) return;

  const result = match.result as unknown as StoredMatchResult | null;
  if (!result || result.winner === null || result.scoreHome === null || result.scoreAway === null) {
    console.warn(`[league-worker] settleMatch(${matchId}) called without a usable result — skipping`);
    return;
  }

  const season = await leagueRepo.getSeasonById(match.seasonId);
  if (!season) return;
  const config = configFor(season);

  const normalizedResult: NormalizedMatchResult = { winner: result.winner, scoreHome: result.scoreHome, scoreAway: result.scoreAway };
  const consensus = result.consensus;

  const claimed = await leagueRepo.claimPredictionsForSettlement(matchId, match.resultVersion);
  const battles = await leagueRepo.listLockedBattlesForMatch(matchId);

  const agentNames = new Map<string, string>();
  const agentInfoMap = new Map<string, AgentLeagueInfo>();
  const involvedAgentIds = new Set<string>([...claimed.map((p) => p.agentId), ...battles.flatMap((b) => [b.challengerId, b.opponentId])]);
  await loadAgentInfo(involvedAgentIds, agentNames, agentInfoMap);

  const errors: string[] = [];
  const settledForMoments: SettledPredictionForMoments[] = [];
  const settledForRivalry: PredictionForRivalry[] = [];
  const agentTribes = new Map<string, LeagueTribe>();

  for (const pred of claimed) {
    try {
      const info = agentInfoMap.get(pred.agentId);
      if (!info) throw new Error(`agent ${pred.agentId} not found`);

      const wasUnderdog = consensus !== undefined && pred.winner !== consensus;
      const score = scoreLeaguePrediction(
        { winner: pred.winner, scoreHome: pred.scoreHome, scoreAway: pred.scoreAway, conviction: pred.conviction },
        normalizedResult,
        { stage: match.stage },
        wasUnderdog,
        config.scoring,
      );

      await leagueRepo.updatePrediction(pred.id, {
        isCorrectWinner: score.isCorrectWinner,
        isExactScore: score.isExactScore,
        isUpset: score.isUpset,
        basePoints: score.basePoints,
        arenaAwarded: score.arenaAwarded,
        kpAwarded: score.kpAwarded,
      });

      if (score.arenaAwarded > 0) {
        await creditLeaguePredictionReward({
          agentId: pred.agentId,
          predictionId: pred.id,
          amount: score.arenaAwarded,
          metadata: { matchId, seasonId: match.seasonId },
        });
      }

      const ownerId = await resolveAgentOwner(pred.agentId);
      await creditKpSafe(ownerId, score, pred.id);

      const { tribe, currentStreak } = await updatePredictionStats(match.seasonId, pred.agentId, pred.conviction, score, info, config);

      agentTribes.set(pred.agentId, tribe);
      settledForMoments.push({
        agentId: pred.agentId,
        winner: pred.winner,
        isCorrectWinner: score.isCorrectWinner,
        isUpset: score.isUpset,
        arenaAwarded: score.arenaAwarded,
        currentStreak,
      });
      settledForRivalry.push({ agentId: pred.agentId, winner: pred.winner, isCorrectWinner: score.isCorrectWinner });
    } catch (err) {
      const message = `prediction ${pred.id}: ${(err as Error).message}`;
      console.error(`[league-worker] settleMatch(${matchId}) —`, message);
      errors.push(message);
    }
  }

  // §10.2 step 5 — settle LOCKED battles whose both predictions are now SETTLED.
  for (const battle of battles) {
    try {
      const [challengerPred, opponentPred] = await Promise.all([
        leagueRepo.findPrediction(matchId, battle.challengerId),
        leagueRepo.findPrediction(matchId, battle.opponentId),
      ]);
      if (!challengerPred || !opponentPred || challengerPred.status !== 'SETTLED' || opponentPred.status !== 'SETTLED') continue;

      const winnerId = determineBattleWinner(challengerPred, opponentPred);
      await settleLeagueBattleRemote({ battleId: battle.id, winnerId });

      if (winnerId) {
        await recordBattleOutcome(match.seasonId, battle, winnerId, agentInfoMap, agentNames, config);
      }
    } catch (err) {
      const message = `battle ${battle.id}: ${(err as Error).message}`;
      console.error(`[league-worker] settleMatch(${matchId}) —`, message);
      errors.push(message);
    }
  }

  // §11.1 — disagreement rivalries + ROAST moments among faction-mates.
  try {
    await updateRivalryDisagreements(match.seasonId, matchId, settledForRivalry, agentTribes, agentNames, config);
  } catch (err) {
    errors.push(`rivalry update: ${(err as Error).message}`);
  }

  // §13 — VINDICATION / UPSET / STREAK moments.
  try {
    const scoreline = `${normalizedResult.scoreHome}-${normalizedResult.scoreAway}`;
    await generateMoments(match.seasonId, matchId, consensus, scoreline, settledForMoments, agentNames);
  } catch (err) {
    errors.push(`moments: ${(err as Error).message}`);
  }

  const bus = await getEventBus();
  await bus.publish(LEAGUE_SUBJECTS.LEAGUE_MATCH_SETTLED, {
    matchId,
    seasonId: match.seasonId,
    result: normalizedResult,
    predictionsSettled: claimed.length,
  });

  await leagueRepo.upsertSettlementLog(matchId, {
    resultHash: hashResult(result),
    version: match.resultVersion,
    status: errors.length > 0 ? 'PARTIAL' : 'COMPLETED',
    ...(errors.length > 0 && { errorDetail: errors.join('; ') }),
  });
}

/**
 * §10.4 — cancellation voids any non-terminal predictions and the match's
 * battles. No reputation, rivalry, or moment side-effects (§9.4).
 */
export async function cancelMatch(matchId: string): Promise<void> {
  await leagueRepo.updateMatch(matchId, { status: 'CANCELLED' });
  await leagueRepo.voidPredictionsForMatch(matchId);

  const { battles } = await leagueRepo.listBattles({ matchId });
  for (const battle of battles) {
    try {
      if (battle.status === 'LOCKED') {
        await settleLeagueBattleRemote({ battleId: battle.id, winnerId: null });
      } else if (battle.status === 'PENDING' || battle.status === 'ACCEPTED') {
        await leagueRepo.transitionBattleStatus(battle.id, battle.status, 'VOID');
      }
    } catch (err) {
      console.error(`[league-worker] cancelMatch(${matchId}) — battle ${battle.id}:`, (err as Error).message);
    }
  }
}

async function creditKpSafe(userId: string, score: ScoreResult, predictionId: string): Promise<void> {
  const reason = !score.isCorrectWinner ? 'predict' : score.isUpset ? 'upset' : 'correct';
  try {
    await leagueRepo.creditKp(userId, score.kpAwarded, reason, 'prediction', predictionId);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return; // already credited
    throw err;
  }
}

/**
 * §5.5 — recomputes `LeagueAgentSeasonStats` and `reputation` for one agent
 * after a settled prediction. `avgConvictionCorrect`/`avgConvictionWrong`
 * are incremental running averages over the correct/wrong prediction counts
 * respectively (conviction mapped LOW/MEDIUM/HIGH -> 0/0.5/1).
 */
async function updatePredictionStats(
  seasonId: string,
  agentId: string,
  conviction: ConvictionLevel,
  score: ScoreResult,
  info: AgentLeagueInfo,
  config: LeagueConfig,
): Promise<{ tribe: LeagueTribe; currentStreak: number }> {
  let stats = await leagueRepo.getAgentStats(seasonId, agentId);
  if (!stats) {
    const tribe = mapAgentToTribe(agentId, info.archetype, info.traits);
    stats = await leagueRepo.enrollAgent(seasonId, agentId, tribe);
  }

  const convictionValue = CONVICTION_VALUE[conviction];
  const predictionsTotal = stats.predictionsTotal + 1;
  const correctWinnerCount = stats.correctWinnerCount + (score.isCorrectWinner ? 1 : 0);
  const exactScoreCount = stats.exactScoreCount + (score.isExactScore ? 1 : 0);
  const currentStreak = score.isCorrectWinner ? stats.currentStreak + 1 : 0;
  const bestStreak = Math.max(stats.bestStreak, currentStreak);
  const arenaEarnedSeason = stats.arenaEarnedSeason + score.arenaAwarded;

  let avgConvictionCorrect = stats.avgConvictionCorrect;
  let avgConvictionWrong = stats.avgConvictionWrong;
  if (score.isCorrectWinner) {
    const priorCorrect = stats.correctWinnerCount;
    avgConvictionCorrect = (stats.avgConvictionCorrect * priorCorrect + convictionValue) / (priorCorrect + 1);
  } else {
    const priorWrong = stats.predictionsTotal - stats.correctWinnerCount;
    avgConvictionWrong = (stats.avgConvictionWrong * priorWrong + convictionValue) / (priorWrong + 1);
  }

  const rivalryRate = await leagueRepo.getSeriousRivalryRate(seasonId, agentId);

  const updatedStats: AgentStatsForReputation = {
    predictionsTotal,
    correctWinnerCount,
    exactScoreCount,
    currentStreak,
    battleWins: stats.battleWins,
    battleLosses: stats.battleLosses,
    avgConvictionCorrect,
    avgConvictionWrong,
    rivalryRate,
  };
  const reputation = computeReputation(updatedStats, info.evolutionStage, config.reputation);
  const reputationProvisional = isReputationProvisional(predictionsTotal);

  await leagueRepo.updateAgentStats(seasonId, agentId, {
    predictionsTotal,
    correctWinnerCount,
    exactScoreCount,
    currentStreak,
    bestStreak,
    arenaEarnedSeason,
    avgConvictionCorrect,
    avgConvictionWrong,
    reputation,
    reputationProvisional,
  });

  await updateLeaderboards(seasonId, agentId, stats.tribe, reputation, reputation - stats.reputation);

  return { tribe: stats.tribe, currentStreak };
}

async function loadAgentInfo(agentIds: Set<string>, agentNames: Map<string, string>, agentInfoMap: Map<string, AgentLeagueInfo>): Promise<void> {
  if (agentIds.size === 0) return;

  const agents = await prisma.agent.findMany({
    where: { id: { in: [...agentIds] } },
    select: { id: true, name: true, userId: true, archetype: true, evolutionStage: true, traits: true },
  });

  for (const agent of agents) {
    agentNames.set(agent.id, agent.name);
    agentInfoMap.set(agent.id, {
      userId: agent.userId,
      archetype: agent.archetype,
      evolutionStage: agent.evolutionStage,
      traits: normalizeTraits(agent.traits),
    });
  }
}
