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
