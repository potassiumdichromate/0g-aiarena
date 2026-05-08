#include "Core/AIArenaSubsystem.h"
#include "Core/AIArenaConfig.h"
#include "Core/AIArenaApiClient.h"
#include "WebSocketsModule.h"
#include "IWebSocket.h"
#include "Dom/JsonObject.h"
#include "TimerManager.h"
#include "Engine/World.h"
#include "Engine/GameInstance.h"

void UAIArenaSubsystem::Initialize(FSubsystemCollectionBase& Collection)
{
    Super::Initialize(Collection);
    UE_LOG(LogTemp, Log, TEXT("[AIArenaSubsystem] Subsystem created."));
}

void UAIArenaSubsystem::Deinitialize()
{
    if (WebSocket.IsValid() && WebSocket->IsConnected())
    {
        WebSocket->Close();
    }
    Super::Deinitialize();
}

void UAIArenaSubsystem::InitializeSDK()
{
    if (bIsInitialized)
    {
        UE_LOG(LogTemp, Warning, TEXT("[AIArenaSubsystem] Already initialized."));
        return;
    }

    ConnectWebSocket();
}

void UAIArenaSubsystem::ConnectWebSocket()
{
    const UAIArenaConfig* Cfg = UAIArenaConfig::Get();

    if (!FModuleManager::Get().IsModuleLoaded(TEXT("WebSockets")))
    {
        FModuleManager::LoadModuleChecked<FWebSocketsModule>(TEXT("WebSockets"));
    }

    WebSocket = FWebSocketsModule::Get().CreateWebSocket(
        Cfg->WebSocketUrl, TEXT("wss"));

    WebSocket->OnConnected().AddUObject(this, &UAIArenaSubsystem::OnWebSocketConnected);
    WebSocket->OnConnectionError().AddUObject(this, &UAIArenaSubsystem::OnWebSocketConnectionError);
    WebSocket->OnClosed().AddUObject(this, &UAIArenaSubsystem::OnWebSocketClosed);

    UE_LOG(LogTemp, Log, TEXT("[AIArenaSubsystem] Connecting to %s"), *Cfg->WebSocketUrl);
    WebSocket->Connect();
}

void UAIArenaSubsystem::OnWebSocketConnected()
{
    UE_LOG(LogTemp, Log, TEXT("[AIArenaSubsystem] WebSocket connected."));
    ReconnectAttempts = 0;
    bIsInitialized    = true;
    OnSDKInitialized.Broadcast(true);
}

void UAIArenaSubsystem::OnWebSocketConnectionError(const FString& Error)
{
    UE_LOG(LogTemp, Warning,
           TEXT("[AIArenaSubsystem] WebSocket connection error: %s"), *Error);
    ScheduleReconnect();
}

void UAIArenaSubsystem::OnWebSocketClosed(int32 StatusCode,
                                           const FString& Reason,
                                           bool bWasClean)
{
    if (!bWasClean)
    {
        UE_LOG(LogTemp, Warning,
               TEXT("[AIArenaSubsystem] WebSocket closed unexpectedly (%d %s). Reconnecting…"),
               StatusCode, *Reason);
        ScheduleReconnect();
    }
}

void UAIArenaSubsystem::ScheduleReconnect()
{
    static constexpr int32 MaxAttempts = 10;
    if (ReconnectAttempts >= MaxAttempts)
    {
        UE_LOG(LogTemp, Error,
               TEXT("[AIArenaSubsystem] Max reconnect attempts reached. SDK offline."));
        OnSDKInitialized.Broadcast(false);
        return;
    }

    const UAIArenaConfig* Cfg = UAIArenaConfig::Get();
    // Exponential back-off: 2s, 4s, 8s … capped at 60s
    float Delay = FMath::Min(
        Cfg->ReconnectDelaySeconds * FMath::Pow(2.f, (float)ReconnectAttempts),
        60.f);

    ReconnectAttempts++;
    UE_LOG(LogTemp, Log,
           TEXT("[AIArenaSubsystem] Reconnect attempt %d in %.1fs"), ReconnectAttempts, Delay);

    GetGameInstance()->GetTimerManager().SetTimer(
        ReconnectTimerHandle,
        FTimerDelegate::CreateUObject(this, &UAIArenaSubsystem::ConnectWebSocket),
        Delay, /*bLoop=*/false);
}

