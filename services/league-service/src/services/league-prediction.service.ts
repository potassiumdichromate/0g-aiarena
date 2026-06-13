import { prisma, Prisma, LeagueMatch, LeaguePrediction, PredictionSource, PredictionOutcome, ConvictionLevel } from '@ai-arena/db-client';
import { validatePrediction, generateFallbackPrediction, normalizeTraits, PredictionInput } from '@ai-arena/shared-utils';
import { leagueRepo } from '../lib/season';
import { requestLeaguePrediction, LeagueMatchContext } from '../lib/internal';
import { NotFoundError, ForbiddenError, ConflictError } from '../lib/errors';

export interface OverrideInput extends PredictionInput {
  reasoning?: string;
}

class LeaguePredictionService {
  /** §6.5 — PUT /v1/league/predictions/:matchId/:agentId */
  async overridePrediction(userId: string, matchId: string, agentId: string, input: OverrideInput): Promise<LeaguePrediction> {
    await this.requireOwnedAgent(userId, agentId);

    const match = await leagueRepo.findMatchById(matchId);
    if (!match) throw new NotFoundError('match not found');

    const existing = await leagueRepo.findPrediction(matchId, agentId);
    if (!existing) throw new NotFoundError('prediction not found for this agent/match');
    if (existing.status !== 'PENDING') throw new ConflictError('prediction is locked and can no longer be edited');

    validatePrediction(input, match.stage);

    return leagueRepo.overridePrediction(matchId, agentId, {
      winner: input.winner,
      scoreHome: input.scoreHome,
      scoreAway: input.scoreAway,
      conviction: input.conviction,
      ...(input.reasoning !== undefined && { reasoning: input.reasoning }),
    });
  }

  /** §6.2 lazy generation — POST /v1/league/predictions/:matchId/:agentId/generate */
  async generatePrediction(userId: string, matchId: string, agentId: string): Promise<LeaguePrediction> {
    await this.requireOwnedAgent(userId, agentId);

    const match = await leagueRepo.findMatchById(matchId);
    if (!match) throw new NotFoundError('match not found');
    if (match.status !== 'SCHEDULED' && match.status !== 'LIVE') {
      throw new ConflictError('predictions are no longer accepted for this match');
    }

    return this.ensurePrediction(agentId, match);
  }

  /**
   * §6.2/§9.1 — return the existing prediction for (match, agent), or
   * generate one via `decideLeaguePrediction` (falling back to the
   * deterministic generator on any inference failure). Never throws on
   * inference failure — only on a Prisma error other than a duplicate-key race.
   */
  async ensurePrediction(agentId: string, match: LeagueMatch): Promise<LeaguePrediction> {
    const existing = await leagueRepo.findPrediction(match.id, agentId);
    if (existing) return existing;

    const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { traits: true } });
    const traits = normalizeTraits(agent?.traits);

    let prediction: { winner: PredictionOutcome; scoreHome: number; scoreAway: number; conviction: ConvictionLevel; reasoning: string };
    let source: PredictionSource;

    try {
      const matchContext: LeagueMatchContext = {
        matchId: match.id,
        homeTeam: match.homeTeam,
        awayTeam: match.awayTeam,
        stage: match.stage,
        kickoffAt: match.kickoffAt.toISOString(),
      };
      const result = await requestLeaguePrediction(agentId, matchContext);
      validatePrediction(result, match.stage);
      prediction = result;
      source = result.source;
    } catch {
      prediction = generateFallbackPrediction(agentId, match.id, match.stage, traits);
      source = 'FALLBACK';
    }

    try {
      return await leagueRepo.createPrediction({
        match: { connect: { id: match.id } },
        agentId,
        winner: prediction.winner,
        scoreHome: prediction.scoreHome,
        scoreAway: prediction.scoreAway,
        conviction: prediction.conviction,
        reasoning: prediction.reasoning,
        source,
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const row = await leagueRepo.findPrediction(match.id, agentId);
        if (row) return row;
      }
      throw err;
    }
  }

  private async requireOwnedAgent(userId: string, agentId: string): Promise<void> {
    const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { userId: true } });
    if (!agent) throw new NotFoundError('agent not found');
    if (agent.userId !== userId) throw new ForbiddenError('you do not own this agent');
  }
}

export const leaguePredictionService = new LeaguePredictionService();
