#pragma once

#include "CoreMinimal.h"
#include "Subsystems/GameInstanceSubsystem.h"
#include "TelemetryCollector.generated.h"

USTRUCT()
struct AIARENASDK_API FAIArenaTelemetryEvent
{
    GENERATED_BODY()

    UPROPERTY() FString EventId;
    UPROPERTY() FString SessionId;
    UPROPERTY() FString AgentId;
    UPROPERTY() FString EventType;
    UPROPERTY() int64   TimestampMs = 0;
    UPROPERTY() int32   SequenceNumber = 0;
    /** JSON-serialised payload string */
    UPROPERTY() FString PayloadJson;
};

/**
 * UAIArenaTelemetryCollector — GameInstance subsystem, lives for the full session.
 *
 * Records game events into an in-memory buffer and flushes them in batches
 * to POST /sessions/{id}/batch on the telemetry-service.
 *
 * Two flush triggers:
 *   1. Buffer reaches TelemetryBatchSize (100 events by default)
 *   2. TelemetryFlushIntervalSeconds timer fires (every 10 s)
 *
 * On flush failure the batch is re-queued at the front of the buffer and
 * retried on the next flush cycle (max 3 retries before dropping).
 */
UCLASS()
class AIARENASDK_API UAIArenaTelemetryCollector : public UGameInstanceSubsystem
{
    GENERATED_BODY()

public:
    virtual void Initialize(FSubsystemCollectionBase& Collection) override;
    virtual void Deinitialize() override;

    // ── Session Control ───────────────────────────────────────────────────────

    UFUNCTION(BlueprintCallable, Category = "AI Arena|Telemetry")
    void StartSession(const FString& SessionId, const FString& AgentId);

    UFUNCTION(BlueprintCallable, Category = "AI Arena|Telemetry")
    void EndSession();

    // ── Event Recording ───────────────────────────────────────────────────────

    UFUNCTION(BlueprintCallable, Category = "AI Arena|Telemetry")
    void RecordCombatAction(const FString& ActionType,
                            const FString& TargetId,
                            FVector Position,
                            bool bSuccess,
                            float DamageDealt,
                            float LatencyMs);

    UFUNCTION(BlueprintCallable, Category = "AI Arena|Telemetry")
    void RecordPositionUpdate(FVector Position, FVector Velocity, float Rotation);

    UFUNCTION(BlueprintCallable, Category = "AI Arena|Telemetry")
    void RecordAbilityUse(const FString& AbilityId,
                          const FString& AbilityName,
                          const FString& TargetId,
                          float CooldownMs);

    UFUNCTION(BlueprintCallable, Category = "AI Arena|Telemetry")
    void RecordHealthChange(float PreviousHp,
                            float CurrentHp,
                            float MaxHp,
                            const FString& ChangeReason,
                            const FString& SourceId = TEXT(""));

    UFUNCTION(BlueprintCallable, Category = "AI Arena|Telemetry")
    void RecordKill(const FString& VictimId,
                    const FString& WeaponUsed,
                    FVector Position,
                    int32 KillStreak);

    /** Immediately flush all buffered events. */
    UFUNCTION(BlueprintCallable, Category = "AI Arena|Telemetry")
    void FlushImmediate();

private:
    FString ActiveSessionId;
    FString ActiveAgentId;
    int32   SequenceNumber = 0;
    int32   RetryCount     = 0;
    static constexpr int32 MaxRetries = 3;

    TArray<FAIArenaTelemetryEvent> EventBuffer;
    FTimerHandle FlushTimerHandle;

    void Enqueue(const FString& EventType, const FString& PayloadJson);
    void Flush();
    void SchedulePeriodicFlush();
};
