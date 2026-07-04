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

export interface LeaguePredictionToolArgs {
  winner: 'HOME' | 'AWAY' | 'DRAW';
  scoreHome: number;
  scoreAway: number;
  conviction: 'LOW' | 'MEDIUM' | 'HIGH';
  reasoning: string;
}

export interface PolymarketSignalToolArgs {
  signal: 'YES' | 'NO';
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
  reasoning: string;
}

export interface ImageGenerationResult {
  base64: string;          // b64_json (only format 0G currently supports)
  mimeType: 'image/png';
  traceInfo?: ZeroGTrace;
}

export interface AudioTranscriptionResult {
  text: string;
  language?: string;
  duration?: number;       // seconds
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
    const content   = response.choices[0]?.message?.content ?? '';

    // Primary: structured tool call
    if (toolCall?.function?.arguments) {
      try {
        const parsed = parseToolArguments<CombatAction>(toolCall.function.arguments);
        return { action: parsed, latencyMs: Date.now() - start, traceInfo: response.x_0g_trace };
      } catch {
        // fall through to content extraction
      }
    }

    // Fallback: extract JSON object from message content (for models that ignore tool_choice)
    if (content) {
      try {
        const parsed = parseToolArguments<CombatAction>(content);
        return { action: parsed, latencyMs: Date.now() - start, traceInfo: response.x_0g_trace };
      } catch {
        // fall through to error
      }
    }

    throw new Error('No parseable combat action in 0G Compute response');
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
    const content  = response.choices[0]?.message?.content ?? '';

    // Primary: structured tool call
    if (toolCall?.function?.arguments) {
      try {
        return parseToolArguments<StrategicPlan>(toolCall.function.arguments);
      } catch {
        // fall through to content extraction
      }
    }

    // Fallback: extract JSON from message content (models that return XML or free-text)
    if (content) {
      return parseToolArguments<StrategicPlan>(content);
    }

