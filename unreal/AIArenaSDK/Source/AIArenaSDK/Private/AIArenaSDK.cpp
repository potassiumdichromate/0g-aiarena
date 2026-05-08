#include "AIArenaSDK.h"
#include "Modules/ModuleManager.h"

#define LOCTEXT_NAMESPACE "FAIArenaSDKModule"

void FAIArenaSDKModule::StartupModule()
{
    UE_LOG(LogTemp, Log, TEXT("[AIArenaSDK] Module loaded."));
}

void FAIArenaSDKModule::ShutdownModule()
{
    UE_LOG(LogTemp, Log, TEXT("[AIArenaSDK] Module unloaded."));
}

#undef LOCTEXT_NAMESPACE

IMPLEMENT_MODULE(FAIArenaSDKModule, AIArenaSDK)
