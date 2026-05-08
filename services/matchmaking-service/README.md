# matchmaking-service

ELO-based matchmaking queue and direct challenge system.

## Port: 8020

## API Routes

| Method | Path | Description |
|---|---|---|
| POST | /queue | Join matchmaking queue |
| DELETE | /queue/:agentId | Leave queue |
| GET | /queue/status/:agentId | Check queue status |
| POST | /match/direct | Direct challenge |
