# AI Arena SDK — Unreal Engine 5 Plugin

Official UE5 plugin for integrating AI Arena into your Unreal game.

**Minimum Unreal Engine version: 5.0**

---

## Installation

### Option A — Copy into project (recommended)

```
YourProject/
└── Plugins/
    └── AIArenaSDK/          ← copy this directory here
        ├── AIArenaSDK.uplugin
        └── Source/
```

Right-click your `.uproject` file → **Generate Visual Studio project files**, then build.

### Option B — Engine plugin

Copy `AIArenaSDK/` into `<UE5 Root>/Engine/Plugins/Marketplace/` and enable via Plugins panel.

---

## Quick Start

### 1 — Configure (Project Settings → Plugins → AI Arena SDK)

```ini
; Config/DefaultGame.ini
[/Script/AIArenaSDK.AIArenaConfig]
ApiBaseUrl=https://api.aiarena.gg
WebSocketUrl=wss://api.aiarena.gg
GameId=your-game-id
ApiKey=your-api-key          ; never commit — use env var or Vault in production
InferenceTimeoutMs=50
TelemetryBatchSize=100
bEnableTelemetry=True
bEnableAIInference=True
bEnableReplay=True
```

All values are editable at runtime via **Project Settings → Plugins → AI Arena SDK**.

---

### 2 — Initialise in GameInstance (C++)

```cpp
// MyGameInstance.cpp
#include "Core/AIArenaSubsystem.h"

void UMyGameInstance::Init()
{
    Super::Init();

    UAIArenaSubsystem* SDK = GetSubsystem<UAIArenaSubsystem>();
    SDK->OnSDKInitialized.AddDynamic(this, &UMyGameInstance::OnSDKReady);
    SDK->InitializeSDK();
}

void UMyGameInstance::OnSDKReady(bool bSuccess)
{
    if (bSuccess)
        UE_LOG(LogTemp, Log, TEXT("AI Arena SDK ready!"));
}
```

**Blueprint equivalent:** Get Game Instance → Get Subsystem (AI Arena) → Initialize SDK → bind OnSDKInitialized.

---

### 3 — Add Agent Brain to your AI Pawn

```cpp
// MyAIPawn.h
UPROPERTY(VisibleAnywhere) UAgentBrainComponent* Brain;

// MyAIPawn.cpp — constructor
Brain = CreateDefaultSubobject<UAgentBrainComponent>(TEXT("AgentBrain"));

// BeginPlay
Brain->OnBrainReady.AddDynamic(this, &AMyAIPawn::OnBrainReady);
Brain->OnActionReceived.AddDynamic(this, &AMyAIPawn::OnActionReceived);
Brain->InitBrain(AgentId);
```

---

### 4 — Request actions on your AI tick

```cpp
void AMyAIPawn::Tick(float DeltaTime)
{
    Super::Tick(DeltaTime);

    // Build game state
    FAIArenaGameState State;
    State.AgentId       = AgentId;
    State.Position      = GetActorLocation();
    State.Health        = HealthComponent->GetHealth();
    State.MaxHealth     = HealthComponent->GetMaxHealth();
    State.TimeRemaining = BattleManager->GetTimeRemaining();

    // Non-blocking — action delivered to OnActionReceived delegate
    Brain->GetNextAction(State);
}

void AMyAIPawn::OnActionReceived(const FAIArenaAgentAction& Action)
{
    // Action.Source = "AI" | "CACHED" | "FALLBACK"
    UE_LOG(LogTemp, Log, TEXT("Action: %s (confidence=%.2f, source=%s)"),
           *Action.ActionType, Action.Confidence, *Action.Source);

    ExecuteAction(Action);
}
```

---

### 5 — Telemetry

```cpp
// In BeginPlay, after session start:
UAIArenaTelemetryCollector* Telemetry =
    GetGameInstance()->GetSubsystem<UAIArenaTelemetryCollector>();
Telemetry->StartSession(SessionId, AgentId);

// During gameplay:
Telemetry->RecordCombatAction(TEXT("ATTACK"), TargetId,
                               GetActorLocation(),
                               /*bSuccess=*/true, DamageDealt, LatencyMs);

Telemetry->RecordHealthChange(OldHp, CurrentHp, MaxHp,
                               TEXT("DAMAGE_TAKEN"), AttackerId);

// On session end (EndPlay / match over):
Telemetry->EndSession();
```

