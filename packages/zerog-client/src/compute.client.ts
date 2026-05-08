/**
 * 0G Compute Router client.
 *
 * The Router exposes an OpenAI-compatible API at https://router-api.0g.ai/v1
 * We use the official `openai` npm package with a custom baseURL.
 *
 * Authentication: Bearer sk-YOUR_API_KEY
 *   Keys created at: pc.0g.ai → Dashboard → API Keys (requires "inference" permission)
 *   Docs: https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/authentication
 *
 * Billing: neuron units (1e18 neuron = 1 0G token)
 *   Deposit at: pc.0g.ai → Dashboard → Deposit
 *   Payment contract mainnet: 0xA3b15Bd2aD18BFB6b5f92D8AA9F444Dd59d1cE32
 *
 * Models: GET https://router-api.0g.ai/v1/models (no auth required)
 *   Example: zai-org/GLM-5-FP8 (131K context)
 *
 * Verifiable Execution: add verify_tee: true — result in x_0g_trace.tee_verified
 *   Docs: https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/features/verifiable-execution
 */

import OpenAI from 'openai';
import { ZeroGConfig } from './config';

// ── Extended response types for 0G-specific fields ────────────────────────────

export interface ZeroGTrace {
  request_id: string;
  provider: string;        // On-chain provider address
  billing: {
    input_cost: number;    // neuron units
    output_cost: number;
    total_cost: number;
  };
  tee_verified?: boolean | null;  // true=valid, false=invalid, null=not requested
}

export interface ZeroGChatCompletion extends OpenAI.Chat.ChatCompletion {
  x_0g_trace?: ZeroGTrace;
  reasoning_content?: string;   // For thinking models
}

// ── Request types ─────────────────────────────────────────────────────────────

export interface CombatActionRequest {
  agentId: string;
  battleId: string;
  modelVersion: string;
  battleState: Record<string, unknown>;
  memoryContext?: string[];
  opponentProfile?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface CombatAction {
  actionType: 'move' | 'attack' | 'ability' | 'retreat' | 'flank' | 'defend' | 'idle';
  targetX?: number;
  targetZ?: number;
  targetEntityId?: string;
  weaponId?: string;
  abilityId?: string;
  aggressionBias: number;   // 0-1
  confidence: number;       // 0-1
}

export interface StrategyPlanRequest {
  agentId: string;
  battleContext: Record<string, unknown>;
  opponentProfile: Record<string, unknown>;
  useMemory: boolean;
}

export interface StrategicPlan {
  primaryObjective: string;
  tacticalPriorities: string[];
  positioningPreference: string;
  engagementTiming: string;
  retreatThreshold: number;
  estimatedDuration: string;
}

export interface ImageGenerationResult {
  base64: string;          // b64_json (only format 0G currently supports)
  mimeType: 'image/png';
  traceInfo?: ZeroGTrace;
}

export interface ProviderRoutingOptions {
  sort?: 'latency' | 'price';
  address?: string;        // Pin to specific on-chain provider address
  allowFallbacks?: boolean;
}

// ── Client ────────────────────────────────────────────────────────────────────

export class ZeroGComputeClient {
  private readonly openai: OpenAI;
  private readonly config: ZeroGConfig;

  constructor(config: ZeroGConfig) {
    this.config = config;

    if (!config.computeApiKey || !config.computeApiKey.startsWith('sk-')) {
      console.warn(
        '[ZeroGComputeClient] ZEROG_COMPUTE_API_KEY missing or malformed. ' +
        'Create one at pc.0g.ai → Dashboard → API Keys (requires "inference" permission).',
      );
    }

    this.openai = new OpenAI({
      apiKey: config.computeApiKey,
      baseURL: config.computeBaseUrl,   // https://router-api.0g.ai/v1
      defaultHeaders: {
        'Content-Type': 'application/json',
      },
    });
  }

  // ── Inference: Combat Action ───────────────────────────────────────────────

