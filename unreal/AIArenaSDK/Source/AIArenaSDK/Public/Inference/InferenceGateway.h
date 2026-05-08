#pragma once

#include "CoreMinimal.h"
#include "UObject/NoExportTypes.h"
#include "Core/AIArenaTypes.h"
#include "InferenceGateway.generated.h"

DECLARE_DYNAMIC_DELEGATE_OneParam(FOnInferenceResult, const FAIArenaAgentAction&, Action);

/**
 * UAIArenaInferenceGateway
 *
 * Thin HTTP client that wraps the AI Arena inference-service endpoint.
 * POST /inference/action  →  FAIArenaAgentAction
 *
 * All requests include a hard InferenceTimeoutMs deadline configured in
 * UAIArenaConfig. If the request times out the delegate is still called
 * with a FALLBACK action so the caller never blocks.
 */
UCLASS(BlueprintType)
class AIARENASDK_API UAIArenaInferenceGateway : public UObject
{
    GENERATED_BODY()

public:
    /**
     * Request a combat action from the inference-service.
     *
     * @param AgentId       UUID of the requesting agent
     * @param GameState     Current observable battle state
     * @param MemoryContext Recent memory snippets for RAG (can be empty)
     * @param OnResult      Delegate called with the chosen action
     */
    UFUNCTION(BlueprintCallable, Category = "AI Arena|Inference")
    void GetCombatAction(const FString& AgentId,
                         const FAIArenaGameState& GameState,
                         const TArray<FString>& MemoryContext,
                         FOnInferenceResult OnResult);

private:
    /** Maps pending request IDs to their timeout timer handles. */
    TMap<FString, FTimerHandle> PendingTimers;

    void OnRequestTimeout(FString RequestId, FOnInferenceResult OnResult);
};
