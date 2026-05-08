# battle-service

Orchestrates battle rooms, state management, WebSocket streaming, and replay recording.

## Port: 8021

## API Routes

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | /battles | JWT | Create a battle |
| GET | /battles/:id | JWT | Get battle details |
| POST | /battles/:id/dispute | JWT | Dispute battle outcome |
| WS | /battles/ws/battle/:id | - | Battle state stream |