  /**
   * Request a real-time combat action from an AI agent's model.
   *
   * Uses tool_choice: "required" for structured output so we never
   * have to parse free-text action strings.
   *
   * verify_tee is passed as a 0G Router extension field.
   * The result includes x_0g_trace.tee_verified when enabled.
   */
  async inferCombatAction(req: CombatActionRequest): Promise<{
    action: CombatAction;
    latencyMs: number;
    traceInfo?: ZeroGTrace;
  }> {
    const start = Date.now();

    const systemPrompt = `You are the combat AI controller for agent ${req.agentId}.
Your task is to decide the next combat action given the current battle state.
Always respond using the combat_action tool with valid, physically possible actions.
Base decisions on the agent's personality traits and memory context.`;

    const userContent = `Battle State: ${JSON.stringify(req.battleState)}
${req.opponentProfile ? `Opponent Profile: ${JSON.stringify(req.opponentProfile)}` : ''}
${req.memoryContext?.length ? `Memory Context: ${req.memoryContext.join('\n')}` : ''}
Decide the next action.`;

    const routingBody = this.buildProviderField();

    // The openai SDK doesn't know about 0G extension fields,
    // so we pass them via the `body` escape hatch.
    const response = await (this.openai.chat.completions.create as Function)({
      model: this.config.modelChat,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userContent  },
      ],
      max_tokens: 256,
      temperature: 0.3,
      tools: [COMBAT_ACTION_TOOL],
      tool_choice: { type: 'function', function: { name: 'combat_action' } },
      // 0G Router extension fields:
      ...(this.config.verifyTee && { verify_tee: true }),
      ...(routingBody && { provider: routingBody }),
    }) as ZeroGChatCompletion;

    const toolCall = response.choices[0]?.message?.tool_calls?.[0];
    if (!toolCall) throw new Error('No tool call returned from 0G Compute');

    const parsed = JSON.parse(toolCall.function.arguments) as CombatAction;

