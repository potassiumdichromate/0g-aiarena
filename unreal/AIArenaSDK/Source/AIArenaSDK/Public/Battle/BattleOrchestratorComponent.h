#pragma once

#include "CoreMinimal.h"
#include "Components/ActorComponent.h"
#include "Core/AIArenaTypes.h"
#include "IWebSocket.h"
#include "BattleOrchestratorComponent.generated.h"

DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FOnBattleCreated,      const FString&,             BattleId);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FOnBattleStateUpdated, const FAIArenaBattleState&, State);
DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(FOnBattleEnded,        const FAIArenaBattleResult&, Result);

/**
 * UBattleOrchestratorComponent
 *
 * Attach to your GameMode or a dedicated BattleManager Actor.
 * Manages the full battle lifecycle:
 *   CreateBattle → WebSocket state sync → EndBattle → replay upload
 *
 * Blueprint usage:
 *   1. Add component to GameMode BP
 *   2. Bind OnBattleStateUpdated to update health bars, positions, etc.
 *   3. Call CreateBattle on match start; EndBattle when win/loss determined
 */
UCLASS(ClassGroup = "AI Arena", meta = (BlueprintSpawnableComponent),
       DisplayName = "AI Arena Battle Orchestrator")
class AIARENASDK_API UBattleOrchestratorComponent : public UActorComponent
{
    GENERATED_BODY()

public:
    UBattleOrchestratorComponent();

    // ── Battle Lifecycle ──────────────────────────────────────────────────────

    /**
     * Create a new battle between two agents.
     * Fires OnBattleCreated with the battle ID on success.
     */
    UFUNCTION(BlueprintCallable, Category = "AI Arena|Battle")
    void CreateBattle(const FString& AgentId,
                      const FString& OpponentId,
                      const FString& Mode,
                      const FString& GameId);

    /**
     * Signal that the battle is complete.
     * Stops replay recording and fires OnBattleEnded.
     */
    UFUNCTION(BlueprintCallable, Category = "AI Arena|Battle")
    void EndBattle(const FAIArenaBattleResult& Result);

    UFUNCTION(BlueprintPure, Category = "AI Arena|Battle")
    EAIArenaBattleStatus GetStatus() const { return CurrentStatus; }

    UFUNCTION(BlueprintPure, Category = "AI Arena|Battle")
    FString GetCurrentBattleId() const { return CurrentBattleId; }

    // ── Delegates ─────────────────────────────────────────────────────────────

    UPROPERTY(BlueprintAssignable, Category = "AI Arena|Events")
    FOnBattleCreated OnBattleCreated;

    UPROPERTY(BlueprintAssignable, Category = "AI Arena|Events")
    FOnBattleStateUpdated OnBattleStateUpdated;

    UPROPERTY(BlueprintAssignable, Category = "AI Arena|Events")
    FOnBattleEnded OnBattleEnded;

protected:
    virtual void BeginPlay()  override;
    virtual void EndPlay(const EEndPlayReason::Type EndPlayReason) override;

private:
    FString                  CurrentBattleId;
    EAIArenaBattleStatus     CurrentStatus = EAIArenaBattleStatus::Idle;
    TSharedPtr<IWebSocket>   StateSocket;

    void SubscribeToBattleWS(const FString& BattleId);
    void OnWSMessage(const FString& MessageStr);
    void DisconnectWS();
};
