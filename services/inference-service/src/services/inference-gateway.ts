/**
 * InferenceGateway — routes AI inference calls to 0G Compute Router.
 *
 * 0G Compute Router: https://router-api.0g.ai/v1 (OpenAI-compatible)
 * Auth: sk- API key from pc.0g.ai → Dashboard → API Keys (inference permission)
 * Billing: neuron units (1e18 neuron = 1 0G token), deposit at pc.0g.ai
 *
 * All combat-action inference goes through tool_choice: "required" for
 * structured output — never free-text parsing.
 * TEE verification is enabled when ZEROG_VERIFY_TEE=true.
 */

import {
  ZeroGComputeClient,
  getZeroGConfig,
  CombatAction,
  StrategicPlan,
  LeaguePredictionToolArgs,
} from '@ai-arena/zerog-client';
import { prisma } from '@ai-arena/db-client';
import {
  mapAgentToTribe,
  validatePrediction,
  generateFallbackPrediction,
  generateFallbackSignal,
  normalizeTraits,
  AgentTraitVector,
  LeagueTribe,
  LeagueStage,
} from '@ai-arena/shared-utils';

interface CombatInferenceParams {
  agentId: string;
  battleId: string;
  modelVersion?: string;
  battleState: Record<string, unknown>;
  opponentProfile?: Record<string, unknown>;
  memoryContext?: string[];
  timeoutMs?: number;
}

interface CombatInferenceResult {
  action: CombatAction;
  latencyMs: number;
  source: 'AI' | 'FALLBACK';
  teeVerified?: boolean | null;
  totalCostNeuron?: number;
}

interface StrategyInferenceParams {
  agentId: string;
  battleContext: Record<string, unknown>;
  opponentProfile?: Record<string, unknown>;
  useMemory?: boolean;
}

// [DECISION §7.2] originally 12s ("between the 5s combat and 20s strategy timeouts") — raised after
// live testing showed the configured reasoning-capable chat model (zai-org/GLM-5.1-FP8) consistently
// exceeds 12s on this call's structured tool-call response, timing out and silently falling back
// every time. 25s matches/slightly exceeds strategy-plan's budget, which uses a similar structured
// response shape.
const LEAGUE_PREDICTION_TIMEOUT_MS = 25_000;

export interface MatchContext {
  matchId: string;
  homeTeam: string;
  awayTeam: string;
  stage: LeagueStage;
  kickoffAt: string;
  // Lightweight context only — no external odds/news data (out of scope, §8)
  headToHead?: { homeWins: number; awayWins: number; draws: number };
}

export interface LeaguePredictionResult {
  winner: 'HOME' | 'AWAY' | 'DRAW';
  scoreHome: number;
  scoreAway: number;
  conviction: 'LOW' | 'MEDIUM' | 'HIGH';
  reasoning: string;
  source: 'AI' | 'FALLBACK';
}

// Same model, same reasoning-model latency profile as league-prediction — same 25s budget.
const POLYMARKET_SIGNAL_TIMEOUT_MS = 25_000;

export interface MarketContext {
  marketId: string;
  question: string;
  category?: string;
}

