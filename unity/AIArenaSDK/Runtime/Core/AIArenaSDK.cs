using System;
using System.Threading.Tasks;
using UnityEngine;
using AIArena.SDK.Agents;
using AIArena.SDK.Telemetry;

namespace AIArena.SDK.Core
{
    /// <summary>
    /// Main entry point for the AI Arena SDK. Singleton that manages SDK lifecycle.
    /// Call AIArenaSDK.Instance.Initialize() from your GameManager.Start().
    /// </summary>
    public class AIArenaSDK : MonoBehaviour
    {
        private static AIArenaSDK _instance;

        /// <summary>Singleton instance of the SDK.</summary>
        public static AIArenaSDK Instance
        {
            get
            {
                if (_instance == null)
                {
                    var go = new GameObject("[AIArenaSDK]");
                    _instance = go.AddComponent<AIArenaSDK>();
                    DontDestroyOnLoad(go);
                }
                return _instance;
            }
        }

        public AIArenaConfig Config { get; private set; }
        public bool IsInitialized { get; private set; }
        public string SessionToken { get; private set; }

        private ConnectionManager _connectionManager;
        private SessionManager _sessionManager;

        private void Awake()
        {
            if (_instance != null && _instance != this)
            {
                Destroy(gameObject);
                return;
            }
            _instance = this;
            DontDestroyOnLoad(gameObject);
        }

        /// <summary>
        /// Initialize the AI Arena SDK with configuration.
        /// </summary>
        /// <param name="config">SDK configuration ScriptableObject</param>
        public async Task Initialize(AIArenaConfig config)
        {
            if (IsInitialized)
            {
                Debug.LogWarning("[AIArenaSDK] Already initialized.");
                return;
            }

            Config = config ?? throw new ArgumentNullException(nameof(config));
            Debug.Log($"[AIArenaSDK] Initializing... API: {config.ApiBaseUrl}");

            _connectionManager = gameObject.AddComponent<ConnectionManager>();
            await _connectionManager.Connect(config.WebSocketUrl);

            _sessionManager = gameObject.AddComponent<SessionManager>();

            if (config.EnableTelemetry)
            {
                TelemetryCollector.Instance.Configure(config);
            }

            IsInitialized = true;
            Debug.Log("[AIArenaSDK] Initialization complete.");
        }

        /// <summary>
        /// Get the full profile for an agent.
        /// </summary>
        public async Task<AgentProfile> GetAgentProfile(string agentId)
        {
            EnsureInitialized();
            var response = await ApiClient.Get<AgentProfile>($"/agents/{agentId}", Config);
            return response;
        }

        /// <summary>
        /// Start a game session for an agent.
        /// </summary>
        public async Task<string> StartSession(string agentId, string gameId = null)
        {
            EnsureInitialized();
            var sessionId = await _sessionManager.StartSession(agentId, gameId ?? Config.GameId);
            return sessionId;
        }

        /// <summary>
        /// End the current game session.
        /// </summary>
        public async Task EndSession(string sessionId)
        {
            EnsureInitialized();
            await _sessionManager.EndSession(sessionId);

            if (Config.EnableTelemetry)
            {
                await TelemetryCollector.Instance.FlushAll();
            }
        }

        private void EnsureInitialized()
        {
            if (!IsInitialized)
                throw new InvalidOperationException("AIArenaSDK not initialized. Call Initialize() first.");
        }

        private void OnDestroy()
        {
            _connectionManager?.Disconnect();
        }
    }

    /// <summary>Agent profile data returned from the API.</summary>
    [Serializable]
    public class AgentProfile
    {
        public string Id;
        public string Name;
        public string Clan;
        public string Archetype;
        public string EvolutionStage;
        public int EloRating;
        public int Wins;
        public int Losses;
        public AgentTraitData Traits;
    }

    [Serializable]
    public class AgentTraitData
    {
        public float Aggression;
        public float Patience;
        public float Adaptability;
        public float RiskTolerance;
        public float Teamwork;
        public float Creativity;
        public float Endurance;
        public float Precision;
    }
}
