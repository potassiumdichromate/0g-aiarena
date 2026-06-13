import { prisma, Prisma, CombatArchetype, LeagueMatch, PredictionOutcome, ConvictionLevel, PredictionSource } from '@ai-arena/db-client';
import { getEventBus, LEAGUE_SUBJECTS } from '@ai-arena/event-bus';
import { validatePrediction, generateFallbackPrediction, mapAgentToTribe, normalizeTraits, addHours } from '@ai-arena/shared-utils';
import { leagueRepo, requireActiveSeason, configFor, NoActiveSeasonError } from '../lib/season';
import { requestLeaguePrediction, LeagueMatchContext } from '../lib/inference';

/**
 * §6.2 pre-gen — hourly. For every match crossing the
 * `preGenHoursBefore`..`preGenHoursBefore + preGenWindowHours` window, ensure
 * every non-retired agent is enrolled (§3.1) and has a prediction so the
 * lock sweep never has to lazy-generate under time pressure.
 */
export async function runPreGen(): Promise<void> {
  let season;
  try {
    season = await requireActiveSeason();
  } catch (err) {
    if (err instanceof NoActiveSeasonError) return;
    throw err;
  }
  const config = configFor(season);

  const from = addHours(new Date(), config.predictionGen.preGenHoursBefore);
  const to = addHours(from, config.predictionGen.preGenWindowHours);

  const matches = await leagueRepo.listMatchesInPreGenWindow(season.id, from, to);
  if (matches.length === 0) return;

  const agents = await prisma.agent.findMany({
    where: { isRetired: false },
    select: { id: true, traits: true, archetype: true },
  });

  console.log(`[league-worker] pregen: ${matches.length} match(es) x ${agents.length} agent(s)`);

  for (const match of matches) {
    for (const agent of agents) {
      try {
        await ensureEnrollment(season.id, agent.id, agent.archetype, agent.traits);
        await ensurePrediction(match, agent.id, agent.traits);
      } catch (err) {
        console.error(`[league-worker] pregen — match ${match.id} agent ${agent.id}:`, (err as Error).message);
      }
    }
  }
}

async function ensureEnrollment(seasonId: string, agentId: string, archetype: CombatArchetype, rawTraits: unknown): Promise<void> {
  const existing = await leagueRepo.getAgentStats(seasonId, agentId);
  if (existing) return;

  const traits = normalizeTraits(rawTraits);
  const tribe = mapAgentToTribe(agentId, archetype, traits);
  await leagueRepo.enrollAgent(seasonId, agentId, tribe);
}

async function ensurePrediction(match: LeagueMatch, agentId: string, rawTraits: unknown): Promise<void> {
  const existing = await leagueRepo.findPrediction(match.id, agentId);
  if (existing) return;

  const traits = normalizeTraits(rawTraits);

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
    const created = await leagueRepo.createPrediction({
      match: { connect: { id: match.id } },
      agentId,
      winner: prediction.winner,
      scoreHome: prediction.scoreHome,
      scoreAway: prediction.scoreAway,
      conviction: prediction.conviction,
      reasoning: prediction.reasoning,
      source,
    });

    const bus = await getEventBus();
    await bus.publish(LEAGUE_SUBJECTS.LEAGUE_PREDICTION_CREATED, { predictionId: created.id, matchId: match.id, agentId, source });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return; // race with lazy-gen
    throw err;
  }
}