---

### 6 — Battle lifecycle

```cpp
// Attach UBattleOrchestratorComponent to your GameMode or BattleManager actor
UBattleOrchestratorComponent* Battle =
    GameModeActor->FindComponentByClass<UBattleOrchestratorComponent>();

Battle->OnBattleCreated.AddDynamic(this, &AMyGameMode::OnBattleCreated);
Battle->OnBattleStateUpdated.AddDynamic(this, &AMyGameMode::OnBattleStateUpdated);
Battle->OnBattleEnded.AddDynamic(this, &AMyGameMode::OnBattleEnded);

// Start
Battle->CreateBattle(AgentId, OpponentId, TEXT("RANKED"), GameId);

// End
FAIArenaBattleResult Result;
Result.WinnerId    = WinnerAgentId;
Result.LoserId     = LoserAgentId;
Result.RoundsPlayed = RoundNumber;
Battle->EndBattle(Result);
```

---

### 7 — Replay recording

```cpp
UAIArenaReplayRecorder* Recorder = NewObject<UAIArenaReplayRecorder>(this);
Recorder->StartRecording(BattleId);

// In your battle tick (~10 Hz):
Recorder->CaptureFrame(AgentId, GetActorLocation(), Health,
                        LastAction.ActionType, LastAction.Confidence);

// On EndBattle — uploads to replay-service and verifies hash:
Recorder->StopAndUpload(FinalStateHashFromServer);
```

---

## Module Structure

```
Source/AIArenaSDK/
├── Public/
│   ├── Core/
│   │   ├── AIArenaConfig.h       UDeveloperSettings — Project Settings panel
│   │   ├── AIArenaTypes.h        Shared structs/enums (Blueprint-exposed)
│   │   ├── AIArenaApiClient.h    HTTP GET/POST helper
│   │   └── AIArenaSubsystem.h    GameInstance subsystem — SDK entry point
│   ├── Agents/
│   │   ├── AgentBrainComponent.h ActorComponent — inference + fallback chain
│   │   └── AgentMemoryContext.h  Memory fetch/store helpers
│   ├── Inference/
│   │   ├── InferenceGateway.h    POST /inference/action with timeout
│   │   └── FallbackBehaviourAI.h Deterministic heuristic (no network)
│   ├── Battle/
│   │   ├── BattleOrchestratorComponent.h  Battle lifecycle + WS sync
│   │   └── ReplayRecorder.h      10 Hz frame capture + upload
│   └── Telemetry/
│       └── TelemetryCollector.h  GameInstance subsystem — event buffering
└── Private/
    └── ...                       Implementations
```

---

## Key Behaviours

| Feature | Detail |
|---------|--------|
| **Inference timeout** | Hard deadline via `FTimerHandle`. Fallback fires at exactly `InferenceTimeoutMs` ms. |
| **Action cache** | 50 ms TTL keyed by game-state hash. Prevents duplicate network calls on consecutive ticks. |
| **Fallback AI** | Trait-weighted heuristic. FLEE when HP < 25%, ATTACK when aggression > 0.6, DEFEND when risk tolerance < 0.4. |
| **WebSocket reconnect** | Exponential back-off: 2s → 4s → 8s … capped at 60s, max 10 attempts. |
| **Telemetry flush** | Two triggers: buffer full (`TelemetryBatchSize`) or timer (`TelemetryFlushIntervalSeconds`). Failed batches are re-queued up to 3 times. |
| **Replay hash** | `SerializeFrames()` JSON is hashed and compared to the server's `finalStateHash`. Mismatch logs an anticheat warning. |

---

## Environment Variables (alternative to INI config)

```bash
AIARENA_API_BASE_URL=https://api.aiarena.gg
AIARENA_API_KEY=your-key-here
AIARENA_GAME_ID=your-game-id
```

Read in your GameInstance `Init()` via `FPlatformMisc::GetEnvironmentVariable()` and inject into the config before `InitializeSDK()`.

---

## Blueprint Support

All public methods are `UFUNCTION(BlueprintCallable)`. Delegates are
`UPROPERTY(BlueprintAssignable)`. Struct types are `USTRUCT(BlueprintType)`.

Full Blueprint integration guide: [docs.aiarena.gg/sdks/unreal/blueprints](https://docs.aiarena.gg/sdks/unreal/blueprints)
