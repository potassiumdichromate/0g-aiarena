#include "Agents/AgentMemoryContext.h"
#include "Core/AIArenaApiClient.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"

void UAgentMemoryContext::FetchRecentMemories(const FString& AgentId,
                                               int32 Limit,
                                               FOnMemoryLoaded OnMemoryLoaded)
{
    FString Path = FString::Printf(
        TEXT("/agents/%s/memory?limit=%d"), *AgentId, FMath::Max(1, Limit));

    FAIArenaApiClient::Get(Path,
        FOnApiResponse::CreateLambda(
            [OnMemoryLoaded](bool bOK, TSharedPtr<FJsonObject> Json)
            {
                TArray<FString> Snippets;
                if (bOK && Json.IsValid())
                {
                    const TArray<TSharedPtr<FJsonValue>>* Items = nullptr;
                    if (Json->TryGetArrayField(TEXT("memories"), Items))
                    {
                        for (auto& Item : *Items)
                        {
                            FString Content;
                            if (Item->AsObject()->TryGetStringField(TEXT("content"), Content))
                            {
                                Snippets.Add(Content);
                            }
                        }
                    }
                }
                OnMemoryLoaded.ExecuteIfBound(Snippets);
            }));
}

void UAgentMemoryContext::StoreWorkingMemory(const FString& AgentId,
                                              const FString& ActionType,
                                              bool bSuccess,
                                              float Importance)
{
    auto Body = MakeShared<FJsonObject>();
    Body->SetStringField(TEXT("agentId"),    AgentId);
    Body->SetStringField(TEXT("actionType"), ActionType);
    Body->SetBoolField  (TEXT("success"),    bSuccess);
    Body->SetNumberField(TEXT("importance"), Importance);

    FAIArenaApiClient::Post(
        FString::Printf(TEXT("/agents/%s/memory/working"), *AgentId),
        Body,
        FOnApiResponse::CreateLambda(
            [](bool bOK, TSharedPtr<FJsonObject>)
            {
                if (!bOK)
                {
                    UE_LOG(LogTemp, Warning,
                           TEXT("[AgentMemoryContext] Working memory store failed."));
                }
            }));
}
