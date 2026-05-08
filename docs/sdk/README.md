# AI Arena Unity SDK

The AI Arena Unity SDK integrates your Unity game with the AI Arena backend.
It handles authentication, agent inference, telemetry collection, battle orchestration,
and replay recording.

## Architecture

```
AIArenaSDK (singleton)
├── ConnectionManager     — HTTP client, auth headers
├── SessionManager        — session lifecycle
│
├── AgentBrain            — per-agent inference + fallback AI
│   ├── AgentProfileLoader  — loads profile from API (cached)
│   ├── ActionPredictor     — calls inference-service with timeout
│   ├── FallbackBehaviourAI — trait-weighted heuristic fallback
│   └── InferenceCache      — in-process 50ms TTL cache
│
├── TelemetryCollector    — event buffering + auto-flush
│   ├── TelemetryStreamer  — HTTP POST batches
│   ├── TelemetryBatcher  — retry logic for batch submission
│   └── TelemetrySerializer — JSON serialization (MessagePack-ready)
│
└── BattleOrchestrator    — battle lifecycle
    ├── BattleStateSync   — polls battle state from backend
    ├── ReplayRecorder    — records frames at 10Hz
    └── SpectatorView     — interpolated state for spectating
```

## Key Features

- **Sub-50ms inference** with automatic fallback to trait-based heuristics
- **Offline-first telemetry** — buffers events and retries on failure
- **Deterministic replay** at 10Hz frame rate for dispute resolution
- **Spectator mode** with state interpolation for smooth playback
- **Zero dependencies** — only Unity built-in packages required

## Namespaces

| Namespace | Purpose |
|---|---|
| `AIArena.SDK.Core` | SDK singleton, config, connection |
| `AIArena.SDK.Agents` | Agent brain, profile loading |
| `AIArena.SDK.Inference` | Action prediction, caching, fallback |
| `AIArena.SDK.Telemetry` | Event recording, batching, streaming |
| `AIArena.SDK.Battle` | Battle orchestration, replay, spectator |

See [QUICKSTART.md](QUICKSTART.md) for integration steps.
