#pragma once

#include "CoreMinimal.h"
#include "Engine/DeveloperSettings.h"
#include "AIArenaConfig.generated.h"

/**
 * AI Arena SDK configuration.
 * Editable in: Project Settings → Plugins → AI Arena SDK
 * Values are overridable per-platform and via env vars at runtime.
 */
UCLASS(Config = Game, DefaultConfig, meta = (DisplayName = "AI Arena SDK"))
class AIARENASDK_API UAIArenaConfig : public UDeveloperSettings
{
    GENERATED_BODY()

public:
    UAIArenaConfig();

    // ── API ──────────────────────────────────────────────────────────────────

    /** Base URL for the AI Arena REST API. */
    UPROPERTY(Config, EditAnywhere, BlueprintReadOnly, Category = "API",
              meta = (DisplayName = "API Base URL"))
    FString ApiBaseUrl = TEXT("https://api.aiarena.gg");

    /** WebSocket URL for real-time battle events. */
    UPROPERTY(Config, EditAnywhere, BlueprintReadOnly, Category = "API",
              meta = (DisplayName = "WebSocket URL"))
    FString WebSocketUrl = TEXT("wss://api.aiarena.gg");

    // ── Authentication ───────────────────────────────────────────────────────

    /** Game identifier issued by AI Arena. */
    UPROPERTY(Config, EditAnywhere, BlueprintReadOnly, Category = "Authentication")
    FString GameId;

    /** API key for server-to-server calls.  Store in Config/DefaultGame.ini — never commit. */
    UPROPERTY(Config, EditAnywhere, BlueprintReadOnly, Category = "Authentication",
              meta = (PasswordField = "true"))
    FString ApiKey;

    // ── Timeouts ─────────────────────────────────────────────────────────────

    /** HTTP request timeout in seconds. */
    UPROPERTY(Config, EditAnywhere, BlueprintReadOnly, Category = "Timeouts",
              meta = (ClampMin = "1.0", ClampMax = "60.0"))
    float RequestTimeoutSeconds = 5.0f;

    /**
     * Inference hard-deadline in milliseconds.
     * If the network call hasn't returned within this window the heuristic
     * fallback is used instantly so the battle tick never stalls.
     */
    UPROPERTY(Config, EditAnywhere, BlueprintReadOnly, Category = "Timeouts",
              meta = (ClampMin = "20", ClampMax = "5000"))
    int32 InferenceTimeoutMs = 50;

    /** WebSocket base reconnect delay in seconds (doubles on each failure). */
    UPROPERTY(Config, EditAnywhere, BlueprintReadOnly, Category = "Timeouts",
              meta = (ClampMin = "0.5", ClampMax = "30.0"))
    float ReconnectDelaySeconds = 2.0f;

    // ── Telemetry ────────────────────────────────────────────────────────────

    /** Maximum events in the local buffer before an automatic HTTP flush. */
    UPROPERTY(Config, EditAnywhere, BlueprintReadOnly, Category = "Telemetry",
              meta = (ClampMin = "10", ClampMax = "1000"))
    int32 TelemetryBatchSize = 100;

    /** Periodic flush interval in seconds (independent of batch-size flush). */
    UPROPERTY(Config, EditAnywhere, BlueprintReadOnly, Category = "Telemetry",
              meta = (ClampMin = "1.0", ClampMax = "120.0"))
    float TelemetryFlushIntervalSeconds = 10.0f;

    // ── Feature Flags ────────────────────────────────────────────────────────

    UPROPERTY(Config, EditAnywhere, BlueprintReadOnly, Category = "Features")
    bool bEnableTelemetry = true;

    UPROPERTY(Config, EditAnywhere, BlueprintReadOnly, Category = "Features")
    bool bEnableAIInference = true;

    UPROPERTY(Config, EditAnywhere, BlueprintReadOnly, Category = "Features")
    bool bEnableReplay = true;

    UPROPERTY(Config, EditAnywhere, BlueprintReadOnly, Category = "Features")
    bool bEnableMemory = true;

    /** Returns the singleton config instance. */
    static const UAIArenaConfig* Get();
};
