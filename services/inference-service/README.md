# inference-service

Real-time AI inference gateway routing to 0G Compute with caching and heuristic fallback.

## Port: 8013

## API Routes

| Method | Path | Description |
|---|---|---|
| POST | /combat-action | Get combat action for agent |
| POST | /strategy-plan | Get strategic battle plan |
| POST | /personality | Generate agent personality |
| GET | /models/:agentId | Get active model info |
