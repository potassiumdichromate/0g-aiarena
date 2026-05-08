#pragma once

#include "CoreMinimal.h"
#include "UObject/NoExportTypes.h"
#include "AgentMemoryContext.generated.h"

DECLARE_DYNAMIC_DELEGATE_OneParam(FOnMemoryLoaded, const TArray<FString>&, MemorySnippets);

/**
 * Retrieves recent episodic memories from the memory-service for use as
 * RAG context in inference requests.
 *
 * Memories are short text snippets ranked by recency and importance, e.g.:
 *   "Opponent uses flanking against ranged agents"
 *   "High aggression backfired in last 3 close-range encounters"
 */
UCLASS(BlueprintType)
class AIARENASDK_API UAgentMemoryContext : public UObject
{
    GENERATED_BODY()

public:
    /**
     * Fetch the top N most relevant memories for this agent.
     * Results are delivered asynchronously via OnMemoryLoaded.
     * @param AgentId  The agent whose memory to query
     * @param Limit    Maximum number of snippets to return (default 5)
     */
    UFUNCTION(BlueprintCallable, Category = "AI Arena|Memory")
    void FetchRecentMemories(const FString& AgentId,
                             int32 Limit,
                             FOnMemoryLoaded OnMemoryLoaded);

    /**
     * Store an action outcome in the agent's working memory.
     * Fires-and-forgets — does not block the calling thread.
     */
    UFUNCTION(BlueprintCallable, Category = "AI Arena|Memory")
    void StoreWorkingMemory(const FString& AgentId,
                            const FString& ActionType,
                            bool bSuccess,
                            float Importance);
};
