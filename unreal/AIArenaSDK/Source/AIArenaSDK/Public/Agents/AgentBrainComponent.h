#pragma once

#include "CoreMinimal.h"
#include "Components/ActorComponent.h"
#include "Core/AIArenaTypes.h"
#include "AgentBrainComponent.generated.h"

DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FOnActionReceived, const FAIArenaAgentAction&, Action);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FOnBrainReady, const FString&, AgentId);

/**
 * UAgentBrainComponent — attach this to any Actor that represents an AI agent.
 *
 * Handles the inference → cache → fallback chain:
 *   1. Check InferenceCache (50 ms TTL)
 *   2. POST to inference-service with InferenceTimeoutMs deadline
 *   3. If timeout / error → UFallbackBehaviourAI heuristic
 *
 * Usage:
 *   1. Add this component to your AI Pawn in the editor or in C++.
 *   2. Call InitBrain(AgentId) from BeginPlay.
 *   3. Call GetNextAction(GameState) every tick (or on a timer).
 *   4. Bind to OnActionReceived for non-blocking Blueprint handling.
 */
UCLASS(ClassGroup = "AI Arena", meta = (BlueprintSpawnableComponent),
       DisplayName = "AI Arena Agent Brain")
class AIARENASDK_API UAgentBrainComponent : public UActorComponent
{
    GENERATED_BODY()

public:
    UAgentBrainComponent();

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    /**
     * Initialise the brain for a specific agent.
     * Loads the agent profile and configures the fallback heuristic.
     * Fires OnBrainReady when complete.
     */
    UFUNCTION(BlueprintCallable, Category = "AI Arena|Agent")
    void InitBrain(const FString& AgentId);

    /** True after InitBrain() has loaded the agent profile. */
    UFUNCTION(BlueprintPure, Category = "AI Arena|Agent")
    bool IsBrainReady() const { return bIsReady; }

    UPROPERTY(BlueprintReadOnly, Category = "AI Arena|Agent")
    FString CurrentAgentId;

    UPROPERTY(BlueprintReadOnly, Category = "AI Arena|Agent")
    FAIArenaAgentProfile AgentProfile;

    UPROPERTY(BlueprintReadOnly, Category = "AI Arena|Agent")
    FAIArenaAgentTraits BehaviourTraits;

    // ── Inference ─────────────────────────────────────────────────────────────

    /**
     * Request the next action for the given game state.
     * Returns immediately; the action (or fallback) is delivered via OnActionReceived.
     * Safe to call every game tick — cached results avoid redundant network calls.
     */
    UFUNCTION(BlueprintCallable, Category = "AI Arena|Inference")
    void GetNextAction(const FAIArenaGameState& GameState);

    /**
     * Record the real-world outcome of the last action.
     * Stored in working memory and used for future inference context.
     */
    UFUNCTION(BlueprintCallable, Category = "AI Arena|Inference")
    void RecordActionOutcome(const FAIArenaAgentAction& Action,
                             const FAIArenaActionOutcome& Outcome);

    // ── Delegates ─────────────────────────────────────────────────────────────

    UPROPERTY(BlueprintAssignable, Category = "AI Arena|Events")
    FOnActionReceived OnActionReceived;

    UPROPERTY(BlueprintAssignable, Category = "AI Arena|Events")
    FOnBrainReady OnBrainReady;

protected:
    virtual void BeginPlay() override;

private:
    bool bIsReady = false;

    // Cache: stores (StateHash → Action) with 50 ms TTL
    TMap<uint32, TTuple<FAIArenaAgentAction, double>> ActionCache;

    FAIArenaAgentAction GetFallbackAction(const FAIArenaGameState& GameState) const;
    uint32 HashGameState(const FAIArenaGameState& GameState) const;
};
