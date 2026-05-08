using System;
using System.Threading;
using System.Threading.Tasks;
using UnityEngine;

namespace AIArena.SDK.Core
{
    /// <summary>
    /// Manages WebSocket connection to the AI Arena backend with automatic reconnection.
    /// </summary>
    public class ConnectionManager : MonoBehaviour
    {
        private string _wsUrl;
        private CancellationTokenSource _cts;
        private bool _isConnected;
        private int _reconnectAttempt;
        private const int MaxReconnectAttempts = 10;

        public bool IsConnected => _isConnected;
        public event Action OnConnected;
        public event Action OnDisconnected;
        public event Action<string> OnMessageReceived;

        public async Task Connect(string wsUrl)
        {
            _wsUrl = wsUrl;
            _cts = new CancellationTokenSource();
            await AttemptConnect();
        }

        private async Task AttemptConnect()
        {
            try
            {
                Debug.Log($"[ConnectionManager] Connecting to {_wsUrl}");
                // In production: use NativeWebSocket or best-http WebSocket
                // For stub: simulate connection
                await Task.Delay(100);
                _isConnected = true;
                _reconnectAttempt = 0;
                OnConnected?.Invoke();
                Debug.Log("[ConnectionManager] Connected.");
            }
            catch (Exception ex)
            {
                Debug.LogError($"[ConnectionManager] Connection failed: {ex.Message}");
                await ScheduleReconnect();
            }
        }

        private async Task ScheduleReconnect()
        {
            if (_reconnectAttempt >= MaxReconnectAttempts)
            {
                Debug.LogError("[ConnectionManager] Max reconnect attempts reached.");
                return;
            }

            _reconnectAttempt++;
            float delay = AIArenaSDK.Instance.Config.ReconnectDelaySeconds * _reconnectAttempt;
            Debug.Log($"[ConnectionManager] Reconnecting in {delay:F1}s (attempt {_reconnectAttempt})...");
            await Task.Delay(TimeSpan.FromSeconds(delay));
            await AttemptConnect();
        }

        public void Disconnect()
        {
            _cts?.Cancel();
            _isConnected = false;
            OnDisconnected?.Invoke();
        }

        public void Send(string message)
        {
            if (!_isConnected)
            {
                Debug.LogWarning("[ConnectionManager] Not connected, cannot send message.");
                return;
            }
            // In production: send via WebSocket
            Debug.Log($"[ConnectionManager] Sending: {message.Substring(0, Math.Min(100, message.Length))}...");
        }
    }
}
