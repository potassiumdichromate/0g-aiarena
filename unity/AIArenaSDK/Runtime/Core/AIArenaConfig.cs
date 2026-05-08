using UnityEngine;

namespace AIArena.SDK.Core
{
    /// <summary>
    /// ScriptableObject configuration for the AI Arena SDK.
    /// Create via Assets > Create > AI Arena > Config
    /// </summary>
    [CreateAssetMenu(fileName = "AIArenaConfig", menuName = "AI Arena/Config")]
    public class AIArenaConfig : ScriptableObject
    {
        [Header("API Configuration")]
        [Tooltip("Base URL for the AI Arena REST API")]
        public string ApiBaseUrl = "https://api.aiarena.gg";

        [Tooltip("WebSocket URL for real-time events")]
        public string WebSocketUrl = "wss://api.aiarena.gg";

        [Header("Authentication")]
        [Tooltip("Game API key issued by AI Arena")]
        public string GameId;

        [Tooltip("Game API key for server-to-server auth")]
        [TextArea(1, 2)]
        public string ApiKey;

        [Header("Timeouts")]
        [Tooltip("HTTP request timeout in seconds")]
        public float RequestTimeoutSeconds = 5f;

        [Tooltip("Inference request timeout in milliseconds (hard fallback to heuristic AI)")]
        public int InferenceTimeoutMs = 50;

        [Tooltip("WebSocket reconnect delay in seconds")]
        public float ReconnectDelaySeconds = 2f;

        [Header("Telemetry")]
        [Tooltip("Max events per telemetry batch before auto-flush")]
        public int TelemetryBatchSize = 100;

        [Tooltip("Auto-flush telemetry every N seconds")]
        public float TelemetryFlushIntervalSeconds = 10f;

        [Header("Feature Flags")]
        public bool EnableTelemetry = true;
        public bool EnableAIInference = true;
        public bool EnableReplay = true;
        public bool EnableMemory = true;
    }
}
