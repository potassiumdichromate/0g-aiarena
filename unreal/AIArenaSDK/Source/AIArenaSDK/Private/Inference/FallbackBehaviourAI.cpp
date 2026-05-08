#include "Inference/FallbackBehaviourAI.h"

void UAIArenaFallbackBehaviourAI::Configure(const FAIArenaAgentTraits& Traits)
{
    CachedTraits = Traits;
}

FAIArenaAgentAction UAIArenaFallbackBehaviourAI::GetAction(
    const FAIArenaGameState& GameState) const
{
    FAIArenaAgentAction Action;
    Action.Source     = TEXT("FALLBACK");
    Action.Confidence = 0.2f;

    const float HealthPct = GameState.MaxHealth > 0.f
                              ? GameState.Health / GameState.MaxHealth
                              : 1.f;

    // ── Trait-weighted decision tree (mirrors server-side heuristic) ──────────
    if (HealthPct < 0.25f)
    {
        // Critical health — flee regardless of aggression
        Action.ActionType = TEXT("FLEE");
    }
    else if (CachedTraits.Aggression > 0.6f &&
             !GameState.NearbyEnemies.IsEmpty())
    {
        // High aggression + enemies in range → attack nearest
        Action.ActionType    = TEXT("ATTACK");
        Action.TargetId      = GameState.NearbyEnemies[0].Id;
        Action.TargetPosition = GameState.NearbyEnemies[0].Position;
        Action.Confidence    = CachedTraits.Aggression * 0.4f; // still low — it's a fallback
    }
    else if (CachedTraits.RiskTolerance < 0.4f)
    {
        Action.ActionType = TEXT("DEFEND");
    }
    else
    {
        Action.ActionType = TEXT("IDLE");
    }

    return Action;
}
