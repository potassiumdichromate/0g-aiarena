# agent-service

**Port: 8002**

Manages the full AI agent lifecycle. Every agent creation triggers a full 0G pipeline:
personality generation via 0G Compute, avatar generation via 0G Compute (`z-image`),
and both uploaded to **0G Storage mainnet** before the agent is persisted.

## 0G Integration

| Step | 0G Service | Detail |
|------|-----------|--------|
| Personality | 0G Compute `zai-org/GLM-5.1-FP8` | `generatePersonality({ name, description, clan, hints })` |
| Avatar | 0G Compute `z-image` | `generateAvatar(...)` → b64_json PNG |
| Avatar storage | 0G Storage mainnet | `upload(avatarPNG)` → `avatarRootHash` → indexed as `agents/{id}/avatar/v1` |
| Metadata storage | 0G Storage mainnet | `upload(metadataJSON)` → `metadataRootHash` → indexed as `agents/{id}/metadata/v1` |
| INFT minting | NATS → inft-service | Publishes `AGENT_CREATED { metadataRootHash, avatarRootHash }` |

Both rootHashes are stored in `storage_index` table and in the agent's `metadata` JSON column.
`inft-service` uses `metadataRootHash` as `encryptedMetadataHash` when minting the ERC-7857 INFT.

## API Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/agents` | JWT | Create agent — full 0G pipeline |
| `GET` | `/agents` | JWT | List agents (filter: `clan`, `archetype`, `page`, `limit`) |
| `GET` | `/agents/:id` | JWT | Full agent profile |
| `PATCH` | `/agents/:id` | JWT | Update name / metadata |
| `DELETE` | `/agents/:id` | JWT | Retire agent |
| `GET` | `/agents/:id/avatar` | JWT | Download avatar from 0G Storage → `{ base64, rootHash }` |
| `GET` | `/agents/:id/metadata` | JWT | Download metadata blob from 0G Storage |
| `POST` | `/agents/:id/train` | JWT | Queue training job |
| `GET` | `/agents/:id/training` | JWT | Training job history |
| `GET` | `/agents/:id/memory` | JWT | Memory summary (counts) |
| `POST` | `/agents/:id/clone` | JWT | Clone agent (reruns full creation) |
| `GET` | `/agents/:id/evolution` | JWT | Evolution status and eligibility |

## Environment Variables

```bash
ZEROG_NETWORK=mainnet
ZEROG_COMPUTE_API_KEY=sk-...
ZEROG_STORAGE_PRIVATE_KEY=0x...
ZEROG_MODEL_CHAT=zai-org/GLM-5.1-FP8
ZEROG_MODEL_IMAGE=z-image
DATABASE_URL=...
NATS_URL=...
```
