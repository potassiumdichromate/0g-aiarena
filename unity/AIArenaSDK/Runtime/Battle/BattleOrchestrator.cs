using System;
using System.Threading.Tasks;
using UnityEngine;
using AIArena.SDK.Core;
using AIArena.SDK.Agents;

namespace AIArena.SDK.Battle
{
    /// <summary>
    /// Manages the battle room lifecycle from the Unity client side.
    /// Handles battle creation, state synchronisation, and replay recording.
    /// </summary>
    public class BattleOrchestrator : MonoBehaviour
    {
        public string CurrentBattleId { get; private set; }
        public BattleStatus Status { get; private set; } = BattleStatus.Idle;

        private BattleStateSync _stateSync;
        private ReplayRecorder _replayRecorder;

        private void Awake()
        {
            _stateSync = gameObject.AddComponent<BattleStateSync>();
            _replayRecorder = gameObject.AddComponent<ReplayRecorder>();
        }

        /// <summary>Create a new battle and join the room.</summary>
        public async Task<string> CreateBattle(string agentId, string opponentId, string mode, string gameId)
        {
            Status = BattleStatus.Creating;

            var body = new { agentId, opponentId, mode, gameId };
            var response = await ApiClient.Post<BattleCreateResponse>("/battles", body, AIArenaSDK.Instance.Config);

            CurrentBattleId = response.Battle.Id;
            Status = BattleStatus.WaitingForOpponent;

            _stateSync.StartListening(CurrentBattleId);
            _replayRecorder.StartRecording(CurrentBattleId);

            Debug.Log($"[BattleOrchestrator] Battle created: {CurrentBattleId}");
            return CurrentBattleId;
        }

        /// <summary>Notify the backend that the battle has completed.</summary>
        public async Task EndBattle(BattleResult result)
        {
            if (CurrentBattleId == null) return;

            _replayRecorder.StopRecording();
            Status = BattleStatus.Completed;

            Debug.Log($"[BattleOrchestrator] Battle {CurrentBattleId} ended. Winner: {result.WinnerId}");
        }

        public void OnBattleStateReceived(BattleState state)
        {
            if (state.Status == "IN_PROGRESS") Status = BattleStatus.InProgress;
            else if (state.Status == "COMPLETED") Status = BattleStatus.Completed;
        }
    }

    public enum BattleStatus { Idle, Creating, WaitingForOpponent, InProgress, Completed }

    [Serializable]
    public class BattleCreateResponse
    {
        public BattleData Battle;
    }

    [Serializable]
    public class BattleData
    {
        public string Id;
        public string Status;
        public string[] AgentIds;
    }

    [Serializable]
    public class BattleState
    {
        public string BattleId;
        public string Status;
        public string[] AgentIds;
        public float[] HealthValues;
        public int Round;
    }

    [Serializable]
    public class BattleResult
    {
        public string WinnerId;
        public string LoserId;
        public int RoundsPlayed;
    }
}
