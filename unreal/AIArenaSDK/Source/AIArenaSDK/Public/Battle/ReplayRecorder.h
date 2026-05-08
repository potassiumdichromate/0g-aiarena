#pragma once

#include "CoreMinimal.h"
#include "UObject/NoExportTypes.h"
#include "Core/AIArenaTypes.h"
#include "ReplayRecorder.generated.h"

USTRUCT(BlueprintType)
struct AIARENASDK_API FAIArenaReplayFrame
{
    GENERATED_BODY()

    UPROPERTY() int64   TimestampMs = 0;
    UPROPERTY() int32   FrameIndex  = 0;
    UPROPERTY() FString AgentId;
    UPROPERTY() FVector Position    = FVector::ZeroVector;
    UPROPERTY() float   Health      = 0.f;
    UPROPERTY() FString ActionType;
    UPROPERTY() float   Confidence  = 0.f;
};

/**
 * UAIArenaReplayRecorder
 *
 * Captures battle frames at 10 Hz for deterministic replay and dispute resolution.
 * The final replay blob (JSON array of frames) is SHA-256 hashed and compared
 * against the server-side finalStateHash on upload. Any mismatch triggers an
 * anticheat dispute via the battle-service.
 *
 * Frame storage is in-memory during the battle; upload happens via the
 * replay-service on EndBattle.
 */
UCLASS(BlueprintType)
class AIARENASDK_API UAIArenaReplayRecorder : public UObject
{
    GENERATED_BODY()

public:
    /** Start recording frames for a battle. */
    UFUNCTION(BlueprintCallable, Category = "AI Arena|Replay")
    void StartRecording(const FString& BattleId);

    /** Stop recording and upload the replay blob to the replay-service. */
    UFUNCTION(BlueprintCallable, Category = "AI Arena|Replay")
    void StopAndUpload(const FString& FinalStateHash);

    /**
     * Capture a single frame. Call this at ~10 Hz during the battle loop.
     */
    UFUNCTION(BlueprintCallable, Category = "AI Arena|Replay")
    void CaptureFrame(const FString& AgentId,
                      FVector Position,
                      float Health,
                      const FString& LastActionType,
                      float Confidence);

    UFUNCTION(BlueprintPure, Category = "AI Arena|Replay")
    bool IsRecording() const { return bIsRecording; }

    UFUNCTION(BlueprintPure, Category = "AI Arena|Replay")
    int32 GetFrameCount() const { return Frames.Num(); }

private:
    FString                     CurrentBattleId;
    bool                        bIsRecording = false;
    int32                       FrameIndex   = 0;
    TArray<FAIArenaReplayFrame>  Frames;
    FTimerHandle                 CaptureTimerHandle;

    FString SerializeFrames() const;
};