    throw new Error('No parseable strategic plan in 0G Compute response');
  }

  // ── Inference: League Prediction ───────────────────────────────────────────

  /**
   * Request a structured football match prediction (KULTAI Agent World Cup
   * 2026 — architecture §7.1). `systemPrompt` carries the tribe voice
   * (TRIBE_SYSTEM_PROMPTS), `userPrompt` carries the match context.
   */
  async inferLeaguePrediction(
    systemPrompt: string,
    userPrompt: string,
    opts: { maxTokens?: number; temperature?: number } = {},
  ): Promise<LeaguePredictionToolArgs> {
    const response = await (this.openai.chat.completions.create as Function)({
      model: this.config.modelChat,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      // 300 was too tight for a thinking model (see parseToolArguments' doc comment on
      // GLM-5.1-FP8 prepending chain-of-thought): the reasoning alone could exhaust the
      // budget before the model ever emitted the tool call, leaving nothing parseable.
      max_tokens: opts.maxTokens ?? 1200,
      temperature: opts.temperature ?? 0.7,
      tools: [LEAGUE_PREDICTION_TOOL],
      tool_choice: { type: 'function', function: { name: 'submit_league_prediction' } },
      ...(this.config.verifyTee && { verify_tee: true }),
      ...(this.buildProviderField() && { provider: this.buildProviderField() }),
    }) as ZeroGChatCompletion;

    const toolCall = response.choices[0]?.message?.tool_calls?.[0];
    const content = response.choices[0]?.message?.content ?? '';

    if (toolCall?.function?.arguments) {
      try {
        return parseToolArguments<LeaguePredictionToolArgs>(toolCall.function.arguments);
      } catch {
        // fall through to content extraction
      }
    }

    if (content) {
      return parseToolArguments<LeaguePredictionToolArgs>(content);
    }

    throw new Error('No parseable league prediction in 0G Compute response');
  }

  // ── Inference: Polymarket Signal ───────────────────────────────────────────

  /**
   * Request a structured YES/NO read on a real Polymarket market question
   * (docs/polymarket/knowledge_polymarket.md). `systemPrompt` carries the
   * agent's tribe voice (same TRIBE_SYSTEM_PROMPTS as League), `userPrompt`
   * carries the market question. Same tool-call-with-content-fallback and
   * <think>-stripping shape as inferLeaguePrediction — same model, same
   * failure modes apply, so max_tokens is deliberately generous here too.
   */
  async inferPolymarketSignal(
    systemPrompt: string,
    userPrompt: string,
    opts: { maxTokens?: number; temperature?: number } = {},
  ): Promise<PolymarketSignalToolArgs> {
    const response = await (this.openai.chat.completions.create as Function)({
      model: this.config.modelChat,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: opts.maxTokens ?? 1200,
      temperature: opts.temperature ?? 0.7,
      tools: [POLYMARKET_SIGNAL_TOOL],
      tool_choice: { type: 'function', function: { name: 'submit_polymarket_signal' } },
      ...(this.config.verifyTee && { verify_tee: true }),
      ...(this.buildProviderField() && { provider: this.buildProviderField() }),
    }) as ZeroGChatCompletion;

    const toolCall = response.choices[0]?.message?.tool_calls?.[0];
    const content = response.choices[0]?.message?.content ?? '';

    if (toolCall?.function?.arguments) {
      try {
        return parseToolArguments<PolymarketSignalToolArgs>(toolCall.function.arguments);
      } catch {
        // fall through to content extraction
      }
    }

    if (content) {
      return parseToolArguments<PolymarketSignalToolArgs>(content);
    }

    throw new Error('No parseable Polymarket signal in 0G Compute response');
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

    const b64 = response.data?.[0]?.b64_json;
    if (!b64) throw new Error('No image data returned from 0G Compute image generation');

    return { base64: b64, mimeType: 'image/png' };
  }

  // ── Audio Transcription ────────────────────────────────────────────────────

  /**
   * Transcribe audio using 0G Compute Router.
   * Model: openai/whisper-large-v3
   * Endpoint: POST /v1/audio/transcriptions (OpenAI-compatible)
   * Use cases: battle voice commentary, agent audio logs
   *
   * @param audioBuffer  Raw audio bytes (mp3, mp4, wav, webm, etc.)
   * @param filename     Filename with extension — used to detect MIME type
   * @param language     ISO-639-1 language hint (optional, improves accuracy)
   */
  async transcribeAudio(
    audioBuffer: Buffer,
    filename: string,
    language?: string,
  ): Promise<AudioTranscriptionResult> {
    const { toFile } = await import('openai');

    const file = await toFile(audioBuffer, filename);

    const response = await this.openai.audio.transcriptions.create({
      model:    this.config.modelAudio,   // openai/whisper-large-v3
      file,
      ...(language && { language }),
      response_format: 'verbose_json',
    } as Parameters<typeof this.openai.audio.transcriptions.create>[0]);

    const result = response as unknown as {
      text: string; language?: string; duration?: number;
    };

    return {
      text:     result.text,
      language: result.language,
      duration: result.duration,
    };
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

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Some 0G compute "thinking" models (e.g. GLM-5.1-FP8) prepend chain-of-thought
 * text or <think>...</think> blocks before the JSON in tool_call.function.arguments.
 * This helper strips any leading non-JSON text and extracts the first valid JSON object.
 */
function parseToolArguments<T>(raw: string): T {
  // Fast path: already valid JSON
  try {
    return JSON.parse(raw) as T;
  } catch {
    // Strip <think>...</think> reasoning blocks (GLM/Qwen thinking models)
    let cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

    try {
      return JSON.parse(cleaned) as T;
    } catch {
      // Extract the first {...} block from whatever text remains
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try { return JSON.parse(jsonMatch[0]) as T; } catch { /* fall through */ }
      }

      // Handle XML tool_call format some models return:
      // <tool_call>name<arg_key>k</arg_key><arg_value>v</arg_value>...
      if (cleaned.includes('<tool_call>') || cleaned.includes('<arg_key>')) {
        const obj: Record<string, unknown> = {};
        const kv = /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/gi;
        let m: RegExpExecArray | null;
        while ((m = kv.exec(cleaned)) !== null) {
          const key = m[1].trim();
          const valStr = m[2].trim();
          // Try to parse nested JSON (arrays, numbers, booleans)
          let val: unknown;
          try { val = JSON.parse(valStr); } catch { val = valStr; }
          obj[key] = val;
        }
        if (Object.keys(obj).length > 0) return obj as T;
      }

      throw new SyntaxError(`Cannot parse tool arguments as JSON: ${raw.substring(0, 120)}`);
    }
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

export const LEAGUE_PREDICTION_TOOL: OpenAI.Chat.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'submit_league_prediction',
    description: 'Submit a structured prediction for an upcoming football match.',
    parameters: {
      type: 'object',
      properties: {
        winner:     { type: 'string', enum: ['HOME', 'AWAY', 'DRAW'] },
        scoreHome:  { type: 'integer', minimum: 0, maximum: 20 },
        scoreAway:  { type: 'integer', minimum: 0, maximum: 20 },
        conviction: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
        reasoning:  { type: 'string', description: 'One or two sentences, in your archetype voice.' },
      },
      required: ['winner', 'scoreHome', 'scoreAway', 'conviction', 'reasoning'],
      additionalProperties: false,
    },
  },
};

export const POLYMARKET_SIGNAL_TOOL: OpenAI.Chat.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'submit_polymarket_signal',
    description: 'Submit a structured YES/NO read on a real Polymarket prediction market question.',
    parameters: {
      type: 'object',
      properties: {
        signal:     { type: 'string', enum: ['YES', 'NO'] },
        confidence: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
        reasoning:  { type: 'string', description: 'One or two sentences, in your archetype voice.' },
      },
      required: ['signal', 'confidence', 'reasoning'],
      additionalProperties: false,
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
