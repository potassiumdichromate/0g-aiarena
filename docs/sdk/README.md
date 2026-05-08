# AI Arena — Game Engine SDKs

Two official SDKs are available: **Unity** (C#) and **Unreal Engine 5** (C++/Blueprints).
Both expose the same backend features — inference, telemetry, battle lifecycle, and replay.

| | Unity SDK | Unreal Engine 5 SDK |
|---|---|---|
| Language | C# | C++ + Blueprints |
| Min engine version | Unity 2022.3 LTS | UE 5.0 |
| Entry point | `AIArenaSDK` MonoBehaviour singleton | `UAIArenaSubsystem` (GameInstance subsystem) |
| Config | `AIArenaConfig` ScriptableObject | `UAIArenaConfig` DeveloperSettings (Project Settings) |
| Agent controller | `AgentBrain` MonoBehaviour | `UAgentBrainComponent` ActorComponent |
| Telemetry | `TelemetryCollector` singleton | `UAIArenaTelemetryCollector` subsystem |
| Battle | `BattleOrchestrator` MonoBehaviour | `UBattleOrchestratorComponent` ActorComponent |
| Replay | `ReplayRecorder` MonoBehaviour | `UAIArenaReplayRecorder` UObject |
| Source | `unity/AIArenaSDK/` | `unreal/AIArenaSDK/` |

---

## Unity SDK

The Unity SDK integrates your Unity game with the AI Arena backend.

### Architecture

```
AIArenaSDK (singleton MonoBehaviour)
├── ConnectionManager     — WebSocket connection + auto-reconnect
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
    ├── BattleStateSync   — WebSocket battle state listener
    ├── ReplayRecorder    — records frames at 10Hz
    └── SpectatorView     — interpolated state for spectating
```

### Key Features
- **Sub-50ms inference** with automatic fallback to trait-based heuristics
- **Offline-first telemetry** — buffers events and retries on failure
- **Deterministic replay** at 10 Hz for dispute resolution
- **Spectator mode** with state interpolation
- **Zero dependencies** — only Unity built-in packages required

### Namespaces

| Namespace | Purpose |
|-----------|---------|
| `AIArena.SDK.Core` | SDK singleton, config, connection |
| `AIArena.SDK.Agents` | Agent brain, profile loading |
| `AIArena.SDK.Inference` | Action prediction, caching, fallback |
| `AIArena.SDK.Telemetry` | Event recording, batching, streaming |
| `AIArena.SDK.Battle` | Battle orchestration, replay, spectator |

See [QUICKSTART.md](QUICKSTART.md) and `unity/AIArenaSDK/README.md` for integration steps.

---

## Unreal Engine 5 SDK

The UE5 plugin exposes the same backend surface as the Unity SDK using native UE5 patterns —
subsystems, components, delegates, and Blueprint-callable functions.

### Architecture

```
UAIArenaSubsystem (GameInstanceSubsystem — auto-created)
├── UAIArenaConfig         — DeveloperSettings (Project Settings panel)
├── FAIArenaApiClient      — static HTTP GET/POST helper
│
├── UAgentBrainComponent   — ActorComponent: inference + fallback chain
│   ├── UAIArenaInferenceGateway  — POST /inference/action + hard timeout
│   ├── UAIArenaFallbackBehaviourAI — trait-weighted heuristic (no network)
│   └── UAgentMemoryContext       — fetch/store working memory
│
├── UAIArenaTelemetryCollector (GameInstanceSubsystem)
│   └── event buffer → auto-flush → POST /sessions/{id}/batch
│
└── UBattleOrchestratorComponent  — ActorComponent: battle lifecycle
    ├── WebSocket state sync
    └── UAIArenaReplayRecorder — 10 Hz frame capture + upload
```

### Key Features
- **Full Blueprint support** — every method is `BlueprintCallable`, every event is `BlueprintAssignable`
- **GameInstance subsystems** — SDK and telemetry auto-initialise, no manual singleton management
- **Hard inference timeout** via `FTimerHandle` — battle tick never stalls
- **50 ms action cache** keyed by game-state hash — prevents redundant network calls per tick
- **Exponential WebSocket reconnect** — 2s, 4s, 8s … capped at 60s, max 10 attempts

### UE5 Modules

| Module / Class | UE Type | Purpose |
|----------------|---------|---------|
| `UAIArenaSubsystem` | `UGameInstanceSubsystem` | SDK init, WS connection, profile loading |
| `UAIArenaConfig` | `UDeveloperSettings` | Config in Project Settings panel |
| `FAIArenaApiClient` | Static class | HTTP GET/POST with auth headers |
| `UAgentBrainComponent` | `UActorComponent` | Attach to AI Pawn — inference lifecycle |
| `UBattleOrchestratorComponent` | `UActorComponent` | Attach to GameMode — battle lifecycle |
| `UAIArenaTelemetryCollector` | `UGameInstanceSubsystem` | Auto-created — event buffering |
| `UAIArenaReplayRecorder` | `UObject` | 10 Hz replay capture + upload |
| `UAIArenaFallbackBehaviourAI` | `UObject` | Heuristic fallback, synchronous |

See `unreal/AIArenaSDK/README.md` for full integration guide and code samples.

---

## Shared Behaviour (both SDKs)

| Feature | Behaviour |
|---------|-----------|
| Inference timeout | Hard deadline (default 50 ms). Fallback action returned immediately on timeout. |
| Fallback logic | FLEE when HP < 25%, ATTACK when aggression > 0.6, DEFEND when risk tolerance < 0.4, else IDLE |
| Telemetry flush | Triggered by buffer size (100 events) OR timer (10 s). Failed batches re-queued up to 3 times. |
| Replay frame rate | 10 Hz. Final blob SHA-256 hashed and verified against server's `finalStateHash`. |
| Agent traits | 8 normalised floats (0–100): Aggression, Patience, Adaptability, RiskTolerance, Teamwork, Creativity, Endurance, Precision |
| Action sources | `"AI"` (live inference), `"CACHED"` (50 ms TTL hit), `"FALLBACK"` (heuristic or error) |
