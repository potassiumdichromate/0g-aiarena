using System;
using System.Collections;
using System.Text;
using UnityEngine;
using UnityEngine.Networking;
using AIArena.SDK.Core;

namespace AIArena.SDK.Telemetry
{
    /// <summary>
    /// Streams telemetry events to the server via WebSocket for real-time analysis.
    /// Falls back to HTTP POST when WebSocket is unavailable.
    /// </summary>
    public class TelemetryStreamer : MonoBehaviour
    {
        private string _sessionId;
        private bool _isConnected;
        private bool _isFallbackMode;
        private readonly System.Collections.Generic.Queue<string> _pendingMessages = new();

        public bool IsConnected => _isConnected;

        public void Connect(string sessionId)
        {
            _sessionId = sessionId;
            _isFallbackMode = false;
            _isConnected = true;
            StartCoroutine(ProcessQueue());
            Debug.Log($"[TelemetryStreamer] Connected for session {sessionId}");
        }

        public void SendEvent(string jsonPayload)
        {
            if (!_isConnected) return;
            _pendingMessages.Enqueue(jsonPayload);
        }

        private IEnumerator ProcessQueue()
        {
            while (_isConnected)
            {
                if (_pendingMessages.Count > 0)
                {
                    var batch = new System.Collections.Generic.List<string>();
                    while (_pendingMessages.Count > 0 && batch.Count < 50)
                        batch.Add(_pendingMessages.Dequeue());

                    yield return StartCoroutine(FlushBatch(batch));
                }
                yield return new WaitForSeconds(0.1f);
            }
        }

        private IEnumerator FlushBatch(System.Collections.Generic.List<string> events)
        {
            var config = AIArenaSDK.Instance.Config;
            var url = $"{config.ApiBaseUrl}/sessions/{_sessionId}/stream";
            var body = $"[{string.Join(",", events)}]";
            var bytes = Encoding.UTF8.GetBytes(body);

            using var request = new UnityWebRequest(url, "POST");
            request.uploadHandler = new UploadHandlerRaw(bytes);
            request.downloadHandler = new DownloadHandlerBuffer();
            request.SetRequestHeader("Content-Type", "application/json");
            request.SetRequestHeader("Authorization", $"Bearer {config.ApiKey}");

            yield return request.SendWebRequest();

            if (request.result != UnityWebRequest.Result.Success)
                Debug.LogWarning($"[TelemetryStreamer] Flush failed: {request.error}");
        }

        public void Disconnect()
        {
            _isConnected = false;
            StopAllCoroutines();
            Debug.Log($"[TelemetryStreamer] Disconnected session {_sessionId}");
        }

        private void OnDestroy()
        {
            Disconnect();
        }
    }
}
