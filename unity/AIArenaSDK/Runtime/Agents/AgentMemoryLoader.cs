using System;
using System.Threading.Tasks;
using UnityEngine;
using AIArena.SDK.Core;

namespace AIArena.SDK.Agents
{
    /// <summary>
    /// Loads relevant agent memories from the backend for context injection into inference.
    /// </summary>
    public class AgentMemoryLoader : MonoBehaviour
    {
        /// <summary>Load memories relevant to the current battle context.</summary>
        public async Task<MemorySummary> LoadRelevantMemories(string agentId, string opponentId)
        {
            try
            {
                var query = $"battles against {opponentId}";
                var url = $"/agents/{agentId}/memory/retrieve?query={Uri.EscapeDataString(query)}&limit=5";
                return await ApiClient.Get<MemorySummary>(url, AIArenaSDK.Instance.Config);
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[AgentMemoryLoader] Failed to load memories: {ex.Message}");
                return new MemorySummary { MemoryContext = "" };
            }
        }
    }

    [Serializable]
    public class MemorySummary
    {
        public string MemoryContext;
        public MemoryItem[] Memories;
    }

    [Serializable]
    public class MemoryItem
    {
        public string Id;
        public string Type;
        public string Content;
        public float Importance;
        public float Score;
    }
}
