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
} from '@ai-arena/zerog-client';
import { prisma } from '@ai-arena/db-client';

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
    playerStats?:    Record<string, {
      jumps: number;
      shotsAttempted: number;
      shotsConnected: number;
      timesHit:       number;
      distanceCovered: number;
    }>;
  }): Promise<{ commentary: string; teeVerified?: boolean | null }> {
    const model = process.env.ZEROG_COMMENTARY_MODEL ?? 'zai-org/GLM-4-9B';

    const winnerStats = params.playerStats?.[params.winnerName]
      ?? Object.values(params.playerStats ?? {})[0];
    const loserStats  = params.playerStats?.[params.loserName]
      ?? Object.values(params.playerStats ?? {})[1];

    const statsLine = (name: string, s?: typeof winnerStats) =>
      s ? `${name}: ${s.jumps} jumps · ${s.shotsConnected} shots connected · took ${s.timesHit} hits · ${s.distanceCovered}m covered`
        : `${name}: stats unavailable`;

    const prompt = `You are an electrifying AI Arena battle commentator for WarzoneWarrior — a futuristic AI combat league running on the 0G decentralised network.

Write exactly ONE paragraph (2-3 sentences) of vivid, punchy post-match commentary for this battle. Be dramatic. Reference the fighters' archetypes and clans. Mention key stats. Allude to what this means for their on-chain legacy and ELO standing.

BATTLE SUMMARY
Battle ID : ${params.battleId}
Winner    : ${params.winnerName} (${params.winnerArchetype} · ${params.winnerClan} clan · ${params.winnerElo} ELO) — ${params.winnerHpPercent}% HP remaining
Loser     : ${params.loserName} (${params.loserArchetype} · ${params.loserClan} clan · ${params.loserElo} ELO) — ${params.loserHpPercent}% HP remaining
Duration  : ${params.durationSeconds}s · ended by ${params.endReason === 'death' ? 'KO' : 'timeout'}
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

      return { commentary: commentary || 'An epic battle concluded in the WarzoneWarrior arena.', teeVerified };
    } catch (err) {
      console.error('[InferenceGateway] Battle commentary generation failed:', err);
      return {
        commentary: `${params.winnerName} (${params.winnerArchetype}) defeated ${params.loserName} (${params.loserArchetype}) in a ${params.durationSeconds}s clash, cementing their dominance in the WarzoneWarrior AI Arena.`,
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
