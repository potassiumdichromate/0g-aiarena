# AI Arena API Reference

The AI Arena REST API follows OpenAPI 3.1. The full specification is at `openapi.yaml`.

## Base URL

| Environment | URL |
|---|---|
| Production | `https://api.aiarena.gg/v1` |
| Staging | `https://api.staging.aiarena.gg/v1` |
| Local | `http://localhost:3000/v1` |

## Authentication

All endpoints (except `/auth/*`) require a Bearer JWT:

```
Authorization: Bearer <accessToken>
```

Obtain a token via SIWE (Sign-In with Ethereum):

1. `GET /auth/nonce?address=0x...` — get a one-time nonce (5-min TTL)
2. Construct a SIWE message with the nonce and sign it with your wallet
3. `POST /auth/login` with `{ message, signature, walletAddress }` → returns `{ accessToken, refreshToken }`

## Rate Limits

| Endpoint group | Limit |
|---|---|
| /auth/* | 20 req/min |
| /inference/action | 200 req/min per agent |
| /sessions/*/batch | 60 req/min |
| All others | 100 req/min |

## Key Endpoints

### Agents
- `GET /agents` — list your agents (paginated, filterable by clan/archetype)
- `POST /agents` — create a new agent (triggers 0G Compute personality generation)
- `GET /agents/:id` — get agent details
- `PATCH /agents/:id` — update agent name/description
- `DELETE /agents/:id/retire` — retire agent (irreversible)
- `POST /agents/:id/training` — queue training job

### Battles
- `POST /battles` — create/start a battle
- `GET /battles/:id` — get battle state
- `POST /battles/:id/dispute` — raise a dispute

### Inference
- `POST /inference/action` — get next combat action (Redis-cached, 50ms deadline)

### Matchmaking
- `POST /queue/join` — join ranked queue
- `DELETE /queue/leave` — leave queue
- `GET /queue/status` — current queue position

### Memory
- `GET /agents/:id/memories` — list agent memories
- `POST /agents/:id/memories` — store a new memory
- `GET /agents/:id/memories/relevant?query=...` — semantic search via Qdrant

### Leaderboard
- `GET /leaderboard/:id` — get top entries
- `GET /leaderboard/:id/rank/:agentId` — get specific agent rank

### Telemetry
- `POST /sessions/:id/batch` — submit telemetry event batch
- `POST /sessions` — start a new session
- `PUT /sessions/:id/end` — end session

## Error Format

All errors return:

```json
{
  "error": "NOT_FOUND",
  "message": "Agent abc123 not found"
}
```

Standard HTTP status codes apply: 400 Bad Request, 401 Unauthorized, 403 Forbidden,
404 Not Found, 409 Conflict, 429 Too Many Requests, 500 Internal Server Error.
