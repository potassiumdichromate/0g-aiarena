# inference-service

**Port: 8013**

Routes all AI inference to the **0G Compute Router** (`https://router-api.0g.ai/v1`).
Uses the OpenAI-compatible API with `tool_choice: required` for structured combat output.
Falls back to deterministic heuristics on error — battles never stall.

## 0G Compute Integration

| Feature | Detail |
|---------|--------|
| Base URL | `https://router-api.0g.ai/v1` |
| Auth | `sk-` API key from pc.0g.ai → Dashboard → API Keys |
| Default chat model | `zai-org/GLM-5.1-FP8` |
| Image model | `z-image` (avatar generation) |
| Audio model | `openai/whisper-large-v3` |
| Structured output | `tool_choice: { type: 'function', function: { name: 'combat_action' } }` |
| TEE verification | `verify_tee: true` when `ZEROG_VERIFY_TEE=true` |
| Provider routing | `provider: { sort: 'latency', allow_fallbacks: true }` |
| Billing | Neuron units — check balance via `GET /inference/balance` |

## Available Models (pc.0g.ai/api-reference)

| Model | Type | Use in AI Arena |
|-------|------|----------------|
| `zai-org/GLM-5.1-FP8` | Chat | Combat actions, strategy plans (default) |
| `deepseek/deepseek-chat-v3-0324` | Chat | Complex multi-step reasoning |
| `qwen/qwen3-vl-30b-a3b-instruct` | Chat | Vision + text (battle screenshot analysis) |
| `qwen3.6-plus` | Chat | Alternative chat model |
| `z-image` | Image | Avatar generation (b64_json only) |
| `openai/whisper-large-v3` | Audio | Battle commentary transcription |

## API Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/inference/action` | JWT | Combat action — Redis-cached 1s TTL, fallback on error |
| `POST` | `/inference/strategy` | JWT | Strategic plan (called once at battle start) |
| `POST` | `/inference/avatar` | JWT | Generate avatar via z-image → returns base64 PNG |
| `POST` | `/inference/personality` | JWT | Generate personality trait vector |
| `POST` | `/inference/transcribe` | JWT | Audio transcription via Whisper |
| `GET` | `/inference/balance` | JWT | 0G Compute neuron balance + low-balance flag |
| `GET` | `/inference/models/:agentId` | JWT | Active model for agent |

## Combat Action Request

```json
{
  "agentId": "uuid",
  "battleId": "uuid",
  "modelVersion": "v1",
  "battleState": { "agentHp": 80, "opponentHp": 45, "position": [12, 0, -8] },
  "memoryContext": ["prefers flanking", "weak against snipers"],
  "opponentProfile": { "archetype": "berserker", "avgAggression": 0.8 }
}
```

## Combat Action Response

```json
{
  "action": {
    "actionType": "flank",
    "targetX": 12.5,
    "targetZ": -8.3,
    "aggressionBias": 0.7,
    "confidence": 0.91
  },
  "latencyMs": 38,
  "source": "AI",
  "teeVerified": true,
  "totalCostNeuron": 1234567890
}
```

`source` is `"AI"` or `"FALLBACK"`. `teeVerified` is `null` if TEE not requested.

## Fallback Behaviour

On any 0G Compute error, returns a `defend` action with `confidence: 0.2` and `source: "FALLBACK"`.
This ensures battle ticks never stall waiting on inference.

## Rate Limits (from 0G Router)

Response headers on every request:
```
X-RateLimit-Limit-Requests:     <limit/min>
X-RateLimit-Remaining-Requests: <remaining>
X-RateLimit-Reset-Requests:     <ISO-8601 reset>
```

On HTTP 429: honour `Retry-After` header.

## Environment Variables

```bash
ZEROG_NETWORK=mainnet
ZEROG_COMPUTE_API_KEY=sk-...
ZEROG_COMPUTE_BASE_URL=https://router-api.0g.ai/v1
ZEROG_MODEL_CHAT=zai-org/GLM-5.1-FP8
ZEROG_MODEL_IMAGE=z-image
ZEROG_MODEL_AUDIO=openai/whisper-large-v3
ZEROG_VERIFY_TEE=false
ZEROG_PROVIDER_SORT=latency
DATABASE_URL=...
REDIS_URL=...
PORT=8013
```
