#pragma once

#include "CoreMinimal.h"
#include "Modules/ModuleManager.h"

/** AI Arena SDK module — loaded automatically via .uplugin. */
class FAIArenaSDKModule : public IModuleInterface
{
public:
    virtual void StartupModule() override;
    virtual void ShutdownModule() override;
};
