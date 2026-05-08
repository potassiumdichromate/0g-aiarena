#pragma once

#include "CoreMinimal.h"
#include "Http.h"
#include "Dom/JsonObject.h"

/** Callback signatures used across all HTTP helpers. */
DECLARE_DELEGATE_TwoParams(FOnApiResponse, bool /*bSuccess*/, TSharedPtr<FJsonObject> /*Body*/);
DECLARE_DELEGATE_TwoParams(FOnApiArrayResponse, bool /*bSuccess*/, TArray<TSharedPtr<FJsonValue>> /*Items*/);

/**
 * Thin HTTP wrapper for AI Arena REST API calls.
 * All requests attach the configured API key and game ID automatically.
 * Thread-safe: callbacks are always invoked on the game thread.
 */
class AIARENASDK_API FAIArenaApiClient
{
public:
    /**
     * Send a GET request to {BaseUrl}{Path}.
     * @param Path    e.g. "/agents/abc123"
     * @param OnDone  Called on game thread with (bSuccess, JsonBody)
     */
    static void Get(const FString& Path, FOnApiResponse OnDone);

    /**
     * Send a POST request with a JSON body to {BaseUrl}{Path}.
     * @param Path    e.g. "/battles"
     * @param Body    JSON object to serialise as request body
     * @param OnDone  Called on game thread with (bSuccess, JsonBody)
     */
    static void Post(const FString& Path,
                     TSharedPtr<FJsonObject> Body,
                     FOnApiResponse OnDone);

    /** Convenience: POST with a pre-serialised JSON string. */
    static void PostRaw(const FString& Path,
                        const FString& JsonString,
                        FOnApiResponse OnDone);

private:
    static TSharedRef<IHttpRequest, ESPMode::ThreadSafe> MakeRequest(
        const FString& Verb, const FString& Path);
    static void HandleResponse(FHttpRequestPtr Request,
                                FHttpResponsePtr Response,
                                bool bConnected,
                                FOnApiResponse OnDone);
};
