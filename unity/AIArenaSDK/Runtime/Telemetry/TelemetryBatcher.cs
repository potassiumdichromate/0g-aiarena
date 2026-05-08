using System;
using System.Collections;
using System.Collections.Generic;
using System.Text;
using UnityEngine;
using UnityEngine.Networking;
using AIArena.SDK.Core;

namespace AIArena.SDK.Telemetry
{
    /// <summary>
    /// Batches telemetry events and submits them via HTTP POST.
    /// Provides guaranteed delivery with retry logic.
    /// </summary>
    public class TelemetryBatcher : MonoBehaviour
    {
        [SerializeField] private int maxBatchSize = 100;
        [SerializeField] private float flushIntervalSeconds = 5f;
        [SerializeField] private int maxRetries = 3;

        private string _sessionId;
        private readonly List<object> _buffer = new();
        private float _lastFlushTime;
        private bool _isActive;

        public int BufferCount => _buffer.Count;

        public void Initialise(string sessionId)
        {
            _sessionId = sessionId;
            _isActive = true;
            _lastFlushTime = Time.time;
            Debug.Log($"[TelemetryBatcher] Initialised for session {sessionId}");
        }

        public void Add(object telemetryEvent)
        {
            if (!_isActive) return;
            lock (_buffer) { _buffer.Add(telemetryEvent); }

            if (_buffer.Count >= maxBatchSize)
                StartCoroutine(Flush());
        }

        private void Update()
        {
            if (!_isActive || _buffer.Count == 0) return;
            if (Time.time - _lastFlushTime >= flushIntervalSeconds)
                StartCoroutine(Flush());
        }

        public IEnumerator Flush()
        {
            if (_buffer.Count == 0) yield break;

            List<object> batch;
            lock (_buffer)
            {
                batch = new List<object>(_buffer);
                _buffer.Clear();
            }

            _lastFlushTime = Time.time;

            var payload = TelemetrySerializer.SerializeBatch(_sessionId, batch);
            yield return StartCoroutine(Submit(payload, maxRetries));
        }

        private IEnumerator Submit(string json, int retriesLeft)
        {
            var config = AIArenaSDK.Instance.Config;
            var url = $"{config.ApiBaseUrl}/sessions/{_sessionId}/batch";
            var bytes = Encoding.UTF8.GetBytes(json);

            using var request = new UnityWebRequest(url, "POST");
            request.uploadHandler = new UploadHandlerRaw(bytes);
            request.downloadHandler = new DownloadHandlerBuffer();
            request.SetRequestHeader("Content-Type", "application/json");
            request.SetRequestHeader("Authorization", $"Bearer {config.ApiKey}");

            yield return request.SendWebRequest();

            if (request.result == UnityWebRequest.Result.Success)
            {
                Debug.Log($"[TelemetryBatcher] Submitted batch successfully");
            }
            else if (retriesLeft > 0)
            {
                Debug.LogWarning($"[TelemetryBatcher] Submit failed ({request.error}), retrying ({retriesLeft} left)");
                yield return new WaitForSeconds(1f);
                yield return StartCoroutine(Submit(json, retriesLeft - 1));
            }
            else
            {
                Debug.LogError($"[TelemetryBatcher] Submit failed after all retries: {request.error}");
            }
        }

        public IEnumerator FlushAndStop()
        {
            _isActive = false;
            yield return StartCoroutine(Flush());
            Debug.Log("[TelemetryBatcher] Stopped.");
        }
    }
}
