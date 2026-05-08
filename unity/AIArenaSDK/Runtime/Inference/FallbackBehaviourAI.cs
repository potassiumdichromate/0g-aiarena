using UnityEngine;
using AIArena.SDK.Agents;

namespace AIArena.SDK.Inference
{
    /// <summary>
    /// Heuristic fallback AI. Used when the inference API times out or is unavailable.
    /// Decision logic is driven by the agent's AgentBehaviourState trait weights.
    /// </summary>
    public class FallbackBehaviourAI : MonoBehaviour
    {
        private AgentBehaviourState _behaviourState;

        public void Configure(AgentBehaviourState state)
        {
            _behaviourState = state;
        }

        /// <summary>Select an action based on trait-weighted heuristics.</summary>
        public AgentAction GetAction(GameState gameState)
        {
            if (_behaviourState == null || gameState.AvailableActions == null || gameState.AvailableActions.Length == 0)
            {
                return new AgentAction { ActionType = "IDLE", Confidence = 0.1f, Source = "FALLBACK" };
            }

            float healthPercent = gameState.Health / gameState.MaxHealth;
            string selectedAction;

            // If critically low health, consider fleeing
            if (healthPercent < _behaviourState.CautiousHealthThreshold)
            {
                float fleeProbability = _behaviourState.FleeWeight * (1f - healthPercent);
                if (Random.value < fleeProbability)
                {
                    selectedAction = FindAction(gameState.AvailableActions, "FLEE", "DODGE", "RETREAT");
                    if (selectedAction != null)
                        return MakeAction(selectedAction, 0.7f);
                }
            }

            // Otherwise use weighted random selection
            float roll = Random.value;
            float cumulative = 0f;

            cumulative += _behaviourState.AttackWeight;
            if (roll < cumulative)
            {
                selectedAction = FindAction(gameState.AvailableActions, "ATTACK", "ABILITY", "STRIKE");
                if (selectedAction != null) return MakeAction(selectedAction, 0.6f);
            }

            cumulative += _behaviourState.DefendWeight;
            if (roll < cumulative)
            {
                selectedAction = FindAction(gameState.AvailableActions, "DEFEND", "BLOCK", "SHIELD");
                if (selectedAction != null) return MakeAction(selectedAction, 0.6f);
            }

            cumulative += _behaviourState.SupportWeight;
            if (roll < cumulative)
            {
                selectedAction = FindAction(gameState.AvailableActions, "HEAL", "BUFF", "SUPPORT");
                if (selectedAction != null) return MakeAction(selectedAction, 0.5f);
            }

            // Default: pick the first available action
            return MakeAction(gameState.AvailableActions[0], 0.3f);
        }

        private string FindAction(string[] available, params string[] keywords)
        {
            foreach (var action in available)
            {
                foreach (var kw in keywords)
                {
                    if (action.ToUpper().Contains(kw.ToUpper())) return action;
                }
            }
            return null;
        }

        private AgentAction MakeAction(string actionType, float confidence) =>
            new AgentAction { ActionType = actionType, Confidence = confidence, Source = "FALLBACK" };
    }
}
