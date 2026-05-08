// AI Arena SDK — Unreal Engine 5 Plugin
// Build rules: declares module dependencies for HTTP, WebSockets, and JSON.

using UnrealBuildTool;

public class AIArenaSDK : ModuleRules
{
    public AIArenaSDK(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

        PublicIncludePaths.AddRange(new string[]
        {
            "AIArenaSDK/Public",
        });

        PrivateIncludePaths.AddRange(new string[]
        {
            "AIArenaSDK/Private",
        });

        PublicDependencyModuleNames.AddRange(new string[]
        {
            "Core",
            "CoreUObject",
            "Engine",
            "HTTP",
            "WebSockets",
            "Json",
            "JsonUtilities",
            "DeveloperSettings",
        });

        PrivateDependencyModuleNames.AddRange(new string[]
        {
            "Slate",
            "SlateCore",
        });
    }
}