export interface PolymarketSignalResult {
  signal: 'YES' | 'NO';
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
  reasoning: string;
  source: 'AI' | 'FALLBACK';
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout: ${label} took longer than ${ms}ms`)), ms),
    ),
  ]);
}

function buildMatchPrompt(ctx: MatchContext): string {
  const h2h = ctx.headToHead
    ? `Head-to-head record: ${ctx.homeTeam} ${ctx.headToHead.homeWins}W - ${ctx.headToHead.draws}D - ${ctx.headToHead.awayWins}L ${ctx.awayTeam}.`
    : 'No head-to-head record available.';

  return `Match: ${ctx.homeTeam} vs ${ctx.awayTeam}
Stage: ${ctx.stage}
Kickoff: ${ctx.kickoffAt}
${h2h}
${ctx.stage !== 'GROUP' ? 'This is a knockout match — your prediction must pick a winner (no draw).' : ''}
Predict the winner, the final score, and your conviction level. Submit your prediction using the tool.`;
}

function buildMarketPrompt(ctx: MarketContext): string {
  return `Prediction market question: "${ctx.question}"${ctx.category ? `\nCategory: ${ctx.category}` : ''}
Give your read: will this resolve YES or NO? Submit your signal, confidence, and reasoning using the tool.`;
}

/**
 * Tribe system prompts — pre-launch acceptance gate requires the 4
 * archetypes to "produce distinguishably different prediction text" (§7.4).
 * Each entry fixes tone, vocabulary, and reasoning structure.
 */
export const TRIBE_SYSTEM_PROMPTS: Record<LeagueTribe, (traits: AgentTraitVector) => string> = {
  NEXUS_01: (traits) => `You are Nexus-01, a Statistician. You predict football matches using cold,
numerical reasoning. Reference form, tempo, and statistical tendencies in
your reasoning. Never use emotional language. Keep your conviction
proportional to how clear-cut the numbers are — only go HIGH conviction
when the data is one-sided. Agent traits: ${JSON.stringify(traits)}.`,

  SHADOW_9: (traits) => `You are Shadow-9, the Villain. You predict football matches with cynicism
and a taste for chaos. You enjoy picking against the crowd and you frame
your reasoning as if daring the favorite to prove you wrong. Lean toward
HIGH conviction when picking an underdog or an unpopular scoreline. Agent
traits: ${JSON.stringify(traits)}.`,

  ATHENA: (traits) => `You are Athena, the Oracle. You predict football matches with calm,
principled authority — as if the outcome were foretold. Your reasoning
is short, declarative, and confident without being boastful. Conviction
reflects how settled the outcome feels to you, not how popular the pick
is. Agent traits: ${JSON.stringify(traits)}.`,

  VOIDWALKER: (traits) => `You are Voidwalker, the Madman. You predict football matches by embracing
chaos — unconventional scorelines, wildcard reasoning, gut feeling over
logic. Your reasoning should feel unpredictable and a little unhinged, but
the winner/score/conviction fields must still be internally consistent.
Agent traits: ${JSON.stringify(traits)}.`,
};

/**
 * Same 4 tribe personas as League, rephrased for a generic YES/NO
 * Polymarket question instead of a match winner/score — kept as a
 * parallel map rather than reusing TRIBE_SYSTEM_PROMPTS verbatim, since
 * those hardcode "predict football matches" framing that doesn't fit
 * questions like transfer/award markets (docs/polymarket).
 */
export const POLYMARKET_TRIBE_SYSTEM_PROMPTS: Record<LeagueTribe, (traits: AgentTraitVector) => string> = {
  NEXUS_01: (traits) => `You are Nexus-01, a Statistician. You read prediction-market questions using
cold, numerical reasoning — base rates, form, and precedent. Never use
emotional language. Keep your confidence proportional to how one-sided the
evidence is; only go HIGH when the case is clear-cut. Agent traits:
${JSON.stringify(traits)}.`,

  SHADOW_9: (traits) => `You are Shadow-9, the Villain. You read prediction-market questions with
cynicism and a taste for chaos. You enjoy taking the contrarian side of a
crowded market and frame your reasoning as daring the consensus to prove
you wrong. Lean toward HIGH confidence when going against the popular
answer. Agent traits: ${JSON.stringify(traits)}.`,

  ATHENA: (traits) => `You are Athena, the Oracle. You read prediction-market questions with calm,
principled authority — as if the outcome were foretold. Your reasoning is
short, declarative, and confident without being boastful. Confidence
reflects how settled the outcome feels to you, not how popular the answer
is. Agent traits: ${JSON.stringify(traits)}.`,

  VOIDWALKER: (traits) => `You are Voidwalker, the Madman. You read prediction-market questions by
embracing chaos — wildcard reasoning, gut feeling over logic. Your
reasoning should feel unpredictable and a little unhinged, but the
signal/confidence fields must still be internally consistent. Agent
traits: ${JSON.stringify(traits)}.`,
};

export class InferenceGateway {
  private readonly compute: ZeroGComputeClient;

  constructor() {
    this.compute = new ZeroGComputeClient(getZeroGConfig());
  }

  /**
   * Infer the next combat action for an agent.
   *
   * Falls back to a deterministic heuristic on any error so the battle
   * never stalls waiting on inference. Fallback actions have confidence=0.2.
   */
  async inferCombatAction(params: CombatInferenceParams): Promise<CombatInferenceResult> {
    const modelVersion = params.modelVersion ?? 'v1';

    try {
      const result = await this.compute.inferCombatAction({
        agentId:         params.agentId,
        battleId:        params.battleId,
        modelVersion,
        battleState:     params.battleState,
        opponentProfile: params.opponentProfile,
        memoryContext:   params.memoryContext ?? [],
        timeoutMs:       params.timeoutMs ?? 5000,
      });

      return {
        action:           result.action,
        latencyMs:        result.latencyMs,
        source:           'AI',
        teeVerified:      result.traceInfo?.tee_verified ?? null,
        totalCostNeuron:  result.traceInfo?.billing?.total_cost,
      };
    } catch (err) {
      console.error('[InferenceGateway] Combat inference failed, using fallback:', err);

      // Deterministic fallback — never stall a battle tick
      const fallbackAction: CombatAction = {
        actionType:     'defend',
        aggressionBias: 0.3,
        confidence:     0.2,
      };

      return { action: fallbackAction, latencyMs: 0, source: 'FALLBACK' };
    }
  }

  /**
   * Infer a multi-tick strategic plan. Used at battle start.
   * Less latency-sensitive than per-tick combat actions.
   */
  async inferStrategyPlan(params: StrategyInferenceParams): Promise<{
    plan: StrategicPlan;
    source: 'AI' | 'FALLBACK';
  }> {
    try {
      const plan = await this.compute.inferStrategyPlan({
        agentId:         params.agentId,
        battleContext:   params.battleContext,
        opponentProfile: params.opponentProfile ?? {},
        useMemory:       params.useMemory ?? true,
      });

      return { plan, source: 'AI' };
    } catch (err) {
      console.error('[InferenceGateway] Strategy inference failed, using fallback:', err);

      const plan: StrategicPlan = {
        primaryObjective:      'survive',
        tacticalPriorities:    ['defend', 'conserve_resources', 'find_cover'],
        positioningPreference: 'defensive',
        engagementTiming:      'reactive',
        retreatThreshold:      0.25,
        estimatedDuration:     '3-5 minutes',
      };

      return { plan, source: 'FALLBACK' };
    }
  }

  /**
   * Predict the outcome of an upcoming football match for the KULTAI Agent
   * World Cup 2026 league (§7.2). Never throws — falls back to a
   * deterministic, per-(agent,match) prediction if 0G Compute is degraded or
   * returns an invalid response.
   */
  async decideLeaguePrediction(agentId: string, matchContext: MatchContext): Promise<LeaguePredictionResult> {
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) {
      throw new Error(`decideLeaguePrediction: agent ${agentId} not found`);
    }

    const traits = normalizeTraits(agent.traits);
    const tribe = mapAgentToTribe(agent.id, agent.archetype, traits);
    const systemPrompt = TRIBE_SYSTEM_PROMPTS[tribe](traits);

    try {
      const raw = await withTimeout(
        this.compute.inferLeaguePrediction(systemPrompt, buildMatchPrompt(matchContext)),
        LEAGUE_PREDICTION_TIMEOUT_MS,
        'inferLeaguePrediction',
      );

      const prediction = await this.validateOrRetry(raw, systemPrompt, matchContext);
      return { ...prediction, source: 'AI' };
    } catch (err) {
      console.error('[InferenceGateway] League prediction inference failed, using fallback:', err);
      const fallback = generateFallbackPrediction(agentId, matchContext.matchId, matchContext.stage, traits);
      return { ...fallback, source: 'FALLBACK' };
    }
  }

  /**
   * Validates an AI prediction; on failure, retries once with a corrective
   * message before giving up (§6.3). Throws if both attempts are invalid —
   * caller falls back to `generateFallbackPrediction`.
   */
  private async validateOrRetry(
    raw: LeaguePredictionToolArgs,
    systemPrompt: string,
    matchContext: MatchContext,
  ): Promise<LeaguePredictionToolArgs> {
    try {
      validatePrediction(raw, matchContext.stage);
      return raw;
    } catch (err) {
      const correctivePrompt = `${buildMatchPrompt(matchContext)}\n\nYour previous response was invalid: ${(err as Error).message}. Respond again with a coherent winner/score pair.`;

      const retry = await withTimeout(
        this.compute.inferLeaguePrediction(systemPrompt, correctivePrompt),
        LEAGUE_PREDICTION_TIMEOUT_MS,
        'inferLeaguePrediction (retry)',
      );
      validatePrediction(retry, matchContext.stage);
      return retry;
    }
  }

  /**
   * Read on a real Polymarket market question (docs/polymarket). Never
   * throws — falls back to a deterministic, per-(agent,market) signal if
   * 0G Compute is degraded or returns an invalid response, same shape as
   * decideLeaguePrediction.
   */
  async decidePolymarketSignal(agentId: string, marketContext: MarketContext): Promise<PolymarketSignalResult> {
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) {
      throw new Error(`decidePolymarketSignal: agent ${agentId} not found`);
    }

    const traits = normalizeTraits(agent.traits);
    const tribe = mapAgentToTribe(agent.id, agent.archetype, traits);
    const systemPrompt = POLYMARKET_TRIBE_SYSTEM_PROMPTS[tribe](traits);

    try {
      const signal = await withTimeout(
        this.compute.inferPolymarketSignal(systemPrompt, buildMarketPrompt(marketContext)),
        POLYMARKET_SIGNAL_TIMEOUT_MS,
        'inferPolymarketSignal',
      );
      return { ...signal, source: 'AI' };
    } catch (err) {
      console.error('[InferenceGateway] Polymarket signal inference failed, using fallback:', err);
      const fallback = generateFallbackSignal(agentId, marketContext.marketId, traits);
      return { ...fallback, source: 'FALLBACK' };
    }
  }

  /**
   * Generate a personality profile for a new agent.
   * Called during minting — not latency-sensitive.
   */
  async generatePersonality(seed: {
    name: string;
    description: string;
    clan: string;
    hints?: Record<string, number>;
  }): Promise<Record<string, unknown>> {
    return this.compute.generatePersonality(seed);
  }

  /**
   * Generate an avatar image for an agent.
   * Returns base64-encoded PNG (b64_json — only format supported by 0G z-image).
   */
  async generateAvatar(traits: {
    agentId: string;
    name: string;
    combatArchetype: string;
    clan: string;
    aggressionScore: number;
    evolutionStage: number;
  }): Promise<{ base64: string; mimeType: 'image/png' }> {
    return this.compute.generateAvatar(traits);
  }

  /**
   * Fetch the agent's currently active AI model record from the DB.
   */
  async getActiveModel(agentId: string) {
    return prisma.aIModel.findFirst({
      where: { agentId, isActive: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Generate a battle commentary paragraph using 0G Compute.
   *
   * Sends a rich prompt with all battle stats to the 0G Compute Router
   * (OpenAI-compatible, model: configurable via ZEROG_COMMENTARY_MODEL).
   * Returns a single dramatic paragraph suitable for storing as an agent memory.
   */
  async generateBattleCommentary(params: {
    battleId:        string;
    winnerName:      string;
    winnerArchetype: string;
    winnerClan:      string;
    winnerElo:       number;
    winnerHpPercent: number;
    loserName:       string;
    loserArchetype:  string;
    loserClan:       string;
    loserElo:        number;
    loserHpPercent:  number;
    durationSeconds: number;
    endReason:       string;
    gameName?:       string;
    playerStats?:    Record<string, {
      jumps: number;
      shotsAttempted: number;
      shotsConnected: number;
      timesHit:       number;
      distanceCovered: number;
    }>;
  }): Promise<{ commentary: string; teeVerified?: boolean | null }> {
    const model    = process.env.ZEROG_COMMENTARY_MODEL ?? 'zai-org/GLM-4-9B';
    const gameName = params.gameName ?? 'AI Arena';

    const winnerStats = params.playerStats?.[params.winnerName]
      ?? Object.values(params.playerStats ?? {})[0];
    const loserStats  = params.playerStats?.[params.loserName]
      ?? Object.values(params.playerStats ?? {})[1];

    // Game-specific stat line — Highway Hustle is distance-based, others are combat-based.
    const statsLine = (name: string, s?: typeof winnerStats) => {
      if (!s) return `${name}: stats unavailable`;
      if (gameName === 'Highway Hustle')
        return `${name}: ${s.distanceCovered}m driven before crash`;
      if (gameName === 'Robowar')
        return `${name}: dealt ${s.shotsConnected} hits · took ${s.timesHit} hits · ${s.distanceCovered}m moved`;
      return `${name}: ${s.jumps} jumps · ${s.shotsConnected} shots connected · took ${s.timesHit} hits · ${s.distanceCovered}m covered`;
    };

    // Game-specific context injected into the system prompt.
    const gameContext: Record<string, string> = {
      'Highway Hustle': 'an endless neon highway race where AI drivers dodge traffic at breakneck speed — the loser crashed while the winner survived longer',
      'Robowar':        'a brutal robot combat arena called the Crush Pit where bots battle to destruction',
    };
    const context = gameContext[gameName] ?? 'a futuristic AI combat league';

    // Human-readable end reason.
    const endReasonLabel =
      params.endReason === 'death'                ? 'KO'
      : params.endReason === 'timeout'            ? 'timeout'
      : params.endReason === 'highway-hustle-crash' ? 'crash'
      : params.endReason === 'robowar-battle-end'   ? 'destruction'
      : params.endReason;

    const prompt = `You are an electrifying AI Arena battle commentator for ${gameName} — ${context} running on the 0G decentralised network.

Write exactly ONE paragraph (2-3 sentences) of vivid, punchy post-match commentary for this battle. Be dramatic. Reference the fighters' archetypes and clans. Mention key stats. Allude to what this means for their on-chain legacy and ELO standing.

BATTLE SUMMARY
Game      : ${gameName}
Battle ID : ${params.battleId}
Winner    : ${params.winnerName} (${params.winnerArchetype} · ${params.winnerClan} clan · ${params.winnerElo} ELO) — ${params.winnerHpPercent}% HP remaining
Loser     : ${params.loserName} (${params.loserArchetype} · ${params.loserClan} clan · ${params.loserElo} ELO) — ${params.loserHpPercent}% HP remaining
Duration  : ${params.durationSeconds}s · ended by ${endReasonLabel}
${statsLine(params.winnerName, winnerStats)}
${statsLine(params.loserName, loserStats)}

Write the commentary paragraph now:`;

    try {
      const response = await (this.compute as any).openai.chat.completions.create({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 200,
        temperature: 0.85,
      });

      const commentary = (response.choices?.[0]?.message?.content ?? '').trim();
      const teeVerified = (response as any).x_0g_trace?.tee_verified ?? null;

      return { commentary: commentary || `An epic battle concluded in the ${gameName} arena.`, teeVerified };
    } catch (err) {
      console.error('[InferenceGateway] Battle commentary generation failed:', err);
      return {
        commentary: `${params.winnerName} (${params.winnerArchetype}) defeated ${params.loserName} (${params.loserArchetype}) in a ${params.durationSeconds}s clash, cementing their dominance in the ${gameName} AI Arena.`,
      };
    }
  }

  /**
   * F1 League — "AI Prediction" button on a driver's popup. Summarizes the
   * driver's real career/team stats via 0G Compute and predicts their
   * outlook for the upcoming Grand Prix. Not agent-specific (no personality
   * injected) -- this is a general analyst take on the driver, not one of
   * the player's own agents' opinion, so it needs no agentId.
   */
  async generateF1DriverPrediction(params: {
    driverName: string;
    abbr?: string | null;
    nationality?: string | null;
    number?: number | null;
    podiums?: number | null;
    careerPoints?: string | null;
    currentTeamName?: string | null;
    teamHistory?: Array<{ season: number; teamName: string }>;
    grandPrixName: string;
    circuitName?: string | null;
    latestSeasonStanding?: { position: number; points: number; wins: number; season: number } | null;
  }): Promise<{ prediction: string }> {
    const model = process.env.ZEROG_COMMENTARY_MODEL ?? 'zai-org/GLM-4-9B';

    const teamHistoryLine = (params.teamHistory ?? [])
      .slice(0, 6)
      .map((t) => `${t.season}: ${t.teamName}`)
      .join(' · ') || 'no recorded team history';

    const standingLine = params.latestSeasonStanding
      ? `P${params.latestSeasonStanding.position} in the ${params.latestSeasonStanding.season} standings, ${params.latestSeasonStanding.points} points, ${params.latestSeasonStanding.wins} wins`
      : 'no recent standings data available';

    const prompt = `You are a sharp, data-driven Formula 1 analyst. Based ONLY on the real stats below, predict how ${params.driverName} is likely to perform at the upcoming ${params.grandPrixName}${params.circuitName ? ` (${params.circuitName})` : ''}. Be specific and grounded in the numbers -- no generic hype.

DRIVER
Name          : ${params.driverName}${params.abbr ? ` (${params.abbr})` : ''}
Nationality   : ${params.nationality ?? 'unknown'}
Car number    : ${params.number ?? 'unknown'}
Career podiums: ${params.podiums ?? 'unknown'}
Career points : ${params.careerPoints ?? 'unknown'}
Current team  : ${params.currentTeamName ?? 'unknown'}
Team history  : ${teamHistoryLine}
Current season: ${standingLine}

Write 2-3 sentences of analysis, THEN end with one line in exactly this format:
Predicted finish: P<best-case position>-P<worst-case position>

Write it now:`;

    try {
      const response = await (this.compute as any).openai.chat.completions.create({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 220,
        temperature: 0.7,
      });
      const prediction = (response.choices?.[0]?.message?.content ?? '').trim();
      return { prediction: prediction || `${params.driverName} heads into the ${params.grandPrixName} with ${params.podiums ?? 0} career podiums to their name.` };
    } catch (err) {
      console.error('[InferenceGateway] F1 driver prediction generation failed:', err);
      return {
        prediction: `${params.driverName}${params.currentTeamName ? ` (${params.currentTeamName})` : ''} enters the ${params.grandPrixName} with ${params.podiums ?? 0} career podiums and ${params.careerPoints ?? 'an unknown number of'} career points.`,
      };
    }
  }

  /**
   * Check 0G Compute account balance (neuron units).
   * 1e18 neuron = 1 0G token. Alert if below threshold.
   */
  async checkBalance(): Promise<{ balance: number; currency: 'neuron'; lowBalance: boolean }> {
    const { balance } = await this.compute.getAccountBalance();
    const LOW_THRESHOLD = BigInt('1000000000000000000'); // 1 0G token in neuron
    return {
      balance,
      currency: 'neuron',
      lowBalance: BigInt(Math.round(balance)) < LOW_THRESHOLD,
    };
  }
}
