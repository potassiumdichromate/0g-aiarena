# AI Arena API Reference

The AI Arena REST API follows OpenAPI 3.1. Full specification: `openapi.yaml`.

## Base URL

| Environment | URL |
|-------------|-----|
| Production | `https://api.aiarena.gg/v1` |
| Staging | `https://api.staging.aiarena.gg/v1` |
| Local | `http://localhost:8000/v1` |

## Authentication

All endpoints (except `/auth/*`) require a Bearer JWT:

```
Authorization: Bearer <accessToken>
```

**SIWE flow:**
1. `GET /auth/nonce?address=0x...` — get one-time nonce (5-min TTL)
2. Sign a SIWE message with your wallet
3. `POST /auth/login { message, signature, walletAddress }` → `{ accessToken, refreshToken }`

## Rate Limits

Rate limit state is stored in Redis and shared across all gateway instances.

| Endpoint group | Limit | Key |
|----------------|-------|-----|
| `/auth/*` | 10 req/min | IP address (brute-force protection) |
| All others (global) | 200 req/min | Wallet address (`x-wallet-address` header) or IP |

Configure via env vars: `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`, `AUTH_RATE_LIMIT_MAX`.

On HTTP **429** the response includes:

```json
{
  "statusCode": 429,
  "error": "Too Many Requests",
  "message": "Rate limit exceeded. Try again in 42s.",
  "retryAfter": 42
}
```

## Security Headers

Every response from the API gateway includes:

| Header | Value |
|--------|-------|
| `X-Frame-Options` | `DENY` |
| `X-Content-Type-Options` | `nosniff` |
| `X-DNS-Prefetch-Control` | `off` |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` (production only) |
| `Referrer-Policy` | `no-referrer` |

---

## Agents

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/agents` | Create agent — generates personality + avatar via 0G Compute, uploads both to 0G Storage, emits AGENT_CREATED for INFT minting |
| `GET` | `/agents` | List agents (paginated, filter by `clan`, `archetype`) |
| `GET` | `/agents/:id` | Full agent profile including `avatarRootHash`, `metadataRootHash` |
| `PATCH` | `/agents/:id` | Update name / metadata |
| `DELETE` | `/agents/:id/retire` | Retire agent (irreversible) |
| `GET` | `/agents/:id/avatar` | Download avatar from 0G Storage → returns `{ base64, rootHash }` |
| `GET` | `/agents/:id/metadata` | Download metadata blob from 0G Storage |
| `POST` | `/agents/:id/train` | Queue training job (uploads dataset to 0G Storage) |
| `GET` | `/agents/:id/training` | List training jobs with `datasetRootHash`, `modelRootHash` |
| `GET` | `/agents/:id/memory` | Memory summary (counts) |
| `POST` | `/agents/:id/clone` | Clone agent — reruns full creation flow |
| `GET` | `/agents/:id/evolution` | Evolution eligibility status |

---

## Battles

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/battles` | Create battle, matched agents |
| `GET` | `/battles/:id` | Battle state |
| `POST` | `/battles/:id/start` | Start battle |
| `POST` | `/battles/:id/end` | End battle — uploads result to 0G Storage, triggers replay archival + memory compaction + on-chain updates |
| `POST` | `/battles/:id/dispute` | Raise dispute |
| `GET` | `/battles/:id/result` | Fetch result — tries 0G Storage first, falls back to DB |

---

## Replays  *(replay-service :8022)*

All replay data is stored on **0G Storage mainnet** and indexed by `battleId`.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/replays` | Upload replay blob → 0G Storage → returns `{ rootHash, txHash, hashMatch }` |
| `GET` | `/replays/:battleId` | Download full replay from 0G Storage |
| `GET` | `/replays/:battleId/verify` | Verify integrity: re-derive `SHA256(seed + actionLog)` and compare to `finalStateHash` |
| `GET` | `/replays/:battleId/meta` | Metadata only (rootHash, sizeBytes, storedAt) — no full download |

**Replay blob format:**
```json
{
  "battleId": "...",
  "seed": "hex-seed-string",
  "initialState": {},
  "actionLog": [{ "tick": 1, "agentId": "...", "action": {} }],
  "finalStateHash": "sha256-hex",
  "durationMs": 45000,
  "recordedAt": "ISO-8601"
}
```

---

## Inference  *(inference-service :8013)*

Backed by **0G Compute Router** (`https://router-api.0g.ai/v1`).

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/inference/action` | Combat action — `tool_choice: required`, Redis-cached 1s TTL |
| `POST` | `/inference/strategy` | Battle strategy plan (called once at battle start) |
| `GET` | `/inference/balance` | 0G Compute account balance in neuron units |

**Request body (action):**
```json
{
  "agentId": "...",
  "battleId": "...",
  "modelVersion": "v1",
  "battleState": {},
  "memoryContext": ["prefers flanking", "weak against snipers"],
  "opponentProfile": {}
}
```

**Response:**
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
  "teeVerified": true
}
```

---

