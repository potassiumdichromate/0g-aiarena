using System.Threading.Tasks;
using UnityEngine;
using AIArena.SDK.Core;

namespace AIArena.SDK.Core
{
    /// <summary>
    /// Manages game session lifecycle: start, end, and session tracking.
    /// </summary>
    public class SessionManager : MonoBehaviour
    {
        public string CurrentSessionId { get; private set; }
        public bool IsSessionActive { get; private set; }

        /// <summary>Start a telemetry and inference session for an agent.</summary>
        public async Task<string> StartSession(string agentId, string gameId)
        {
            Debug.Log($"[SessionManager] Starting session for agent {agentId}");

            var body = new { agentId, gameId };
            var response = await ApiClient.Post<SessionResponse>(
                "/sessions/start",
                body,
                AIArenaSDK.Instance.Config
            );

            CurrentSessionId = response.SessionId;
            IsSessionActive = true;
            Debug.Log($"[SessionManager] Session started: {CurrentSessionId}");
            return CurrentSessionId;
        }

        /// <summary>End the active session and flush telemetry.</summary>
        public async Task EndSession(string sessionId)
        {
            if (!IsSessionActive) return;

            await ApiClient.Post<object>($"/sessions/{sessionId}/end", null, AIArenaSDK.Instance.Config);
            IsSessionActive = false;
            CurrentSessionId = null;
            Debug.Log($"[SessionManager] Session ended: {sessionId}");
        }

        private void OnApplicationPause(bool pauseStatus)
        {
            if (pauseStatus && IsSessionActive)
            {
                Debug.Log("[SessionManager] App paused, flushing telemetry...");
            }
        }
    }

    [System.Serializable]
    public class SessionResponse
    {
        public string SessionId;
        public string AgentId;
        public string GameId;
    }
}
