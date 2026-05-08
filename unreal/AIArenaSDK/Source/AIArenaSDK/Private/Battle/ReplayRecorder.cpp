#include "Battle/ReplayRecorder.h"
#include "Core/AIArenaApiClient.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Misc/SecureHash.h"
#include "Serialization/JsonWriter.h"
#include "Serialization/JsonSerializer.h"
#include "HAL/PlatformTime.h"

void UAIArenaReplayRecorder::StartRecording(const FString& BattleId)
{
    CurrentBattleId = BattleId;
    Frames.Reset();
    FrameIndex   = 0;
    bIsRecording = true;
    UE_LOG(LogTemp, Log,
           TEXT("[ReplayRecorder] Recording started for battle %s"), *BattleId);
}

void UAIArenaReplayRecorder::CaptureFrame(const FString& AgentId,
                                            FVector Position,
                                            float Health,
                                            const FString& LastActionType,
                                            float Confidence)
{
    if (!bIsRecording) return;

    FAIArenaReplayFrame Frame;
    Frame.TimestampMs  = (int64)(FPlatformTime::Seconds() * 1000.0);
    Frame.FrameIndex   = FrameIndex++;
    Frame.AgentId      = AgentId;
    Frame.Position     = Position;
    Frame.Health       = Health;
    Frame.ActionType   = LastActionType;
    Frame.Confidence   = Confidence;

    Frames.Add(Frame);
}

void UAIArenaReplayRecorder::StopAndUpload(const FString& FinalStateHash)
{
    if (!bIsRecording) return;
    bIsRecording = false;

    UE_LOG(LogTemp, Log,
           TEXT("[ReplayRecorder] Stopping. Captured %d frames. Uploading…"),
           Frames.Num());

    FString Json = SerializeFrames();

    // Verify: SHA-256(JSON) must match FinalStateHash
    FString LocalHash = FMD5::HashAnsiString(*Json); // swap for SHA-256 when available in project
    if (!FinalStateHash.IsEmpty() && LocalHash != FinalStateHash)
    {
        UE_LOG(LogTemp, Warning,
               TEXT("[ReplayRecorder] Hash mismatch — potential tampering detected. "
                    "Local=%s Expected=%s"), *LocalHash, *FinalStateHash);
    }

    auto Body = MakeShared<FJsonObject>();
    Body->SetStringField(TEXT("battleId"),       CurrentBattleId);
    Body->SetStringField(TEXT("replayData"),     Json);
    Body->SetStringField(TEXT("finalStateHash"), LocalHash);
    Body->SetNumberField(TEXT("frameCount"),     Frames.Num());

    FAIArenaApiClient::Post(TEXT("/replays"), Body,
        FOnApiResponse::CreateLambda(
            [this](bool bOK, TSharedPtr<FJsonObject>)
            {
                UE_LOG(LogTemp, Log,
                       TEXT("[ReplayRecorder] Upload %s for battle %s."),
                       bOK ? TEXT("succeeded") : TEXT("failed"),
                       *CurrentBattleId);
            }));
}

FString UAIArenaReplayRecorder::SerializeFrames() const
{
    TArray<TSharedPtr<FJsonValue>> JsonFrames;
    for (const FAIArenaReplayFrame& F : Frames)
    {
        auto Obj = MakeShared<FJsonObject>();
        Obj->SetNumberField(TEXT("ts"),         F.TimestampMs);
        Obj->SetNumberField(TEXT("frame"),      F.FrameIndex);
        Obj->SetStringField(TEXT("agentId"),    F.AgentId);
        Obj->SetNumberField(TEXT("px"),         F.Position.X);
        Obj->SetNumberField(TEXT("py"),         F.Position.Y);
        Obj->SetNumberField(TEXT("pz"),         F.Position.Z);
        Obj->SetNumberField(TEXT("hp"),         F.Health);
        Obj->SetStringField(TEXT("action"),     F.ActionType);
        Obj->SetNumberField(TEXT("confidence"), F.Confidence);
        JsonFrames.Add(MakeShared<FJsonValueObject>(Obj));
    }

    FString Out;
    TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Out);
    FJsonSerializer::Serialize(JsonFrames, Writer);
    return Out;
}
