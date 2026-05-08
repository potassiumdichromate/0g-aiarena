# replay-service

**Port: 8022**

Stores and verifies deterministic battle replays on **0G Storage mainnet**.

## How It Works

Every battle produces a replay blob containing the random seed and full action log.
Given the same `seed + actionLog`, re-simulating always produces the same `finalStateHash` —
this is the basis of anti-cheat verification.

```
battle ends
  → battle-service publishes BATTLE_ENDED { actionLog, seed, finalStateHash }
  → replay-service uploads replayBlob to 0G Storage → replayRootHash
  → Battle.replayId = replayRootHash (stored in DB)
  → anticheat-service can call /verify at any time to re-check integrity
```

## 0G Storage Integration

| Operation | Path in storage_index | Description |
|-----------|----------------------|-------------|
| Upload replay | `replays/{battleId}` | Full replay blob as JSON |
| Download replay | — | By rootHash from storage_index |
| Verify integrity | — | Re-derives SHA256(seed + actionLog), compares to finalStateHash |

## Replay Blob Schema

```json
{
  "battleId": "uuid",
  "seed": "hex-string",
  "initialState": {},
  "actionLog": [
    { "tick": 1, "agentId": "uuid", "action": { "actionType": "attack", ... }, "latencyMs": 38 }
  ],
  "finalStateHash": "sha256-hex",
  "durationMs": 45000,
  "recordedAt": "2026-05-08T10:33:00Z"
}
```

## API Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/replays` | JWT | Upload replay blob → 0G Storage → `{ rootHash, txHash, hashMatch }` |
| `GET` | `/replays/:battleId` | JWT | Download full replay from 0G Storage |
| `GET` | `/replays/:battleId/verify` | JWT | Verify replay: re-derive finalStateHash and compare |
| `GET` | `/replays/:battleId/meta` | JWT | Metadata only (rootHash, sizeBytes, storedAt) |
| `GET` | `/health` | — | Health check |

## Verify Response

```json
{
  "battleId": "...",
  "rootHash": "0x...",
  "storedHash": "sha256-of-original",
  "computedHash": "sha256-recomputed",
  "valid": true,
  "actionCount": 847,
  "durationMs": 45000
}
```

`valid: false` indicates the replay was tampered — escalate to anticheat-service.

## Environment Variables

```bash
ZEROG_NETWORK=mainnet
ZEROG_STORAGE_PRIVATE_KEY=0x...
DATABASE_URL=...
JWT_SECRET=...
PORT=8022
```
