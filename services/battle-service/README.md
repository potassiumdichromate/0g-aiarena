# battle-service

**Port: 8021**

Orchestrates battle lifecycle. On battle end, archives result to **0G Storage mainnet**
and triggers replay archival, memory compaction, and on-chain INFT updates.

## 0G Integration

```
endBattle({ winnerId, loserId, eloChanges, finalStateHash, actionLog, seed })
  │
  ├─ 0G Storage: upload(battleResultJSON) → resultRootHash
  │   indexed as: battles/{battleId}/result
  │
  └─ NATS: BATTLE_ENDED {
       battleId, agentIds, winnerId, loserId,
       eloChanges, finalStateHash,
       resultRootHash,       ← 0G Storage root hash
       actionLog, seed       ← passed to replay-service
     }
       │
       ├─ replay-service:   upload full replay → 0G Storage
       ├─ memory-service:   compactMemory() → 0G Storage snapshot per agent
       ├─ inft-service:     recordBattleResult() + updateMemoryRoot() on 0G Chain
       └─ financial-service: settle Solana escrow
```

## Battle Result Archival

Battle results are stored on 0G Storage for immutable audit. The `getBattleResult()` method
tries 0G Storage first and falls back to the DB if unavailable.

```
storage_index path: battles/{battleId}/result
```

## API Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/battles` | JWT | Create battle |
| `GET` | `/battles/:id` | JWT | Get battle state |
| `POST` | `/battles/:id/start` | JWT | Start battle |
| `POST` | `/battles/:id/end` | JWT | End battle — 0G Storage archival + on-chain updates |
| `GET` | `/battles/:id/result` | JWT | Fetch result (0G Storage first, DB fallback) |
| `POST` | `/battles/:id/dispute` | JWT | Raise dispute |
| `WS` | `/battles/ws/battle/:id` | — | Battle state WebSocket stream |

## NATS Events Published

| Subject | Payload |
|---------|---------|
| `battle.created` | `{ battleId, agentIds, gameId }` |
| `battle.started` | `{ battleId, occurredAt }` |
| `battle.ended` | `{ battleId, winnerId, loserId, eloChanges, finalStateHash, resultRootHash, actionLog, seed, durationMs }` |
| `battle.disputed` | `{ battleId, reason }` |

## Environment Variables

```bash
ZEROG_NETWORK=mainnet
ZEROG_STORAGE_PRIVATE_KEY=0x...
DATABASE_URL=...
NATS_URL=...
REDIS_URL=...
PORT=8021
```
