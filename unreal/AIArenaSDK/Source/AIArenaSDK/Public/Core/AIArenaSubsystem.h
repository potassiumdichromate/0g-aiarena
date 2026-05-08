#pragma once

#include "CoreMinimal.h"
#include "Subsystems/GameInstanceSubsystem.h"
#include "Core/AIArenaTypes.h"
#include "IWebSocket.h"
#include "AIArenaSubsystem.generated.h"

DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FOnSDKInitialized, bool, bSuccess);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FOnSessionStarted,  const FString&, SessionId);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FOnAgentProfileLoaded, const FAIArenaAgentProfile&, Profile);

/**
 * UAIArenaSubsystem — main entry point for the AI Arena SDK.
 *
 * Automatically created by UE when the game instance starts.
 * Access it from anywhere via:
 *
 *   UAIArenaSubsystem* SDK = GameInstance->GetSubsystem<UAIArenaSubsystem>();
 *
 * Or from Blueprint: Get Game Instance → Get Subsystem (AI Arena).
 *
 * Minimum UE version: 5.0
 */
UCLASS()
class AIARENASDK_API UAIArenaSubsystem : public UGameInstanceSubsystem
{
    GENERATED_BODY()

public:
    // ── USubsystem ────────────────────────────────────────────────────────────
    virtual void Initialize(FSubsystemCollectionBase& Collection) override;
    virtual void Deinitialize() override;

    // ── SDK Lifecycle ─────────────────────────────────────────────────────────

    /**
     * Initialise the SDK and establish the WebSocket connection.
     * Call this once from your GameMode or GameInstance BeginPlay.
     * Fires OnSDKInitialized when complete.
     */
    UFUNCTION(BlueprintCallable, Category = "AI Arena|Core")
    void InitializeSDK();

    /** True after InitializeSDK() completes successfully. */
    UFUNCTION(BlueprintPure, Category = "AI Arena|Core")
    bool IsSDKReady() const { return bIsInitialized; }

    /**
     * Start a telemetry session for an agent in a specific game.
     * Returns the session ID via the OnSessionStarted delegate.
     */
    UFUNCTION(BlueprintCallable, Category = "AI Arena|Core")
    void StartSession(const FString& AgentId, const FString& GameId);

    /**
     * End the current telemetry session and flush buffered events.
     */
    UFUNCTION(BlueprintCallable, Category = "AI Arena|Core")
    void EndSession(const FString& SessionId);

    /**
     * Fetch the full profile for an agent from the API.
     * Profile is delivered via the OnAgentProfileLoaded delegate.
     */
    UFUNCTION(BlueprintCallable, Category = "AI Arena|Agents")
    void GetAgentProfile(const FString& AgentId);

    /** Currently active session token (set after successful auth). */
    UPROPERTY(BlueprintReadOnly, Category = "AI Arena|Core")
    FString SessionToken;

    // ── Delegates ─────────────────────────────────────────────────────────────

    UPROPERTY(BlueprintAssignable, Category = "AI Arena|Events")
    FOnSDKInitialized OnSDKInitialized;

    UPROPERTY(BlueprintAssignable, Category = "AI Arena|Events")
    FOnSessionStarted OnSessionStarted;

    UPROPERTY(BlueprintAssignable, Category = "AI Arena|Events")
    FOnAgentProfileLoaded OnAgentProfileLoaded;

private:
    bool bIsInitialized = false;
    TSharedPtr<IWebSocket> WebSocket;
    int32 ReconnectAttempts = 0;
    FTimerHandle ReconnectTimerHandle;

    void ConnectWebSocket();
    void OnWebSocketConnected();
    void OnWebSocketConnectionError(const FString& Error);
    void OnWebSocketClosed(int32 StatusCode, const FString& Reason, bool bWasClean);
    void ScheduleReconnect();
};
