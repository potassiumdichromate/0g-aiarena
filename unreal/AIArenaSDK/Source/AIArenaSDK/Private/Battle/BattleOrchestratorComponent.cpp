#include "Battle/BattleOrchestratorComponent.h"
#include "Core/AIArenaApiClient.h"
#include "Core/AIArenaConfig.h"
#include "WebSocketsModule.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

UBattleOrchestratorComponent::UBattleOrchestratorComponent()
{
    PrimaryComponentTick.bCanEverTick = false;
}

void UBattleOrchestratorComponent::BeginPlay()
{
    Super::BeginPlay();
}

void UBattleOrchestratorComponent::EndPlay(const EEndPlayReason::Type Reason)
{
    DisconnectWS();
    Super::EndPlay(Reason);
}

void UBattleOrchestratorComponent::CreateBattle(const FString& AgentId,
                                                  const FString& OpponentId,
                                                  const FString& Mode,
                                                  const FString& GameId)
{
    CurrentStatus = EAIArenaBattleStatus::Creating;

    auto Body = MakeShared<FJsonObject>();
    Body->SetStringField(TEXT("agentId"),    AgentId);
    Body->SetStringField(TEXT("opponentId"), OpponentId);
    Body->SetStringField(TEXT("mode"),       Mode);
    Body->SetStringField(TEXT("gameId"),     GameId);

    FAIArenaApiClient::Post(TEXT("/battles"), Body,
        FOnApiResponse::CreateLambda(
            [this](bool bOK, TSharedPtr<FJsonObject> Json)
            {
                if (!bOK || !Json.IsValid())
                {
                    UE_LOG(LogTemp, Error, TEXT("[BattleOrchestrator] CreateBattle failed."));
                    CurrentStatus = EAIArenaBattleStatus::Idle;
                    return;
                }

                const TSharedPtr<FJsonObject>* BattleObj = nullptr;
                if (Json->TryGetObjectField(TEXT("battle"), BattleObj))
                {
                    (*BattleObj)->TryGetStringField(TEXT("id"), CurrentBattleId);
                }

                CurrentStatus = EAIArenaBattleStatus::WaitingForOpponent;
                SubscribeToBattleWS(CurrentBattleId);

                UE_LOG(LogTemp, Log,
                       TEXT("[BattleOrchestrator] Battle created: %s"), *CurrentBattleId);
                OnBattleCreated.Broadcast(CurrentBattleId);
            }));
}

void UBattleOrchestratorComponent::SubscribeToBattleWS(const FString& BattleId)
{
    const UAIArenaConfig* Cfg = UAIArenaConfig::Get();
    FString WsUrl = FString::Printf(
        TEXT("%s/battles/ws/battle/%s"), *Cfg->WebSocketUrl, *BattleId);

    if (!FModuleManager::Get().IsModuleLoaded(TEXT("WebSockets")))
    {
        FModuleManager::LoadModuleChecked<FWebSocketsModule>(TEXT("WebSockets"));
    }

    StateSocket = FWebSocketsModule::Get().CreateWebSocket(WsUrl, TEXT("wss"));
    StateSocket->OnMessage().AddUObject(
        this, &UBattleOrchestratorComponent::OnWSMessage);
    StateSocket->Connect();
}

void UBattleOrchestratorComponent::OnWSMessage(const FString& MessageStr)
{
    TSharedPtr<FJsonObject> Json;
    TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(MessageStr);
    if (!FJsonSerializer::Deserialize(Reader, Json) || !Json.IsValid()) return;

    FAIArenaBattleState State;
    Json->TryGetStringField(TEXT("battleId"), State.BattleId);
    Json->TryGetStringField(TEXT("status"),   State.Status);
    Json->TryGetNumberField(TEXT("round"),    State.Round);

    if (State.Status == TEXT("IN_PROGRESS"))
        CurrentStatus = EAIArenaBattleStatus::InProgress;
    else if (State.Status == TEXT("COMPLETED"))
        CurrentStatus = EAIArenaBattleStatus::Completed;

    OnBattleStateUpdated.Broadcast(State);
}

void UBattleOrchestratorComponent::EndBattle(const FAIArenaBattleResult& Result)
{
    DisconnectWS();
    CurrentStatus = EAIArenaBattleStatus::Completed;
    UE_LOG(LogTemp, Log,
           TEXT("[BattleOrchestrator] Battle %s ended. Winner: %s"),
           *CurrentBattleId, *Result.WinnerId);
    OnBattleEnded.Broadcast(Result);
}

void UBattleOrchestratorComponent::DisconnectWS()
{
    if (StateSocket.IsValid() && StateSocket->IsConnected())
    {
        StateSocket->Close();
    }
    StateSocket.Reset();
}
