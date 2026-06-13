import { prisma, LeagueBattle, LeagueRivalry, LeagueTribe, PredictionOutcome } from '@ai-arena/db-client';
import { computeReputation, LeagueConfig } from '@ai-arena/shared-utils';
import { leagueRepo } from './season';
import { createMoment, MOMENT_TEMPLATES } from './moments';
import { AgentLeagueInfo } from './resolve';

export interface PredictionForRivalry {
  agentId: string;
  winner: PredictionOutcome;
  isCorrectWinner: boolean | null;
}

/**
 * §11.1 — for every pair of faction-mates with a settled prediction on this
 * match that disagree on the winner, deepen their rivalry (if one already
 * exists — a new rivalry is only ever seeded by a Battle). When exactly one
 * side of a disagreement was correct, the correct agent gets a ROAST moment.
 */
export async function updateRivalryDisagreements(
  seasonId: string,
  matchId: string,
  settled: PredictionForRivalry[],
  agentTribes: Map<string, LeagueTribe>,
  agentNames: Map<string, string>,
  config: LeagueConfig,
): Promise<void> {
  const byTribe = new Map<LeagueTribe, PredictionForRivalry[]>();
  for (const pred of settled) {
    const tribe = agentTribes.get(pred.agentId);
    if (!tribe) continue;
    const group = byTribe.get(tribe);
    if (group) group.push(pred);
    else byTribe.set(tribe, [pred]);
  }

  for (const group of byTribe.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        if (a.winner === b.winner) continue;

        const [agentLowId, agentHighId] = [a.agentId, b.agentId].sort();
        const existing = await prisma.leagueRivalry.findUnique({
          where: { seasonId_agentLowId_agentHighId: { seasonId, agentLowId, agentHighId } },
        });
        if (!existing) continue;

        const rivalry = await leagueRepo.recordRivalryMatchup(seasonId, a.agentId, b.agentId, null, 'disagreement');
        await maybeCreateRivalryNarrative(seasonId, matchId, rivalry, agentNames, config);

        if (a.isCorrectWinner && !b.isCorrectWinner) {
          await createRoast(seasonId, matchId, a.agentId, b.agentId, agentNames);
        } else if (b.isCorrectWinner && !a.isCorrectWinner) {
          await createRoast(seasonId, matchId, b.agentId, a.agentId, agentNames);
        }
      }
    }
  }
}

async function createRoast(
  seasonId: string,
  matchId: string,
  winnerAgentId: string,
  loserAgentId: string,
  agentNames: Map<string, string>,
): Promise<void> {
  await createMoment({
    seasonId,
    matchId,
    agentId: winnerAgentId,
    type: 'ROAST',
    text: MOMENT_TEMPLATES.ROAST({
      agentName: agentNames.get(winnerAgentId) ?? winnerAgentId,
      rivalName: agentNames.get(loserAgentId) ?? loserAgentId,
    }),
    payload: { rivalAgentId: loserAgentId },
    idempotencyKey: `ROAST:${matchId}:${winnerAgentId}:${loserAgentId}`,
  });
}

async function maybeCreateRivalryNarrative(
  seasonId: string,
  matchId: string,
  rivalry: LeagueRivalry,
  agentNames: Map<string, string>,
  config: LeagueConfig,
): Promise<void> {
  if (rivalry.totalMatchups < config.rivalry.narrativeThreshold || rivalry.narrative) return;

  const lowLeads = rivalry.agentLowWins >= rivalry.agentHighWins;
  const leadAgentId = lowLeads ? rivalry.agentLowId : rivalry.agentHighId;
  const trailAgentId = lowLeads ? rivalry.agentHighId : rivalry.agentLowId;
  const leadWins = lowLeads ? rivalry.agentLowWins : rivalry.agentHighWins;
  const trailWins = lowLeads ? rivalry.agentHighWins : rivalry.agentLowWins;

  const narrative = MOMENT_TEMPLATES.RIVALRY({
    leadAgent: agentNames.get(leadAgentId) ?? leadAgentId,
    trailAgent: agentNames.get(trailAgentId) ?? trailAgentId,
    leadWins,
    trailWins,
  });

  await leagueRepo.updateRivalryNarrative(rivalry.id, narrative);
  await createMoment({
    seasonId,
    matchId,
    agentId: leadAgentId,
    type: 'RIVALRY',
    text: narrative,
    payload: { rivalAgentId: trailAgentId, leadWins, trailWins, totalMatchups: rivalry.totalMatchups },
    idempotencyKey: `RIVALRY:${rivalry.id}:${rivalry.totalMatchups}`,
  });
}

/**
 * §9.3 — records a Battle's win/loss against both agents'
 * `LeagueAgentSeasonStats`, recomputes reputation for each, and deepens (or
 * seeds) the pair's rivalry. Never called for a void/tied battle (§9.4 — no
 * reputation or rivalry changes on a void).
 */
export async function recordBattleOutcome(
  seasonId: string,
  battle: LeagueBattle,
  winnerId: string,
  agentInfo: Map<string, AgentLeagueInfo>,
  agentNames: Map<string, string>,
  config: LeagueConfig,
): Promise<void> {
  const loserId = winnerId === battle.challengerId ? battle.opponentId : battle.challengerId;

  await Promise.all([
    bumpBattleRecord(seasonId, winnerId, true, agentInfo, config),
    bumpBattleRecord(seasonId, loserId, false, agentInfo, config),
  ]);

  const rivalry = await leagueRepo.recordRivalryMatchup(seasonId, battle.challengerId, battle.opponentId, winnerId, 'battle');
  await maybeCreateRivalryNarrative(seasonId, battle.matchId, rivalry, agentNames, config);
}

async function bumpBattleRecord(
  seasonId: string,
  agentId: string,
  won: boolean,
  agentInfo: Map<string, AgentLeagueInfo>,
  config: LeagueConfig,
): Promise<void> {
  const stats = await leagueRepo.getAgentStats(seasonId, agentId);
  if (!stats) return;

  const evolutionStage = agentInfo.get(agentId)?.evolutionStage ?? 'GENESIS';
  const battleWins = stats.battleWins + (won ? 1 : 0);
  const battleLosses = stats.battleLosses + (won ? 0 : 1);
  const rivalryRate = await leagueRepo.getSeriousRivalryRate(seasonId, agentId);
  const reputation = computeReputation({ ...stats, battleWins, battleLosses, rivalryRate }, evolutionStage, config.reputation);

  await leagueRepo.updateAgentStats(seasonId, agentId, { battleWins, battleLosses, reputation });
}