    return {
      action: parsed,
      latencyMs: Date.now() - start,
      traceInfo: response.x_0g_trace,
    };
  }

  // ── Inference: Strategic Plan ──────────────────────────────────────────────

  async inferStrategyPlan(req: StrategyPlanRequest): Promise<StrategicPlan> {
    const systemPrompt = `You are a strategic planning system for AI arena agent ${req.agentId}.
Analyse the battle context and opponent profile, then produce a structured strategic plan.`;

    const response = await (this.openai.chat.completions.create as Function)({
      model: this.config.modelChat,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `Battle Context: ${JSON.stringify(req.battleContext)}\nOpponent: ${JSON.stringify(req.opponentProfile)}`,
        },
      ],
      max_tokens: 512,
      temperature: 0.5,
      tools: [STRATEGY_PLAN_TOOL],
      tool_choice: { type: 'function', function: { name: 'strategic_plan' } },
      ...(this.config.verifyTee && { verify_tee: true }),
      ...this.buildProviderField() && { provider: this.buildProviderField() },
    }) as ZeroGChatCompletion;

    const toolCall = response.choices[0]?.message?.tool_calls?.[0];
    if (!toolCall) throw new Error('No tool call returned from 0G Compute');
    return JSON.parse(toolCall.function.arguments) as StrategicPlan;
  }

  // ── Agent Personality Generation ──────────────────────────────────────────

  async generatePersonality(seed: {
    name: string;
    description: string;
    clan: string;
    hints?: Record<string, number>;
  }): Promise<Record<string, unknown>> {
    const response = await this.openai.chat.completions.create({
      model: this.config.modelChat,
      messages: [
        {
          role: 'system',
          content: 'You are an AI personality generator for autonomous game agents. Generate rich, consistent personality trait vectors.',
        },
        {
          role: 'user',
          content: `Generate a personality profile for an AI arena agent:\nName: ${seed.name}\nDescription: ${seed.description}\nClan: ${seed.clan}\nHints: ${JSON.stringify(seed.hints ?? {})}`,
        },
      ],
      max_tokens: 1024,
      temperature: 0.8,
      response_format: { type: 'json_object' },
    });

    const content = response.choices[0]?.message?.content ?? '{}';
    return JSON.parse(content);
  }

  // ── Avatar Generation ──────────────────────────────────────────────────────

  /**
   * Generate an agent avatar using 0G Compute image generation.
   *
   * IMPORTANT: response_format must be "b64_json" — URL format not yet supported.
   * Model: z-image (verify at GET /v1/models)
   * Docs: https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/features/image-generation
   *
   * For production load, use the async endpoint:
   *   POST /v1/async/images/generations  → returns jobId
   *   GET  /v1/async/jobs/{jobId}?provider_address={addr} → poll for result
   */
  async generateAvatar(traits: {
    agentId: string;
    name: string;
    combatArchetype: string;
    clan: string;
    aggressionScore: number;
    evolutionStage: number;
  }): Promise<ImageGenerationResult> {
    const archetypeDescriptions: Record<string, string> = {
      berserker: 'fierce, battle-scarred, intense red eyes, heavy armor',
      tactician: 'calculating, sleek chrome visor, strategic posture, blue neural patterns',
      defender:  'massive shield, reinforced plating, steady stance, green energy fields',
      sniper:    'long-range optics, camouflage patterns, precise targeting reticle, dark silhouette',
      hybrid:    'balanced combat gear, adaptive armor plating, neutral expression',
    };

    const clanStyles: Record<string, string> = {
      solana:  'purple and green holographic energy, Solana speed aesthetic',
      base:    'blue and white clean geometric design, Base minimalist aesthetic',
      '0g':    'golden and silver, decentralized network node aesthetic, 0G chain insignia',
    };

    const prompt = `Sci-fi AI combat robot portrait, ${archetypeDescriptions[traits.combatArchetype] ?? ''}, ` +
      `${clanStyles[traits.clan.toLowerCase()] ?? ''}, ` +
      `evolution stage ${traits.evolutionStage}/5, ` +
      `high detail, dramatic lighting, game character art style, dark background, ` +
      `professional game asset quality`;

    const response = await this.openai.images.generate({
      model: this.config.modelImage,
      prompt,
      n: 1,
      size: '1024x1024',
      response_format: 'b64_json',  // Only supported format on 0G currently
    } as OpenAI.ImageGenerateParams);

    const b64 = response.data[0]?.b64_json;
    if (!b64) throw new Error('No image data returned from 0G Compute image generation');

    return { base64: b64, mimeType: 'image/png' };
  }

  // ── Account Balance ────────────────────────────────────────────────────────

  /**
   * Check 0G Compute account balance.
   * Balance is in neuron units (1e18 neuron = 1 0G token).
   * Endpoint: GET /v1/account/balance
   */
  async getAccountBalance(): Promise<{ balance: number; currency: 'neuron' }> {
    const response = await fetch(`${this.config.computeBaseUrl}/account/balance`, {
      headers: { Authorization: `Bearer ${this.config.computeApiKey}` },
    });

    if (!response.ok) {
      throw new Error(`Balance check failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as { balance: number };
    return { balance: data.balance, currency: 'neuron' };
  }

  // ── Available Models ───────────────────────────────────────────────────────

  /**
   * Fetch available models from the Router.
   * No authentication required.
   * Endpoint: GET /v1/models
   */
  async listModels(): Promise<OpenAI.Model[]> {
    const models = await this.openai.models.list();
    return models.data;
  }

  // ── Rate-limit aware helper ────────────────────────────────────────────────

  /**
   * Extract rate-limit info from response headers.
   * Headers: X-RateLimit-Limit-Requests, X-RateLimit-Remaining-Requests,
   *          X-RateLimit-Reset-Requests
   */
  parseRateLimitHeaders(headers: Headers): {
    limit: number;
    remaining: number;
    resetAt: Date;
  } | null {
    const limit     = headers.get('X-RateLimit-Limit-Requests');
    const remaining = headers.get('X-RateLimit-Remaining-Requests');
    const reset     = headers.get('X-RateLimit-Reset-Requests');

    if (!limit || !remaining || !reset) return null;

    return {
      limit:     parseInt(limit),
      remaining: parseInt(remaining),
      resetAt:   new Date(reset),
    };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private buildProviderField(): Record<string, unknown> | null {
    if (!this.config.providerSort) return null;
    return { sort: this.config.providerSort, allow_fallbacks: true };
  }
}

// ── Tool schemas for structured output ────────────────────────────────────────

const COMBAT_ACTION_TOOL: OpenAI.Chat.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'combat_action',
    description: 'Submit the next combat action for the AI agent to execute this tick.',
    parameters: {
      type: 'object',
      properties: {
        actionType: {
          type: 'string',
          enum: ['move', 'attack', 'ability', 'retreat', 'flank', 'defend', 'idle'],
        },
        targetX:        { type: 'number', description: 'World X coordinate of target position' },
        targetZ:        { type: 'number', description: 'World Z coordinate of target position' },
        targetEntityId: { type: 'string', description: 'ID of the entity to target (for attack/ability)' },
        weaponId:       { type: 'string', description: 'Weapon to activate' },
        abilityId:      { type: 'string', description: 'Ability to activate' },
        aggressionBias: { type: 'number', minimum: 0, maximum: 1, description: 'Aggression multiplier for this action' },
        confidence:     { type: 'number', minimum: 0, maximum: 1, description: 'Confidence in this decision' },
      },
      required: ['actionType', 'aggressionBias', 'confidence'],
    },
  },
};

const STRATEGY_PLAN_TOOL: OpenAI.Chat.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'strategic_plan',
    description: 'Output a structured strategic plan for the upcoming battle phase.',
    parameters: {
      type: 'object',
      properties: {
        primaryObjective:       { type: 'string' },
        tacticalPriorities:     { type: 'array', items: { type: 'string' }, maxItems: 5 },
        positioningPreference:  { type: 'string' },
        engagementTiming:       { type: 'string' },
        retreatThreshold:       { type: 'number', minimum: 0, maximum: 1 },
        estimatedDuration:      { type: 'string' },
      },
      required: ['primaryObjective', 'tacticalPriorities', 'retreatThreshold'],
    },
  },
};
