#include "Telemetry/TelemetryCollector.h"
#include "Core/AIArenaApiClient.h"
#include "Core/AIArenaConfig.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Serialization/JsonWriter.h"
#include "Serialization/JsonSerializer.h"
#include "TimerManager.h"
#include "Engine/World.h"
#include "Engine/GameInstance.h"
#include "HAL/PlatformTime.h"
#include "Misc/Guid.h"

void UAIArenaTelemetryCollector::Initialize(FSubsystemCollectionBase& Collection)
{
    Super::Initialize(Collection);
}

void UAIArenaTelemetryCollector::Deinitialize()
{
    if (GetGameInstance())
    {
        GetGameInstance()->GetTimerManager().ClearTimer(FlushTimerHandle);
    }
    // Best-effort flush on shutdown
    Flush();
    Super::Deinitialize();
}

void UAIArenaTelemetryCollector::StartSession(const FString& SessionId,
                                               const FString& AgentId)
{
    ActiveSessionId = SessionId;
    ActiveAgentId   = AgentId;
    SequenceNumber  = 0;
    RetryCount      = 0;
    EventBuffer.Reset();
    SchedulePeriodicFlush();
    UE_LOG(LogTemp, Log,
           TEXT("[TelemetryCollector] Session started: %s"), *SessionId);
}

void UAIArenaTelemetryCollector::EndSession()
{
    GetGameInstance()->GetTimerManager().ClearTimer(FlushTimerHandle);
    Flush();
    ActiveSessionId.Empty();
    ActiveAgentId.Empty();
}

void UAIArenaTelemetryCollector::SchedulePeriodicFlush()
{
    const UAIArenaConfig* Cfg = UAIArenaConfig::Get();
    GetGameInstance()->GetTimerManager().SetTimer(
        FlushTimerHandle,
        FTimerDelegate::CreateUObject(this, &UAIArenaTelemetryCollector::Flush),
        Cfg->TelemetryFlushIntervalSeconds, /*bLoop=*/true);
}

// ── Event helpers ──────────────────────────────────────────────────────────────

static FString Vec3Json(FVector V)
{
    return FString::Printf(TEXT("{\"x\":%.2f,\"y\":%.2f,\"z\":%.2f}"), V.X, V.Y, V.Z);
}

void UAIArenaTelemetryCollector::RecordCombatAction(const FString& ActionType,
                                                     const FString& TargetId,
                                                     FVector Position,
                                                     bool bSuccess,
                                                     float DamageDealt,
                                                     float LatencyMs)
{
    FString Payload = FString::Printf(
        TEXT("{\"actionType\":\"%s\",\"targetId\":\"%s\","
             "\"position\":%s,\"success\":%s,"
             "\"damageDealt\":%.2f,\"latencyMs\":%.1f}"),
        *ActionType, *TargetId, *Vec3Json(Position),
        bSuccess ? TEXT("true") : TEXT("false"),
        DamageDealt, LatencyMs);
    Enqueue(TEXT("COMBAT_ACTION"), Payload);
}

void UAIArenaTelemetryCollector::RecordPositionUpdate(FVector Position,
                                                       FVector Velocity,
                                                       float Rotation)
{
    FString Payload = FString::Printf(
        TEXT("{\"position\":%s,\"velocity\":%s,\"rotation\":%.2f}"),
        *Vec3Json(Position), *Vec3Json(Velocity), Rotation);
    Enqueue(TEXT("POSITION_UPDATE"), Payload);
}

void UAIArenaTelemetryCollector::RecordAbilityUse(const FString& AbilityId,
                                                   const FString& AbilityName,
                                                   const FString& TargetId,
                                                   float CooldownMs)
{
    FString Payload = FString::Printf(
        TEXT("{\"abilityId\":\"%s\",\"abilityName\":\"%s\","
             "\"targetId\":\"%s\",\"cooldownMs\":%.1f}"),
        *AbilityId, *AbilityName, *TargetId, CooldownMs);
    Enqueue(TEXT("ABILITY_USE"), Payload);
}

void UAIArenaTelemetryCollector::RecordHealthChange(float PreviousHp,
                                                     float CurrentHp,
                                                     float MaxHp,
                                                     const FString& ChangeReason,
                                                     const FString& SourceId)
{
    FString Payload = FString::Printf(
        TEXT("{\"previousHp\":%.1f,\"currentHp\":%.1f,\"maxHp\":%.1f,"
             "\"changeReason\":\"%s\",\"sourceId\":\"%s\"}"),
        PreviousHp, CurrentHp, MaxHp, *ChangeReason, *SourceId);
    Enqueue(TEXT("HEALTH_CHANGE"), Payload);
}

