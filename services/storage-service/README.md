# storage-service

**Port: 8042**

Abstraction layer over **0G Storage mainnet**. Provides a path-based API for services
that don't want to handle content-addressing directly.

## Key Concept — Content Addressing

0G Storage is Merkle-root-addressed. Files have **no path strings on-chain**.

```
upload(data) → rootHash
download(rootHash) → data
```

This service bridges that gap with a `storage_index` PostgreSQL table:
```
logical_path  →  rootHash  →  0G Storage blob
```

Services should use logical paths for readability, but store the `rootHash` when they need
on-chain references (e.g. INFT `memoryRootHash`, `modelRootHash`).

## Who Uses 0G Storage Directly

| Service | What it stores | storage_index path pattern |
|---------|---------------|---------------------------|
| agent-service | Avatar PNG, metadata JSON | `agents/{id}/avatar/v1`, `agents/{id}/metadata/v1` |
| memory-service | Memory snapshots, episode archives | `agents/{id}/memory/snapshot-*`, `agents/{id}/memory/episodes/*` |
| replay-service | Battle replay blobs | `replays/{battleId}` |
| battle-service | Battle result summaries | `battles/{battleId}/result` |
| training-service | Training datasets (JSONL), LoRA model weights | `training/{agentId}/datasets/*`, `agents/{agentId}/models/v*` |

## API Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/storage/upload` | JWT | Upload file → 0G Storage → `{ rootHash, txHash, logicalPath }` |
| `GET` | `/storage/download/:rootHash` | JWT | Download directly by rootHash |
| `GET` | `/storage/path/*path` | JWT | Download by logical path (resolves rootHash via storage_index) |
| `GET` | `/storage/hash/*path` | JWT | Get rootHash for a path without downloading |
| `GET` | `/storage/list` | JWT | List indexed paths (`?prefix=agents/abc123/`) |
| `DELETE` | `/storage/index/*path` | JWT | Remove logical path from index (data on 0G is immutable) |
| `GET` | `/health` | — | Health check |

## Upload Request

```
POST /storage/upload
Content-Type: multipart/form-data

file:        <binary>
logicalPath: agents/abc123/avatar/v2
mimeType:    image/png
tags:        avatar,abc123
```

## Upload Response

```json
{
  "rootHash": "0xabc123...",
  "txHash": "0xdef456...",
  "logicalPath": "agents/abc123/avatar/v2",
  "sizeBytes": 204800
}
```

## Important Notes

- **Deletion is not possible** on 0G Storage — data is immutable. `DELETE /storage/index/*` only removes the local index entry.
- **rootHash is the canonical identifier** — always store it alongside logical paths for on-chain references.
- The `storage_index` table lives in PostgreSQL and is owned by this service. Other services write to it directly when they upload via `ZeroGStorageClient` — this service is for external/generic access.

## Environment Variables

```bash
ZEROG_NETWORK=mainnet
ZEROG_STORAGE_PRIVATE_KEY=0x...
DATABASE_URL=...
JWT_SECRET=...
PORT=8042
```
