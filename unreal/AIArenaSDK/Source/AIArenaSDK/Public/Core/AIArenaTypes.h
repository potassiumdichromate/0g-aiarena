#pragma once

#include "CoreMinimal.h"
#include "AIArenaTypes.generated.h"

// ── Agent ─────────────────────────────────────────────────────────────────────

USTRUCT(BlueprintType)
struct AIARENASDK_API FAIArenaAgentTraits
{
    GENERATED_BODY()

    UPROPERTY(BlueprintReadOnly) float Aggression    = 0.5f;
    UPROPERTY(BlueprintReadOnly) float Patience      = 0.5f;
    UPROPERTY(BlueprintReadOnly) float Adaptability  = 0.5f;
    UPROPERTY(BlueprintReadOnly) float RiskTolerance = 0.5f;
    UPROPERTY(BlueprintReadOnly) float Teamwork      = 0.5f;
    UPROPERTY(BlueprintReadOnly) float Creativity    = 0.5f;
    UPROPERTY(BlueprintReadOnly) float Endurance     = 0.5f;
    UPROPERTY(BlueprintReadOnly) float Precision     = 0.5f;
};

USTRUCT(BlueprintType)
struct AIARENASDK_API FAIArenaAgentProfile
{
    GENERATED_BODY()

    UPROPERTY(BlueprintReadOnly) FString Id;
    UPROPERTY(BlueprintReadOnly) FString Name;
    UPROPERTY(BlueprintReadOnly) FString Clan;
    UPROPERTY(BlueprintReadOnly) FString Archetype;
    UPROPERTY(BlueprintReadOnly) FString EvolutionStage;
    UPROPERTY(BlueprintReadOnly) int32   EloRating = 1000;
    UPROPERTY(BlueprintReadOnly) int32   Wins      = 0;
    UPROPERTY(BlueprintReadOnly) int32   Losses    = 0;
    UPROPERTY(BlueprintReadOnly) FAIArenaAgentTraits Traits;
};

// ── Game State ────────────────────────────────────────────────────────────────

USTRUCT(BlueprintType)
struct AIARENASDK_API FAIArenaEnemyInfo
{
    GENERATED_BODY()

    UPROPERTY(BlueprintReadOnly) FString Id;
    UPROPERTY(BlueprintReadOnly) FVector Position  = FVector::ZeroVector;
    UPROPERTY(BlueprintReadOnly) float   Health    = 100.f;
    UPROPERTY(BlueprintReadOnly) float   Distance  = 0.f;
};

USTRUCT(BlueprintType)
struct AIARENASDK_API FAIArenaGameState
{
    GENERATED_BODY()

    UPROPERTY(BlueprintReadWrite) FString             AgentId;
    UPROPERTY(BlueprintReadWrite) FVector             Position       = FVector::ZeroVector;
    UPROPERTY(BlueprintReadWrite) float               Health         = 100.f;
    UPROPERTY(BlueprintReadWrite) float               MaxHealth      = 100.f;
    UPROPERTY(BlueprintReadWrite) TArray<FString>     AvailableActions;
    UPROPERTY(BlueprintReadWrite) TArray<FAIArenaEnemyInfo> NearbyEnemies;
    UPROPERTY(BlueprintReadWrite) float               TimeRemaining  = 0.f;
};

// ── Action ────────────────────────────────────────────────────────────────────

USTRUCT(BlueprintType)
struct AIARENASDK_API FAIArenaAgentAction
{
    GENERATED_BODY()

    /** e.g. "ATTACK", "FLEE", "FLANK", "DEFEND", "IDLE" */
    UPROPERTY(BlueprintReadOnly) FString ActionType;
    UPROPERTY(BlueprintReadOnly) FString TargetId;
    UPROPERTY(BlueprintReadOnly) FVector TargetPosition = FVector::ZeroVector;
    UPROPERTY(BlueprintReadOnly) float   Confidence     = 0.f;
    /** "AI", "CACHED", or "FALLBACK" */
    UPROPERTY(BlueprintReadOnly) FString Source         = TEXT("AI");
};

USTRUCT(BlueprintType)
struct AIARENASDK_API FAIArenaActionOutcome
{
    GENERATED_BODY()

    UPROPERTY(BlueprintReadWrite) bool  bSuccess     = false;
    UPROPERTY(BlueprintReadWrite) float DamageDealt  = 0.f;
    UPROPERTY(BlueprintReadWrite) float Importance   = 0.5f;
};

// ── Battle ────────────────────────────────────────────────────────────────────

UENUM(BlueprintType)
enum class EAIArenaBattleStatus : uint8
{
    Idle               UMETA(DisplayName = "Idle"),
    Creating           UMETA(DisplayName = "Creating"),
    WaitingForOpponent UMETA(DisplayName = "Waiting For Opponent"),
    InProgress         UMETA(DisplayName = "In Progress"),
    Completed          UMETA(DisplayName = "Completed"),
};

USTRUCT(BlueprintType)
struct AIARENASDK_API FAIArenaBattleState
{
    GENERATED_BODY()

    UPROPERTY(BlueprintReadOnly) FString         BattleId;
    UPROPERTY(BlueprintReadOnly) FString         Status;
    UPROPERTY(BlueprintReadOnly) TArray<FString> AgentIds;
    UPROPERTY(BlueprintReadOnly) TArray<float>   HealthValues;
    UPROPERTY(BlueprintReadOnly) int32           Round = 0;
};

USTRUCT(BlueprintType)
struct AIARENASDK_API FAIArenaBattleResult
{
    GENERATED_BODY()

    UPROPERTY(BlueprintReadWrite) FString WinnerId;
    UPROPERTY(BlueprintReadWrite) FString LoserId;
    UPROPERTY(BlueprintReadWrite) int32   RoundsPlayed = 0;
};
