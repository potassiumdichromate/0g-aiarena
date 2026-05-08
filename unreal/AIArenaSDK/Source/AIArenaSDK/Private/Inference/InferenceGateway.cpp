#include "Inference/InferenceGateway.h"
#include "Inference/FallbackBehaviourAI.h"
#include "Core/AIArenaApiClient.h"
#include "Core/AIArenaConfig.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "TimerManager.h"
#include "Engine/World.h"

void UAIArenaInferenceGateway::GetCombatAction(
    const FString&           AgentId,
    const FAIArenaGameState& GameState,
    const TArray<FString>&   MemoryContext,
    FOnInferenceResult       OnResult)
{
    const UAIArenaConfig* Cfg = UAIArenaConfig::Get();
    const FString ReqId = FGuid::NewGuid().ToString();

    // ── Hard timeout: deliver FALLBACK if network takes too long ─────────────
    const float TimeoutSec = (float)Cfg->InferenceTimeoutMs / 1000.f;
    FTimerHandle Handle;
    GetWorld()->GetTimerManager().SetTimer(
        Handle,
        FTimerDelegate::CreateUObject(this, &UAIArenaInferenceGateway::OnRequestTimeout,
                                      ReqId, OnResult),
        TimeoutSec, /*bLoop=*/false);
    PendingTimers.Add(ReqId, Handle);

    // ── Build request body ────────────────────────────────────────────────────
    auto PosPart = MakeShared<FJsonObject>();
    PosPart->SetNumberField(TEXT("x"), GameState.Position.X);
    PosPart->SetNumberField(TEXT("y"), GameState.Position.Y);
    PosPart->SetNumberField(TEXT("z"), GameState.Position.Z);

    auto StatePart = MakeShared<FJsonObject>();
    StatePart->SetObjectField(TEXT("position"),      PosPart);
    StatePart->SetNumberField(TEXT("health"),        GameState.MaxHealth > 0.f
                                                       ? GameState.Health / GameState.MaxHealth
                                                       : 0.f);
    StatePart->SetNumberField(TEXT("timeRemaining"), GameState.TimeRemaining);
    StatePart->SetNumberField(TEXT("nearbyEnemies"), GameState.NearbyEnemies.Num());

    TArray<TSharedPtr<FJsonValue>> MemArray;
    for (const FString& Snippet : MemoryContext)
    {
        MemArray.Add(MakeShared<FJsonValueString>(Snippet));
    }

    auto Body = MakeShared<FJsonObject>();
    Body->SetStringField(TEXT("agentId"),       AgentId);
    Body->SetObjectField(TEXT("battleState"),   StatePart);
    Body->SetArrayField (TEXT("memoryContext"), MemArray);

    // ── Fire HTTP request ─────────────────────────────────────────────────────
    FAIArenaApiClient::Post(TEXT("/inference/action"), Body,
        FOnApiResponse::CreateLambda(
            [this, ReqId, OnResult](bool bOK, TSharedPtr<FJsonObject> Json)
            {
                // Cancel timeout timer if response arrived in time
                if (FTimerHandle* H = PendingTimers.Find(ReqId))
                {
                    if (GetWorld())
                        GetWorld()->GetTimerManager().ClearTimer(*H);
                    PendingTimers.Remove(ReqId);
                }
                else
                {
                    // Timeout already fired — discard this late response
                    return;
                }

                FAIArenaAgentAction Action;
                Action.Source = TEXT("AI");

                if (bOK && Json.IsValid())
                {
                    const TSharedPtr<FJsonObject>* ActionObj = nullptr;
                    if (Json->TryGetObjectField(TEXT("action"), ActionObj))
                    {
                        (*ActionObj)->TryGetStringField(TEXT("actionType"), Action.ActionType);
                        (*ActionObj)->TryGetNumberField(TEXT("confidence"), Action.Confidence);

                        FString Src;
                        if ((*ActionObj)->TryGetStringField(TEXT("source"), Src))
                            Action.Source = Src;
                    }
                }
                else
                {
                    Action.ActionType = TEXT("DEFEND");
                    Action.Confidence = 0.2f;
                    Action.Source     = TEXT("FALLBACK");
                }

                OnResult.ExecuteIfBound(Action);
            }));
}

void UAIArenaInferenceGateway::OnRequestTimeout(FString RequestId,
                                                  FOnInferenceResult OnResult)
{
    PendingTimers.Remove(RequestId);
    UE_LOG(LogTemp, Warning,
           TEXT("[InferenceGateway] Request %s timed out — using FALLBACK."), *RequestId);

    FAIArenaAgentAction Fallback;
    Fallback.ActionType = TEXT("DEFEND");
    Fallback.Confidence = 0.2f;
    Fallback.Source     = TEXT("FALLBACK");
    OnResult.ExecuteIfBound(Fallback);
}
