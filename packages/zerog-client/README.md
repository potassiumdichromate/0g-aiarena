# @ai-arena/zerog-client

Official 0G ecosystem integration package for AI Arena. Wraps:
- **0G Storage** (`@0gfoundation/0g-storage-ts-sdk`) — decentralised file storage
- **0G Compute Router** (`openai` SDK + custom baseURL) — AI inference and image generation
- **0G DA** — Data Availability adapter layer (abstracted, testnet unstable)

---

## Installation

```bash
pnpm install @0gfoundation/0g-storage-ts-sdk ethers openai
```

---

## 0G Storage

### How It Works

0G Storage is **content-addressed**. Files are stored by Merkle root hash — there are no path strings on-chain.

**Design pattern used in AI Arena:**
- `upload(data)` → returns `rootHash`
- Store `logicalPath → rootHash` in PostgreSQL (`storage_index` table)
- `download(rootHash)` → returns file content

### Mainnet Config
| Field | Value |
|-------|-------|
| Chain ID | 16661 |
| EVM RPC | `https://evmrpc.0g.ai` |
| Storage Indexer | `https://indexer-storage-turbo.0g.ai` |
| Flow Contract | `0x62D4144dB0F0a6fBBaeb6296c785C71B3D57C526` |
| Explorer | `https://chainscan.0g.ai` |

### Testnet Config
| Field | Value |
|-------|-------|
| Chain ID | 16600 |
| EVM RPC | `https://evmrpc-testnet.0g.ai` |
| Storage Indexer | `https://indexer-storage-testnet-turbo.0g.ai` |

### Usage

```typescript
import { ZeroGStorageClient, getZeroGConfig } from '@ai-arena/zerog-client';

const client = new ZeroGStorageClient(getZeroGConfig());

// Upload JSON (returns rootHash — store this in your DB)
const { rootHash, txHash } = await client.uploadJson({ agentId: 'abc', memory: [...] });

// Download by rootHash
const data = await client.downloadJson<AgentMemory>(rootHash);

// Upload with AES-256 encryption
import { randomBytes } from 'crypto';
const key = randomBytes(32);
const { rootHash } = await client.uploadBuffer(data, {
  encryption: { type: 'aes256', key }
});
const decrypted = await client.downloadToBuffer(rootHash, { symmetricKey: key });
```

---

## 0G Compute Router

OpenAI-compatible inference API. Base URL: `https://router-api.0g.ai/v1`

### Authentication
1. Go to **pc.0g.ai → Dashboard → API Keys**
2. Create key with **inference** permission
3. Key format: `sk-xxxxxxxxxxxxxxxxxxxxxxxx`
4. Set `ZEROG_COMPUTE_API_KEY=sk-...` in your `.env`
5. Deposit 0G tokens at **pc.0g.ai → Dashboard → Deposit**

### Billing
- Unit: **neuron** (1 0G = 1e18 neuron)
- Payment contract mainnet: `0xA3b15Bd2aD18BFB6b5f92D8AA9F444Dd59d1cE32`
- Payment contract testnet: `0x0AD9690e0b34aB2d493DE02cDF149ee34f6C9939`
- Check balance: `GET /v1/account/balance`

### Available Models
Full list: `GET https://router-api.0g.ai/v1/models` (no auth required)

| Model | Context | Use Case |
|-------|---------|----------|
| `zai-org/GLM-5-FP8` | 131,072 tokens | Chat, reasoning, strategy |
| `z-image` | — | Avatar / image generation |

### Verifiable Execution (TEE)
Add `verify_tee: true` to any request. The response will include:
```json
"x_0g_trace": {
  "request_id": "...",
  "provider": "0x...",
  "tee_verified": true,
  "billing": { "total_cost": 1234567890 }
}
```
Docs: https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/features/verifiable-execution

### Provider Routing
```typescript
// Route to lowest-latency provider
{ provider: { sort: 'latency', allow_fallbacks: true } }

// Route to lowest-cost provider
{ provider: { sort: 'price', allow_fallbacks: true } }

// Pin to specific provider (no fallback by default)
{ provider: { address: '0x...', allow_fallbacks: false } }
```

### Usage

