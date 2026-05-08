using System;
using System.Threading;
using System.Threading.Tasks;
using UnityEngine;
using AIArena.SDK.Agents;
using AIArena.SDK.Core;

namespace AIArena.SDK.Inference
{
    /// <summary>
    /// Predicts combat actions using the inference API with timeout enforcement.
    /// </summary>
    public class ActionPredictor : MonoBehaviour
    {
        private InferenceGateway _gateway;
        private InferenceCache _cache;

        private void Awake()
        {
            _gateway = GetComponent<InferenceGateway>() ?? gameObject.AddComponent<InferenceGateway>();
            _cache = GetComponent<InferenceCache>() ?? gameObject.AddComponent<InferenceCache>();
        }

        /// <summary>Predict the next action with timeout. Falls back to cached if timeout exceeded.</summary>
        public async Task<AgentAction> PredictAction(string agentId, GameState gameState)
        {
            var stateHash = ComputeStateHash(gameState);

            // Check local cache first
            var cached = _cache.Get(agentId, stateHash);
            if (cached != null) return cached;

            // Request with timeout
            var config = AIArenaSDK.Instance.Config;
            var timeoutMs = config.InferenceTimeoutMs;

            using var cts = new CancellationTokenSource(timeoutMs);
            try
            {
                var result = await _gateway.GetCombatAction(agentId, gameState).WaitAsync(cts.Token);
                var action = new AgentAction
                {
                    ActionType = result.ActionType,
                    Confidence = result.Confidence,
                    Source = result.Source,
                };

                _cache.Store(agentId, stateHash, action);
                return action;
            }
            catch (OperationCanceledException)
            {
                Debug.LogWarning($"[ActionPredictor] Inference timeout ({timeoutMs}ms) for agent {agentId}");
                throw;
            }
        }

        private string ComputeStateHash(GameState state)
        {
            // Simple hash based on key state values
            return $"{state.AgentId}_{(int)state.Health}_{state.AvailableActions?.Length}_{Time.frameCount / 10}";
        }
    }
}