void UAIArenaTelemetryCollector::RecordKill(const FString& VictimId,
                                             const FString& WeaponUsed,
                                             FVector Position,
                                             int32 KillStreak)
{
    FString Payload = FString::Printf(
        TEXT("{\"victimId\":\"%s\",\"weaponUsed\":\"%s\","
             "\"position\":%s,\"killStreak\":%d}"),
        *VictimId, *WeaponUsed, *Vec3Json(Position), KillStreak);
    Enqueue(TEXT("KILL"), Payload);
}

// ── Internal ──────────────────────────────────────────────────────────────────

void UAIArenaTelemetryCollector::Enqueue(const FString& EventType,
                                          const FString& PayloadJson)
{
    const UAIArenaConfig* Cfg = UAIArenaConfig::Get();
    if (!Cfg->bEnableTelemetry || ActiveSessionId.IsEmpty()) return;

    FAIArenaTelemetryEvent Evt;
    Evt.EventId        = FGuid::NewGuid().ToString();
    Evt.SessionId      = ActiveSessionId;
    Evt.AgentId        = ActiveAgentId;
    Evt.EventType      = EventType;
    Evt.TimestampMs    = (int64)(FPlatformTime::Seconds() * 1000.0);
    Evt.SequenceNumber = SequenceNumber++;
    Evt.PayloadJson    = PayloadJson;

    EventBuffer.Add(Evt);

    if (EventBuffer.Num() >= Cfg->TelemetryBatchSize)
    {
        Flush();
    }
}

void UAIArenaTelemetryCollector::FlushImmediate()
{
    Flush();
}

void UAIArenaTelemetryCollector::Flush()
{
    if (EventBuffer.IsEmpty() || ActiveSessionId.IsEmpty()) return;

    // Snapshot and clear the buffer
    TArray<FAIArenaTelemetryEvent> Batch = MoveTemp(EventBuffer);
    EventBuffer.Reset();

    // Build JSON array of events
    FString EventsJson = TEXT("[");
    for (int32 i = 0; i < Batch.Num(); i++)
    {
        const FAIArenaTelemetryEvent& E = Batch[i];
        EventsJson += FString::Printf(
            TEXT("{\"eventId\":\"%s\",\"sessionId\":\"%s\",\"agentId\":\"%s\","
                 "\"eventType\":\"%s\",\"timestamp\":%lld,\"seq\":%d,"
                 "\"payload\":%s}"),
            *E.EventId, *E.SessionId, *E.AgentId,
            *E.EventType, E.TimestampMs, E.SequenceNumber,
            *E.PayloadJson);
        if (i < Batch.Num() - 1) EventsJson += TEXT(",");
    }
    EventsJson += TEXT("]");

    FString BatchId = FString::Printf(
        TEXT("%s-%lld"), *ActiveSessionId,
        (int64)(FPlatformTime::Seconds() * 1000.0));

    FString Body = FString::Printf(
        TEXT("{\"batchId\":\"%s\",\"sessionId\":\"%s\","
             "\"agentId\":\"%s\",\"events\":%s}"),
        *BatchId, *ActiveSessionId, *ActiveAgentId, *EventsJson);

    FString Path = FString::Printf(
        TEXT("/sessions/%s/batch"), *ActiveSessionId);

    FAIArenaApiClient::PostRaw(Path, Body,
        FOnApiResponse::CreateLambda(
            [this, Batch](bool bOK, TSharedPtr<FJsonObject>)
            {
                if (bOK)
                {
                    RetryCount = 0;
                    UE_LOG(LogTemp, Verbose,
                           TEXT("[TelemetryCollector] Flushed %d events."),
                           Batch.Num());
                }
                else if (RetryCount < MaxRetries)
                {
                    RetryCount++;
                    UE_LOG(LogTemp, Warning,
                           TEXT("[TelemetryCollector] Flush failed (retry %d/%d). "
                                "Re-queuing %d events."),
                           RetryCount, MaxRetries, Batch.Num());
                    // Re-queue failed events at the front
                    EventBuffer.Insert(Batch, 0);
                }
                else
                {
                    UE_LOG(LogTemp, Error,
                           TEXT("[TelemetryCollector] Dropping %d events after %d retries."),
                           Batch.Num(), MaxRetries);
                    RetryCount = 0;
                }
            }));
}
