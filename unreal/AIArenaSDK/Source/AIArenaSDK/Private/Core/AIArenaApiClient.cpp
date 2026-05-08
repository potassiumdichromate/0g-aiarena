#include "Core/AIArenaApiClient.h"
#include "Core/AIArenaConfig.h"
#include "HttpModule.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

static const FString ContentTypeJson = TEXT("application/json");

TSharedRef<IHttpRequest, ESPMode::ThreadSafe>
FAIArenaApiClient::MakeRequest(const FString& Verb, const FString& Path)
{
    const UAIArenaConfig* Cfg = UAIArenaConfig::Get();
    FString Url = Cfg->ApiBaseUrl / TEXT("v1") + Path;

    TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Req =
        FHttpModule::Get().CreateRequest();

    Req->SetVerb(Verb);
    Req->SetURL(Url);
    Req->SetHeader(TEXT("Content-Type"), ContentTypeJson);
    Req->SetHeader(TEXT("Accept"),       ContentTypeJson);

    if (!Cfg->ApiKey.IsEmpty())
    {
        Req->SetHeader(TEXT("Authorization"),
                       FString::Printf(TEXT("Bearer %s"), *Cfg->ApiKey));
    }
    if (!Cfg->GameId.IsEmpty())
    {
        Req->SetHeader(TEXT("X-Game-Id"), Cfg->GameId);
    }

    Req->SetTimeout(Cfg->RequestTimeoutSeconds);
    return Req;
}

void FAIArenaApiClient::Get(const FString& Path, FOnApiResponse OnDone)
{
    auto Req = MakeRequest(TEXT("GET"), Path);
    Req->OnProcessRequestComplete().BindStatic(
        &FAIArenaApiClient::HandleResponse, OnDone);
    Req->ProcessRequest();
}

void FAIArenaApiClient::Post(const FString& Path,
                              TSharedPtr<FJsonObject> Body,
                              FOnApiResponse OnDone)
{
    FString JsonStr;
    TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&JsonStr);
    FJsonSerializer::Serialize(Body.ToSharedRef(), Writer);
    PostRaw(Path, JsonStr, OnDone);
}

void FAIArenaApiClient::PostRaw(const FString& Path,
                                 const FString& JsonString,
                                 FOnApiResponse OnDone)
{
    auto Req = MakeRequest(TEXT("POST"), Path);
    Req->SetContentAsString(JsonString);
    Req->OnProcessRequestComplete().BindStatic(
        &FAIArenaApiClient::HandleResponse, OnDone);
    Req->ProcessRequest();
}

void FAIArenaApiClient::HandleResponse(FHttpRequestPtr /*Request*/,
                                        FHttpResponsePtr  Response,
                                        bool bConnected,
                                        FOnApiResponse OnDone)
{
    if (!bConnected || !Response.IsValid())
    {
        UE_LOG(LogTemp, Warning, TEXT("[AIArenaApiClient] Request failed — no response."));
        OnDone.ExecuteIfBound(false, nullptr);
        return;
    }

    const int32 Code = Response->GetResponseCode();
    const FString Body = Response->GetContentAsString();

    TSharedPtr<FJsonObject> JsonObj;
    TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Body);

    bool bParsed = FJsonSerializer::Deserialize(Reader, JsonObj);
    bool bOK     = Code >= 200 && Code < 300;

    if (!bOK)
    {
        UE_LOG(LogTemp, Warning,
               TEXT("[AIArenaApiClient] HTTP %d — %s"), Code, *Body);
    }

    OnDone.ExecuteIfBound(bOK, bParsed ? JsonObj : nullptr);
}
