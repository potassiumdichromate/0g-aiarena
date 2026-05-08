using System;
using System.Threading.Tasks;
using UnityEngine;
using AIArena.SDK.Core;
using AIArena.SDK.Inference;

namespace AIArena.SDK.Agents
{
    /// <summary>
    /// Core AI controller component. Attach this to any GameObject that represents an AI agent.
    /// Handles inference requests, memory loading, and fallback to heuristic AI.
    /// </summary>
    public class AgentBrain : MonoBehaviour
    {
        public string AgentId { get; private set; }
        public bool IsReady { get; private set; }
        public AgentBehaviourState BehaviourState { get; private set; }

        private InferenceGateway _inferenceGateway;
        private ActionPredictor _actionPredictor;
        private FallbackBehaviourAI _fallback;
        private AgentProfileLoader _profileLoader;
        private float _lastActionTime;

        /// <summary>Initialise the brain for a specific agent.</summary>
        public async Task Initialize(string agentId)
        {
            AgentId = agentId;

            _inferenceGateway = gameObject.AddComponent<InferenceGateway>();
            _actionPredictor = gameObject.AddComponent<ActionPredictor>();
            _fallback = gameObject.AddComponent<FallbackBehaviourAI>();
            _profileLoader = gameObject.AddComponent<AgentProfileLoader>();

            // Load agent profile and configure behaviour state
            var profile = await _profileLoader.LoadProfile(agentId);
            BehaviourState = ScriptableObject.CreateInstance<AgentBehaviourState>();
            BehaviourState.ApplyProfile(profile);

            _fallback.Configure(BehaviourState);
            IsReady = true;

            Debug.Log($"[AgentBrain] Initialized for agent {agentId} (ELO: {profile?.EloRating})");
        }

        /// <summary>
        /// Get the next action for the agent given the current game state.
        /// Will return a cached action, fresh inference, or heuristic fallback.
        /// </summary>
        public async Task<AgentAction> GetNextAction(GameState gameState)
        {
            if (!IsReady)
            {
                Debug.LogWarning("[AgentBrain] Not ready yet, using fallback.");
                return _fallback.GetAction(gameState);
            }

            try
            {
                var action = await _actionPredictor.PredictAction(AgentId, gameState);
                _lastActionTime = Time.time;
                return action;
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[AgentBrain] Inference failed ({ex.Message}), using fallback.");
                return _fallback.GetAction(gameState);
            }
        }

        /// <summary>Record the outcome of an action for memory storage.</summary>
        public void RecordActionOutcome(AgentAction action, ActionOutcome outcome)
        {
            // Store for telemetry and memory systems
            _ = StoreActionMemory(action, outcome);
        }

        private async Task StoreActionMemory(AgentAction action, ActionOutcome outcome)
        {
            try
            {
                var body = new {
                    agentId = AgentId,
                    actionType = action.ActionType,
                    success = outcome.Success,
                    importance = outcome.Importance,
                };
                await ApiClient.Post<object>($"/agents/{AgentId}/memory/working", body, AIArenaSDK.Instance.Config);
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[AgentBrain] Failed to store action memory: {ex.Message}");
            }
        }
    }

    [Serializable]
    public class AgentAction
    {
        public string ActionType;
        public string TargetId;
        public Vector3 Position;
        public float Confidence;
        public string Source; // AI, CACHED, FALLBACK
    }

    [Serializable]
    public class GameState
    {
        public string AgentId;
        public Vector3 Position;
        public float Health;
        public float MaxHealth;
        public string[] AvailableActions;
        public EnemyInfo[] NearbyEnemies;
        public float TimeRemaining;
    }

    [Serializable]
    public class EnemyInfo
    {
        public string Id;
        public Vector3 Position;
        public float Health;
        public float Distance;
    }

    [Serializable]
    public class ActionOutcome
    {
        public bool Success;
        public float DamageDealt;
        public float Importance;
    }
}
