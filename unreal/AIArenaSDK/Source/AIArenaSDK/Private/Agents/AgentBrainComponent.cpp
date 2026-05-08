#include "Agents/AgentBrainComponent.h"
#include "Core/AIArenaApiClient.h"
#include "Core/AIArenaConfig.h"
#include "Inference/InferenceGateway.h"
#include "Inference/FallbackBehaviourAI.h"
#include "Agents/AgentMemoryContext.h"
#include "Core/AIArenaSubsystem.h"
#include "Engine/GameInstance.h"
#include "Dom/JsonObject.h"
#include "HAL/PlatformTime.h"

UAgentBrainComponent::UAgentBrainComponent()
{
    PrimaryComponentTick.bCanEverTick = false;
}

void UAgentBrainComponent::BeginPlay()
{
    Super::BeginPlay();
}

void UAgentBrainComponent::InitBrain(const FString& AgentId)
{
    CurrentAgentId = AgentId;
    bIsReady       = false;

    // Fetch profile, configure fallback, then fire OnBrainReady
    FAIArenaApiClient::Get(
        FString::Printf(TEXT("/agents/%s"), *AgentId),
        FOnApiResponse::CreateLambda(
            [this, AgentId](bool bOK, TSharedPtr<FJsonObject> Json)
            {
                if (bOK && Json.IsValid())
                {
                    AgentProfile.Id = AgentId;
                    Json->TryGetStringField(TEXT("name"),      AgentProfile.Name);
                    Json->TryGetStringField(TEXT("archetype"), AgentProfile.Archetype);
                    Json->TryGetNumberField(TEXT("eloRating"), AgentProfile.EloRating);

                    const TSharedPtr<FJsonObject>* Traits = nullptr;
                    if (Json->TryGetObjectField(TEXT("traits"), Traits))
                    {
                        (*Traits)->TryGetNumberField(TEXT("aggression"),    BehaviourTraits.Aggression);
                        (*Traits)->TryGetNumberField(TEXT("patience"),      BehaviourTraits.Patience);
                        (*Traits)->TryGetNumberField(TEXT("adaptability"),  BehaviourTraits.Adaptability);
                        (*Traits)->TryGetNumberField(TEXT("riskTolerance"), BehaviourTraits.RiskTolerance);
                        (*Traits)->TryGetNumberField(TEXT("teamwork"),      BehaviourTraits.Teamwork);
                        (*Traits)->TryGetNumberField(TEXT("creativity"),    BehaviourTraits.Creativity);
                        (*Traits)->TryGetNumberField(TEXT("endurance"),     BehaviourTraits.Endurance);
                        (*Traits)->TryGetNumberField(TEXT("precision"),     BehaviourTraits.Precision);
                    }
                }
                bIsReady = true;
                UE_LOG(LogTemp, Log,
                       TEXT("[AgentBrain] Ready for agent %s (ELO: %d)"),
                       *AgentId, AgentProfile.EloRating);
                OnBrainReady.Broadcast(AgentId);
            }));
}

void UAgentBrainComponent::GetNextAction(const FAIArenaGameState& GameState)
{
    const UAIArenaConfig* Cfg = UAIArenaConfig::Get();

    if (!bIsReady || !Cfg->bEnableAIInference)
    {
        OnActionReceived.Broadcast(GetFallbackAction(GameState));
        return;
    }

    // Check 50 ms TTL cache
    uint32 StateHash = HashGameState(GameState);
    double Now = FPlatformTime::Seconds();
    static constexpr double CacheTTL = 0.050; // 50 ms

    if (auto* Cached = ActionCache.Find(StateHash))
    {
        if ((Now - Cached->Get<1>()) < CacheTTL)
        {
            FAIArenaAgentAction CachedAction = Cached->Get<0>();
            CachedAction.Source = TEXT("CACHED");
            OnActionReceived.Broadcast(CachedAction);
            return;
        }
        ActionCache.Remove(StateHash);
    }

    // Fire inference request with hard timeout fallback
    UAIArenaInferenceGateway* Gateway =
        NewObject<UAIArenaInferenceGateway>(this);

    // Capture for lambda
    TArray<FString> EmptyContext;
    FString AId = CurrentAgentId;

    Gateway->GetCombatAction(
        CurrentAgentId, GameState, EmptyContext,
        FOnInferenceResult::CreateLambda(
            [this, StateHash, Now](const FAIArenaAgentAction& Action)
            {
                // Cache successful AI responses
                if (Action.Source == TEXT("AI"))
                {
                    ActionCache.Emplace(StateHash, MakeTuple(Action, Now));
                }
                OnActionReceived.Broadcast(Action);
            }));
}

void UAgentBrainComponent::RecordActionOutcome(const FAIArenaAgentAction& Action,
                                                const FAIArenaActionOutcome& Outcome)
{
    auto Body = MakeShared<FJsonObject>();
    Body->SetStringField(TEXT("agentId"),    CurrentAgentId);
    Body->SetStringField(TEXT("actionType"), Action.ActionType);
    Body->SetBoolField  (TEXT("success"),    Outcome.bSuccess);
    Body->SetNumberField(TEXT("importance"), Outcome.Importance);

    FAIArenaApiClient::Post(
        FString::Printf(TEXT("/agents/%s/memory/working"), *CurrentAgentId),
        Body,
        FOnApiResponse::CreateLambda(
            [](bool bOK, TSharedPtr<FJsonObject>)
            {
                if (!bOK)
                {
                    UE_LOG(LogTemp, Warning,
                           TEXT("[AgentBrain] Failed to store action memory."));
                }
            }));
}

FAIArenaAgentAction UAgentBrainComponent::GetFallbackAction(
    const FAIArenaGameState& GameState) const
{
    UAIArenaFallbackBehaviourAI* FB =
        NewObject<UAIArenaFallbackBehaviourAI>(GetTransientPackage());
    FB->Configure(BehaviourTraits);
    return FB->GetAction(GameState);
}

uint32 UAgentBrainComponent::HashGameState(const FAIArenaGameState& GS) const
{
    // Fast hash over the key fields that affect action selection
    uint32 H = GetTypeHash(GS.AgentId);
    H = HashCombine(H, GetTypeHash(FMath::RoundToInt(GS.Health)));
    H = HashCombine(H, GetTypeHash(FMath::RoundToInt(GS.Position.X)));
    H = HashCombine(H, GetTypeHash(FMath::RoundToInt(GS.Position.Z)));
    H = HashCombine(H, GetTypeHash(GS.NearbyEnemies.Num()));
    return H;
}