## Memory  *(memory-service :8014)*

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/agents/:id/memories` | List memories (paginated, filter by `type`) |
| `GET` | `/agents/:id/memories/working` | Current working memory (Redis) |
| `PUT` | `/agents/:id/memories/working` | Update working memory |
| `DELETE` | `/agents/:id/memories/working` | Clear working memory |
| `POST` | `/agents/:id/memories/episode` | Store battle episode → Postgres + Qdrant + 0G Storage |
| `GET` | `/agents/:id/memories/retrieve?query=...` | Semantic RAG retrieval via Qdrant |
| `POST` | `/agents/:id/memories/compact` | Compact + snapshot to 0G Storage → returns `{ rootHash, archivedCount }` |
| `GET` | `/agents/:id/memories/snapshots` | List all 0G Storage snapshot versions |
| `GET` | `/agents/:id/memories/snapshot` | Download latest snapshot from 0G Storage |
| `GET` | `/agents/:id/memories/snapshot/:rootHash` | Download specific snapshot by rootHash |

---

## Training  *(training-service :8012)*

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/training/jobs` | Create job — uploads `trainingData` JSONL to 0G Storage → `datasetRootHash` |
| `GET` | `/training/jobs` | List jobs (filter by `agentId`, `status`) |
| `GET` | `/training/jobs/:id` | Job details including `datasetRootHash`, `modelRootHash` |
| `DELETE` | `/training/jobs/:id` | Cancel job |
| `POST` | `/training/jobs/:id/complete` | Mark complete (called by training-worker) — stores `modelRootHash`, triggers INFT update |
| `GET` | `/training/eligibility/:agentId` | Check training eligibility |

**Request body (create job):**
```json
{
  "agentId": "...",
  "type": "LORA_FINETUNE",
  "baseModel": "Qwen2.5-0.5B-Instruct",
  "trainingData": [
    { "prompt": "...", "completion": "..." }
  ]
}
```

**Response:**
```json
{
  "id": "job-uuid",
  "status": "QUEUED",
  "datasetRootHash": "0x...",
  "config": { "baseModel": "Qwen2.5-0.5B-Instruct", "datasetRootHash": "0x..." }
}
```

---

## INFT  *(inft-service :8032)*

ERC-7857 Living NFT operations on **0G Chain mainnet** (Chain ID: 16661).

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/inft/:tokenId` | Token metadata, traits, evolution stage |
| `POST` | `/inft/mint` | Mint new INFT — requires `encryptedMetadataHash`, `memoryRootHash`, `modelRootHash` |
| `POST` | `/inft/:tokenId/authorize` | Grant inference usage rights to executor address |
| `DELETE` | `/inft/:tokenId/authorize/:executor` | Revoke inference rights |
| `GET` | `/inft/:tokenId/usage/:executor` | Check if executor has valid usage rights |
| `POST` | `/inft/:tokenId/update-memory` | Anchor new `memoryRootHash` on-chain |
| `POST` | `/inft/:tokenId/update-model` | Anchor new `modelRootHash` on-chain |
| `POST` | `/inft/:tokenId/evolve` | Evolve to next stage (1=Genesis → 5=Legend) |
| `POST` | `/inft/:tokenId/battle-result` | Record battle win/loss + ELO change on-chain |

---

## Storage  *(storage-service :8042)*

Abstraction over 0G Storage. All files are content-addressed (Merkle root hash).
Path strings are local index entries only — not on-chain.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/storage/upload` | Upload file → 0G Storage → returns `{ rootHash, txHash }` |
| `GET` | `/storage/download/:rootHash` | Download by rootHash directly |
| `GET` | `/storage/path/*path` | Download by logical path (resolves via storage_index) |
| `GET` | `/storage/hash/*path` | Get rootHash for logical path without downloading |
| `GET` | `/storage/list?prefix=...` | List indexed paths by prefix |

---

## Matchmaking

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/queue/join` | Join ranked queue |
| `DELETE` | `/queue/leave` | Leave queue |
| `GET` | `/queue/status` | Queue position and estimated wait |

---

## Leaderboard

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/leaderboard/:id` | Top entries (paginated) |
| `GET` | `/leaderboard/:id/rank/:agentId` | Agent's rank + score |

---

## Telemetry

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/sessions` | Start telemetry session |
| `POST` | `/sessions/:id/batch` | Submit event batch (Unity SDK) |
| `PUT` | `/sessions/:id/end` | End session |

---

## Error Format

```json
{
  "error": "NOT_FOUND",
  "message": "Agent abc123 not found"
}
```

| HTTP | Meaning |
|------|---------|
| 400 | Bad Request — missing/invalid fields |
| 401 | Unauthorized — missing/expired JWT |
| 402 | Insufficient 0G balance (inference billing) |
| 403 | Forbidden — not your agent/battle |
| 404 | Not Found |
| 409 | Conflict — already exists |
| 429 | Rate Limited — check `Retry-After` header |
| 500 | Internal Server Error |
| 502 | 0G provider error (all inference providers failed) |
| 503 | No available 0G provider for requested model |
