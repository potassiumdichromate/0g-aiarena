using System;
using UnityEngine;
using AIArena.SDK.Core;

namespace AIArena.SDK.Battle
{
    /// <summary>
    /// Listens for battle state updates via WebSocket and applies them to the local game world.
    /// </summary>
    public class BattleStateSync : MonoBehaviour
    {
        public event Action<BattleState> OnStateUpdated;

        private string _battleId;
        private bool _isListening;

        public void StartListening(string battleId)
        {
            _battleId = battleId;
            _isListening = true;

            var cm = AIArenaSDK.Instance.GetComponent<ConnectionManager>();
            if (cm != null)
            {
                cm.OnMessageReceived += HandleMessage;
            }

            Debug.Log($"[BattleStateSync] Listening for battle {battleId}");
        }

        private void HandleMessage(string message)
        {
            if (!_isListening) return;

            try
            {
                var state = JsonUtility.FromJson<BattleState>(message);
                if (state?.BattleId == _battleId)
                {
                    MainThreadDispatcher.Enqueue(() => OnStateUpdated?.Invoke(state));
                }
            }
            catch (Exception ex)
            {
                Debug.LogWarning($"[BattleStateSync] Failed to parse message: {ex.Message}");
            }
        }

        public void StopListening()
        {
            _isListening = false;
        }
    }
}
