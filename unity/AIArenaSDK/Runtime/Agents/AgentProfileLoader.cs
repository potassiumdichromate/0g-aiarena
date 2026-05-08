using System.Threading.Tasks;
using UnityEngine;
using AIArena.SDK.Core;

namespace AIArena.SDK.Agents
{
    /// <summary>
    /// Loads the full agent profile from the AI Arena backend at battle start.
    /// </summary>
    public class AgentProfileLoader : MonoBehaviour
    {
        private AgentProfile _cachedProfile;

        /// <summary>Load agent profile from the API. Returns cached version if available.</summary>
        public async Task<AgentProfile> LoadProfile(string agentId)
        {
            if (_cachedProfile != null && _cachedProfile.Id == agentId)
                return _cachedProfile;

            try
            {
                _cachedProfile = await ApiClient.Get<AgentProfile>($"/agents/{agentId}", AIArenaSDK.Instance.Config);
                Debug.Log($"[AgentProfileLoader] Loaded profile for {agentId}: {_cachedProfile.Name}");
                return _cachedProfile;
            }
            catch (System.Exception ex)
            {
                Debug.LogError($"[AgentProfileLoader] Failed to load profile for {agentId}: {ex.Message}");
                return null;
            }
        }

        public void InvalidateCache()
        {
            _cachedProfile = null;
        }
    }
}
