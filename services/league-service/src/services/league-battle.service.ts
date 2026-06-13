import { prisma, LeagueBattle } from '@ai-arena/db-client';
import { addHours, isExpired } from '@ai-arena/shared-utils';
import { getEventBus, LEAGUE_SUBJECTS } from '@ai-arena/event-bus';
import { leagueRepo, requireActiveSeason, configFor } from '../lib/season';
import { lockLeagueEscrowRemote } from '../lib/internal';
import { leaguePredictionService } from './league-prediction.service';
import { NotFoundError, ForbiddenError, ConflictError, BadRequestError } from '../lib/errors';

export interface CreateBattleInput {
  matchId: string;
  challengerAgentId: string;
  opponentAgentId: string;
  stakeArena: number;
}

class LeagueBattleService {
  /** §9.1 step 1 — POST /v1/league/battles */
  async createBattle(userId: string, input: CreateBattleInput): Promise<LeagueBattle> {
    const season = await requireActiveSeason();
    const config = configFor(season);

    if (!Number.isFinite(input.stakeArena) || input.stakeArena <= 0) {
      throw new BadRequestError('stakeArena must be a positive number');
    }
    if (input.challengerAgentId === input.opponentAgentId) {
      throw new BadRequestError('challenger and opponent must be different agents');
    }

    const [challenger, opponent] = await Promise.all([
      prisma.agent.findUnique({ where: { id: input.challengerAgentId }, select: { userId: true } }),
      prisma.agent.findUnique({ where: { id: input.opponentAgentId }, select: { userId: true } }),
    ]);
    if (!challenger) throw new NotFoundError('challenger agent not found');
    if (!opponent) throw new NotFoundError('opponent agent not found');
    if (challenger.userId !== userId) throw new ForbiddenError('you do not own the challenger agent');
    if (challenger.userId === opponent.userId) throw new ConflictError('agents owned by the same user cannot battle');

    const match = await leagueRepo.findMatchById(input.matchId);
    if (!match) throw new NotFoundError('match not found');
    if (match.status !== 'SCHEDULED' && match.status !== 'LIVE') {
      throw new ConflictError('battles can only be created for scheduled or live matches');
    }

    // §9.5 — daily creation cap, challenger-owned agents, trailing 24h
    const ownedAgentIds = (await prisma.agent.findMany({ where: { userId }, select: { id: true } })).map((a) => a.id);
    const createdCount = await leagueRepo.countBattlesCreatedSince(ownedAgentIds, addHours(new Date(), -24));
    if (createdCount >= config.battles.dailyCreateCap) {
      throw new ConflictError(`daily battle creation limit (${config.battles.dailyCreateCap}) reached`);
    }

    await leaguePredictionService.ensurePrediction(input.challengerAgentId, match);

    const battle = await leagueRepo.createBattle({
      seasonId: season.id,
      match: { connect: { id: match.id } },
      challengerId: input.challengerAgentId,
      opponentId: input.opponentAgentId,
      stakeArena: input.stakeArena,
    });

    const bus = await getEventBus();
    await bus
      .publish(LEAGUE_SUBJECTS.LEAGUE_BATTLE_CREATED, {
        battleId: battle.id,
        matchId: match.id,
        challengerAgentId: input.challengerAgentId,
        opponentAgentId: input.opponentAgentId,
        stakeArena: input.stakeArena,
      })
      .catch(() => {});

    return battle;
  }

  /** §9.1 step 2 — POST /v1/league/battles/:id/accept */
  async acceptBattle(userId: string, battleId: string): Promise<LeagueBattle> {
    const season = await requireActiveSeason();
    const config = configFor(season);

    const battle = await leagueRepo.findBattleById(battleId);
    if (!battle) throw new NotFoundError('battle not found');
    if (battle.status !== 'PENDING') throw new ConflictError('battle is not pending');

    const opponent = await prisma.agent.findUnique({ where: { id: battle.opponentId }, select: { userId: true } });
    if (!opponent) throw new NotFoundError('opponent agent not found');
    if (opponent.userId !== userId) throw new ForbiddenError('you do not own the opponent agent');

    const match = await leagueRepo.findMatchById(battle.matchId);
    if (!match) throw new NotFoundError('match not found');

    // §9.1 — PENDING battles expire 24h after creation, or at kickoff, whichever is sooner
    const expiresAt = new Date(
      Math.min(addHours(battle.createdAt, config.battles.pendingExpiryHours).getTime(), match.kickoffAt.getTime()),
    );
    if (isExpired(expiresAt)) throw new ConflictError('battle has expired');

    // §9.5 — daily acceptance cap, opponent-owned agents, trailing 24h
    const ownedAgentIds = (await prisma.agent.findMany({ where: { userId }, select: { id: true } })).map((a) => a.id);
    const acceptedCount = await leagueRepo.countBattlesAcceptedSince(ownedAgentIds, addHours(new Date(), -24));
    if (acceptedCount >= config.battles.dailyAcceptCap) {
      throw new ConflictError(`daily battle acceptance limit (${config.battles.dailyAcceptCap}) reached`);
    }

    await leaguePredictionService.ensurePrediction(battle.opponentId, match);

    // §9.2 — financial-service locks escrow and transitions LeagueBattle -> LOCKED in its own transaction
    await lockLeagueEscrowRemote(battle.id);

    const updated = await leagueRepo.findBattleById(battle.id);
    if (!updated) throw new NotFoundError('battle not found after escrow lock');

    const bus = await getEventBus();
    await bus
      .publish(LEAGUE_SUBJECTS.LEAGUE_BATTLE_ACCEPTED, { battleId: updated.id, matchId: updated.matchId, escrowId: updated.escrowId })
      .catch(() => {});

    return updated;
  }
}

export const leagueBattleService = new LeagueBattleService();
