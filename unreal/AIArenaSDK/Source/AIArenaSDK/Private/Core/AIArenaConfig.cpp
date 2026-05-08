#include "Core/AIArenaConfig.h"

UAIArenaConfig::UAIArenaConfig()
{
    CategoryName = TEXT("Plugins");
    SectionName  = TEXT("AI Arena SDK");
}

const UAIArenaConfig* UAIArenaConfig::Get()
{
    return GetDefault<UAIArenaConfig>();
}