void UAIArenaSubsystem::StartSession(const FString& AgentId, const FString& GameId)
{
    auto Body = MakeShared<FJsonObject>();
    Body->SetStringField(TEXT("agentId"), AgentId);
    Body->SetStringField(TEXT("gameId"),  GameId);

    FAIArenaApiClient::Post(TEXT("/sessions/start"), Body,
        FOnApiResponse::CreateLambda(
            [this, AgentId](bool bOK, TSharedPtr<FJsonObject> Json)
            {
                if (!bOK || !Json.IsValid()) return;
                FString SId;
                if (Json->TryGetStringField(TEXT("sessionId"), SId))
                {
                    OnSessionStarted.Broadcast(SId);
                }
            }));
}

void UAIArenaSubsystem::EndSession(const FString& SessionId)
{
    FAIArenaApiClient::Post(
        FString::Printf(TEXT("/sessions/%s/end"), *SessionId),
        MakeShared<FJsonObject>(),
        FOnApiResponse::CreateLambda(
            [SessionId](bool bOK, TSharedPtr<FJsonObject>)
            {
                UE_LOG(LogTemp, Log,
                       TEXT("[AIArenaSubsystem] Session %s ended (ok=%d)"),
                       *SessionId, bOK);
            }));
}

void UAIArenaSubsystem::GetAgentProfile(const FString& AgentId)
{
    FAIArenaApiClient::Get(
        FString::Printf(TEXT("/agents/%s"), *AgentId),
        FOnApiResponse::CreateLambda(
            [this, AgentId](bool bOK, TSharedPtr<FJsonObject> Json)
            {
                if (!bOK || !Json.IsValid()) return;

                FAIArenaAgentProfile Profile;
                Profile.Id      = AgentId;
                Json->TryGetStringField(TEXT("name"),           Profile.Name);
                Json->TryGetStringField(TEXT("clan"),           Profile.Clan);
                Json->TryGetStringField(TEXT("archetype"),      Profile.Archetype);
                Json->TryGetStringField(TEXT("evolutionStage"), Profile.EvolutionStage);
                Json->TryGetNumberField(TEXT("eloRating"),      Profile.EloRating);
                Json->TryGetNumberField(TEXT("wins"),           Profile.Wins);
                Json->TryGetNumberField(TEXT("losses"),         Profile.Losses);

                const TSharedPtr<FJsonObject>* Traits = nullptr;
                if (Json->TryGetObjectField(TEXT("traits"), Traits))
                {
                    (*Traits)->TryGetNumberField(TEXT("aggression"),    Profile.Traits.Aggression);
                    (*Traits)->TryGetNumberField(TEXT("patience"),      Profile.Traits.Patience);
                    (*Traits)->TryGetNumberField(TEXT("adaptability"),  Profile.Traits.Adaptability);
                    (*Traits)->TryGetNumberField(TEXT("riskTolerance"), Profile.Traits.RiskTolerance);
                    (*Traits)->TryGetNumberField(TEXT("teamwork"),      Profile.Traits.Teamwork);
                    (*Traits)->TryGetNumberField(TEXT("creativity"),    Profile.Traits.Creativity);
                    (*Traits)->TryGetNumberField(TEXT("endurance"),     Profile.Traits.Endurance);
                    (*Traits)->TryGetNumberField(TEXT("precision"),     Profile.Traits.Precision);
                }

                OnAgentProfileLoaded.Broadcast(Profile);
            }));
}
