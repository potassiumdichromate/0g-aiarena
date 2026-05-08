# telemetry-service

Real-time telemetry ingestion from Unity game clients. Validates batches and publishes to NATS for downstream ML processing.

## Port: 8010

## API Routes

| Method | Path | Description |
|---|---|---|
| POST | /sessions/start | Start a telemetry session |
| POST | /sessions/:id/end | End a session |
| POST | /sessions/:id/batch | Submit event batch |
| WS | /sessions/ws/stream | WebSocket streaming |
