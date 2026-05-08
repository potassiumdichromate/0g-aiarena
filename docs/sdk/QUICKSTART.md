# AI Arena Unity SDK — Quick Start

## Prerequisites

- Unity 2022.3 LTS or newer
- AI Arena account + API key from https://aiarena.gg/dashboard

## Installation

Copy `unity/AIArenaSDK/` into your Unity project's `Assets/` folder.
The SDK has no external package dependencies (uses only Unity built-in networking).

## 1. Configure the SDK

Create an `AIArenaConfig` asset:

1. In the Unity Editor, go to **Assets > Create > AI Arena > Config**
2. Fill in:
   - `ApiBaseUrl`: `https://api.aiarena.gg/v1`
   - `ApiKey`: Your API key
   - `DefaultGameId`: Your game ID from the dashboard

## 2. Add SDK to Scene

Add `AIArenaSDK` MonoBehaviour to a persistent GameObject (e.g., GameManager):

```csharp
using AIArena.SDK.Core;
using UnityEngine;

public class GameManager : MonoBehaviour
{
    [SerializeField] private AIArenaConfig config;

    async void Start()
    {
        await AIArenaSDK.Instance.Initialize(config);
        Debug.Log("AI Arena SDK ready");
    }
}
```

## 3. Start a Battle Session

```csharp
using AIArena.SDK.Core;
using AIArena.SDK.Battle;

string agentId = "your-agent-uuid";

// Start session (registers with backend)
var session = await AIArenaSDK.Instance.StartSession(agentId);
Debug.Log($"Session started: {session.Id}");

// Create battle
var orchestrator = GetComponent<BattleOrchestrator>();
await orchestrator.CreateBattle(agentId, opponentAgentId, "RANKED");
```

## 4. Get Agent Actions

```csharp
using AIArena.SDK.Agents;

var brain = GetComponent<AgentBrain>();
await brain.Initialize(agentId);

// Each game tick:
GameState gameState = GetCurrentGameState();
string action = await brain.GetNextAction(gameState);
ApplyAction(action); // "ATTACK", "DEFEND", "FLEE", etc.
```

## 5. Record Telemetry

```csharp
using AIArena.SDK.Telemetry;

var collector = TelemetryCollector.Instance;

// Record actions (call every time an action is taken)
collector.RecordCombatAction(agentId, "ATTACK", sessionId);

// Record position updates (call every physics step)
collector.RecordPositionUpdate(agentId, transform.position, sessionId);

// Record health changes
collector.RecordHealthChange(agentId, previousHp, currentHp, sessionId);
```

## 6. End Session

```csharp
string outcome = "WIN"; // or "LOSS", "DRAW"
await AIArenaSDK.Instance.EndSession(session.Id, outcome);
```

## 7. Spectate a Battle

```csharp
using AIArena.SDK.Battle;

var spectator = GetComponent<SpectatorView>();
spectator.OnStateApplied += (state) => UpdateUI(state);
spectator.StartSpectating(battleId);

// Later:
spectator.StopSpectating();
```

## Configuration Reference

| Property | Type | Default | Description |
|---|---|---|---|
| ApiBaseUrl | string | — | Backend API URL |
| ApiKey | string | — | Your API key |
| DefaultGameId | string | — | Game UUID |
| InferenceTimeoutMs | int | 50 | Max wait for action inference |
| TelemetryBatchSize | int | 100 | Events before auto-flush |
| TelemetryFlushIntervalSeconds | float | 5.0 | Auto-flush interval |

## Troubleshooting

**"AgentBrain: Failed to get action"** — Check your API key and network connectivity.
The SDK will automatically fall back to FallbackBehaviourAI which uses trait-weighted
heuristics, so battles continue even when the API is unreachable.

**High inference latency** — The 50ms timeout triggers FallbackBehaviourAI. If you see
frequent fallbacks, consider caching more aggressively or adjusting `InferenceTimeoutMs`.

**Telemetry not arriving** — Check `TelemetryCollector.Instance` is in your scene and
`StartSession` was called before any `Record*` methods.
