using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using UnityEngine;
using AIArena.SDK.Core;

namespace AIArena.SDK.Telemetry
{
    /// <summary>
    /// Singleton telemetry collector. Records game events and batches them for submission.
    /// </summary>
    public class TelemetryCollector : MonoBehaviour
    {
        private static TelemetryCollector _instance;
        public static TelemetryCollector Instance
        {
            get
            {
                if (_instance == null)
                {
                    var go = new GameObject("[TelemetryCollector]");
                    _instance = go.AddComponent<TelemetryCollector>();
                    DontDestroyOnLoad(go);
                }
                return _instance;
            }
        }

        private AIArenaConfig _config;
        private readonly List<TelemetryEvent> _buffer = new List<TelemetryEvent>();
        private string _sessionId;
        private string _agentId;
        private int _sequenceNumber;
        private float _lastFlushTime;

        public void Configure(AIArenaConfig config)
        {
            _config = config;
            _lastFlushTime = Time.time;
        }

        public void StartSession(string sessionId, string agentId)
        {
            _sessionId = sessionId;
            _agentId = agentId;
            _sequenceNumber = 0;
            _buffer.Clear();
            Debug.Log($"[TelemetryCollector] Session started: {sessionId}");
        }

        /// <summary>Record a combat action event.</summary>
        public void RecordCombatAction(string actionType, string targetId, Vector3 position, bool success, float damageDealt, float latencyMs)
        {
            Enqueue("COMBAT_ACTION", new {
                actionType, targetId, position = ToDict(position),
                success, damageDealt, latencyMs,
            });
        }

        /// <summary>Record a position update event.</summary>
        public void RecordPositionUpdate(Vector3 position, Vector3 velocity, float rotation)
        {
            Enqueue("POSITION_UPDATE", new {
                position = ToDict(position),
                velocity = ToDict(velocity),
                rotation,
            });
        }

        /// <summary>Record an ability use event.</summary>
        public void RecordAbilityUse(string abilityId, string abilityName, string targetId, float cooldownMs)
        {
            Enqueue("ABILITY_USE", new { abilityId, abilityName, targetId, cooldownMs });
        }

        /// <summary>Record a health change event.</summary>
        public void RecordHealthChange(float previousHp, float currentHp, float maxHp, string changeReason, string sourceId = null)
        {
            Enqueue("HEALTH_CHANGE", new { previousHp, currentHp, maxHp, changeReason, sourceId });
        }

        /// <summary>Record a kill event.</summary>
        public void RecordKill(string victimId, string weaponUsed, Vector3 position, int killStreak)
        {
            Enqueue("KILL", new { victimId, weaponUsed, position = ToDict(position), killStreak });
        }

        private void Enqueue(string eventType, object payload)
        {
            if (!_config?.EnableTelemetry ?? false) return;

            var evt = new TelemetryEvent
            {
                EventId = Guid.NewGuid().ToString(),
                SessionId = _sessionId,
                AgentId = _agentId,
                EventType = eventType,
                Timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                SequenceNumber = _sequenceNumber++,
                Payload = payload,
            };

            _buffer.Add(evt);

            if (_buffer.Count >= _config.TelemetryBatchSize)
            {
                _ = Flush();
            }
        }

        private void Update()
        {
            if (_config != null && Time.time - _lastFlushTime >= _config.TelemetryFlushIntervalSeconds)
            {
                _ = Flush();
            }
        }

        public async Task Flush()
        {
            if (_buffer.Count == 0 || _sessionId == null) return;

            var batch = new List<TelemetryEvent>(_buffer);
            _buffer.Clear();
            _lastFlushTime = Time.time;

            try
            {
                var batchData = new TelemetryBatch
                {
                    BatchId = $"{_sessionId}-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}",
                    SessionId = _sessionId,
                    AgentId = _agentId,
                    Events = batch.ToArray(),
                    SubmittedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                };

                await ApiClient.Post<object>($"/sessions/{_sessionId}/batch", batchData, _config);
                Debug.Log($"[TelemetryCollector] Flushed {batch.Count} events.");
            }
            catch (Exception ex)
            {
                Debug.LogError($"[TelemetryCollector] Flush failed: {ex.Message}");
                // Re-queue failed events
                _buffer.InsertRange(0, batch);
            }
        }

        public async Task FlushAll()
        {
            await Flush();
        }

        private static object ToDict(Vector3 v) => new { x = v.x, y = v.y, z = v.z };
    }

    [Serializable]
    public class TelemetryEvent
    {
        public string EventId;
        public string SessionId;
        public string AgentId;
        public string EventType;
        public long Timestamp;
        public int SequenceNumber;
        public object Payload;
    }

    [Serializable]
    public class TelemetryBatch
    {
        public string BatchId;
        public string SessionId;
        public string AgentId;
        public TelemetryEvent[] Events;
        public long SubmittedAt;
    }
}