```typescript
import { ZeroGComputeClient, getZeroGConfig } from '@ai-arena/zerog-client';

const client = new ZeroGComputeClient(getZeroGConfig());

// Combat action inference
const { action, latencyMs, traceInfo } = await client.inferCombatAction({
  agentId: 'agent-123',
  battleId: 'battle-456',
  modelVersion: 'v3',
  battleState: { ... },
  memoryContext: ['Agent prefers flanking', 'Weak against snipers'],
});

// Avatar generation (always b64_json — only format supported)
const { base64 } = await client.generateAvatar({
  agentId: 'agent-123',
  name: 'Shadow Wolf',
  combatArchetype: 'berserker',
  clan: 'solana',
  aggressionScore: 85,
  evolutionStage: 3,
});

// Check balance
const { balance } = await client.getAccountBalance(); // in neuron units
```

### Rate Limits
Response headers on every request:
```
X-RateLimit-Limit-Requests:     <limit per minute>
X-RateLimit-Remaining-Requests: <remaining this window>
X-RateLimit-Reset-Requests:     <ISO-8601 reset time>
```

On 429: honour `Retry-After` header — do not tight-loop retry.

### Error Codes
| HTTP | Code | Meaning |
|------|------|---------|
| 400 | `invalid_body` | Malformed request |
| 401 | `invalid_api_key` | Bad or missing key |
| 402 | `insufficient_balance` | Deposit more 0G tokens |
| 403 | `access_denied` | Key lacks permission |
| 429 | `rate_limit_exceeded` | Wait `Retry-After` seconds |
| 502 | `provider_error` | All providers failed |
| 503 | `no_available_provider` | No healthy provider for model |

---

## 0G Fine-tuning

Fine-tuning uses the **CLI** — not the Router API.

```bash
# Install CLI (requires Node >= 22)
pnpm install @0gfoundation/0g-compute-ts-sdk -g

# Configure
0g-compute-cli setup-network
0g-compute-cli login --private-key $ZEROG_STORAGE_PRIVATE_KEY
0g-compute-cli deposit --amount 10

# List available providers
0g-compute-cli fine-tuning list-providers

# Submit fine-tuning job
# Supported models: Qwen2.5-0.5B-Instruct | Qwen3-32B  (NOT arbitrary models)
0g-compute-cli fine-tuning create-task \
  --provider <PROVIDER_ADDRESS> \
  --model Qwen2.5-0.5B-Instruct \
  --dataset-path ./training_data.jsonl \
  --config-path ./training_config.json
```

Training config format:
```json
{
  "neftune_noise_alpha": 5,
  "num_train_epochs": 3,
  "per_device_train_batch_size": 2,
  "learning_rate": 0.0002,
  "max_steps": -1
}
```

**IMPORTANT**: Download and acknowledge the model within 48 hours of `Delivered` status or incur 30% fee penalty.

---

## 0G DA (Data Availability)

**Status**: Testnet unstable — use abstracted adapter.

```typescript
import { createDAAdapter } from '@ai-arena/zerog-client';

// Use local fallback (safe, no external deps)
const da = createDAAdapter('local');

// Use 0G DA (requires running gRPC disperser on port 51001)
const da = createDAAdapter('zerog');

const receipt = await da.submitBatch({ payload: Buffer.from('data') });
const data    = await da.retrieveBatch(receipt);
```

Future: swap to `'op-stack'` or `'arbitrum-nitro'` for rollup deployment.
- OP Stack docs: https://docs.0g.ai/developer-hub/building-on-0g/rollups-and-appchains/op-stack-on-0g-da
- Nitro docs:    https://docs.0g.ai/developer-hub/building-on-0g/rollups-and-appchains/arbitrum-nitro-on-0g-da

---

## Environment Variables

```bash
ZEROG_NETWORK=testnet                        # mainnet | testnet
ZEROG_EVM_RPC_MAINNET=https://evmrpc.0g.ai
ZEROG_EVM_RPC_TESTNET=https://evmrpc-testnet.0g.ai
ZEROG_STORAGE_INDEXER_MAINNET=https://indexer-storage-turbo.0g.ai
ZEROG_STORAGE_INDEXER_TESTNET=https://indexer-storage-testnet-turbo.0g.ai
ZEROG_STORAGE_PRIVATE_KEY=0x_your_key
ZEROG_COMPUTE_BASE_URL=https://router-api.0g.ai/v1
ZEROG_COMPUTE_API_KEY=sk-your-key
ZEROG_MODEL_CHAT=zai-org/GLM-5-FP8
ZEROG_MODEL_IMAGE=z-image
ZEROG_VERIFY_TEE=false
ZEROG_PROVIDER_SORT=latency
ZEROG_FINETUNE_PROVIDER=
ZEROG_FINETUNE_DEFAULT_MODEL=Qwen2.5-0.5B-Instruct
ZEROG_INFT_CONTRACT_ADDRESS=
ZEROG_INFT_ORACLE_ADDRESS=
```
