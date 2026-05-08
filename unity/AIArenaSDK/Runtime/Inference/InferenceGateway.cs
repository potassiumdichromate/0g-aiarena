using System;
using System.Threading.Tasks;
using UnityEngine;
using AIArena.SDK.Core;
using AIArena.SDK.Agents;

namespace AIArena.SDK.Inference
{
    /// <summary>
    /// HTTP client for the AI Arena inference-service.
    /// </summary>
    public class InferenceGateway : MonoBehaviour
    {
        /// <summary>Request a combat action from the inference API.</summary>
        public async Task<InferenceResult> GetCombatAction(string agentId, GameState gameState, string memoryContext = null)
        {
            var body = new
            {
                agentId,
                observationState = new
                {
                    position = new { x = gameState.Position.x, y = gameState.Position.y, z = gameState.Position.z },
                    health = gameState.Health / gameState.MaxHealth,
                    timeRemaining = gameState.TimeRemaining,
                    nearbyEnemies = gameState.NearbyEnemies?.Length ?? 0,
                },
                availableActions = gameState.AvailableActions,
                memoryContext,
            };

            var response = await ApiClient.Post<InferenceResponse>("/combat-action", body, AIArenaSDK.Instance.Config);
            return new InferenceResult
            {
                ActionType = response?.Action?.ActionType ?? "IDLE",
                Confidence = response?.Action?.Confidence ?? 0f,
                Source = response?.Action?.Source ?? "AI",
            };
        }
    }

    [Serializable]
    public class InferenceResponse
    {
        public InferenceActionData Action;
    }

    [Serializable]
    public class InferenceActionData
    {
        public string ActionType;
        public float Confidence;
        public string Source;
    }

    [Serializable]
    public class InferenceResult
    {
        public string ActionType;
        public float Confidence;
        public string Source;
    }
}
