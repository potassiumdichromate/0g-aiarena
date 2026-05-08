# agent-service

Manages the full AI agent lifecycle: creation, training, evolution, memory summaries, and cloning.

## Port: 8002

## API Routes

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | /agents | JWT | Create new agent (triggers 0G Compute) |
| GET | /agents | JWT | List agents with filters |
| GET | /agents/:id | JWT | Get full agent profile |
| PUT | /agents/:id | JWT | Update agent metadata |
| DELETE | /agents/:id | JWT | Retire agent |
| POST | /agents/:id/train | JWT | Queue training job |
| GET | /agents/:id/training | JWT | Get training status |
| GET | /agents/:id/memory | JWT | Get memory summary |
| POST | /agents/:id/clone | JWT | Clone agent |
| GET | /agents/:id/evolution | JWT | Get evolution status |
