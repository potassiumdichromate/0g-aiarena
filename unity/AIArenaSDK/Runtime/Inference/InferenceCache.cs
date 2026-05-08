using System.Collections.Generic;
using UnityEngine;
using AIArena.SDK.Agents;

namespace AIArena.SDK.Inference
{
    /// <summary>
    /// Local in-memory cache for inference results. TTL: 50ms (one frame at 20Hz).
    /// Prevents duplicate API calls for identical game states within the same tick.
    /// </summary>
    public class InferenceCache : MonoBehaviour
    {
        private struct CacheEntry
        {
            public AgentAction Action;
            public float Timestamp;
        }

        private readonly Dictionary<string, CacheEntry> _cache = new Dictionary<string, CacheEntry>();
        private const float CacheTtlMs = 0.05f; // 50ms

        public AgentAction Get(string agentId, string stateHash)
        {
            var key = $"{agentId}:{stateHash}";
            if (!_cache.TryGetValue(key, out var entry)) return null;

            if (Time.time - entry.Timestamp > CacheTtlMs)
            {
                _cache.Remove(key);
                return null;
            }

            return entry.Action;
        }

        public void Store(string agentId, string stateHash, AgentAction action)
        {
            var key = $"{agentId}:{stateHash}";
            _cache[key] = new CacheEntry { Action = action, Timestamp = Time.time };

            // Evict old entries periodically
            if (_cache.Count > 100) CleanupOldEntries();
        }

        private void CleanupOldEntries()
        {
            var toRemove = new List<string>();
            foreach (var kvp in _cache)
            {
                if (Time.time - kvp.Value.Timestamp > CacheTtlMs * 10)
                    toRemove.Add(kvp.Key);
            }
            foreach (var k in toRemove) _cache.Remove(k);
        }
    }
}
