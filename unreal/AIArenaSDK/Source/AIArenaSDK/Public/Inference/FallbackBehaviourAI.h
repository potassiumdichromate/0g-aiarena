#pragma once

#include "CoreMinimal.h"
#include "UObject/NoExportTypes.h"
#include "Core/AIArenaTypes.h"
#include "FallbackBehaviourAI.generated.h"

/**
 * UAIArenaFallbackBehaviourAI
 *
 * Deterministic heuristic AI used when:
 *   - The inference-service is unreachable
 *   - The InferenceTimeoutMs deadline fires before a response arrives
 *   - The SDK has not been initialised yet
 *
 * Logic mirrors the server-side fallback in inference-service:
 *   confidence = 0.2, source = "FALLBACK"
 *
 * Trait weights (from the loaded AgentProfile) bias the decision:
 *   Aggression > 0.6  → prefer ATTACK
 *   Health < 25%      → prefer FLEE
 *   RiskTolerance < 0.4 → prefer DEFEND
 *   Default           → IDLE
 */
UCLASS(BlueprintType)
class AIARENASDK_API UAIArenaFallbackBehaviourAI : public UObject
{
    GENERATED_BODY()

public:
    /** Configure the heuristic with agent trait weights. */
    UFUNCTION(BlueprintCallable, Category = "AI Arena|Inference")
    void Configure(const FAIArenaAgentTraits& Traits);

    /**
     * Return a heuristic action for the given game state.
     * Always returns synchronously — never blocks.
     */
    UFUNCTION(BlueprintCallable, BlueprintPure, Category = "AI Arena|Inference")
    FAIArenaAgentAction GetAction(const FAIArenaGameState& GameState) const;

private:
    FAIArenaAgentTraits CachedTraits;
};
