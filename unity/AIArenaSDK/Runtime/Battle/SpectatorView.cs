using System;
using UnityEngine;

namespace AIArena.SDK.Battle
{
    /// <summary>
    /// Spectator mode: receives and interpolates battle state for smooth playback.
    /// </summary>
    public class SpectatorView : MonoBehaviour
    {
        [SerializeField] private float interpolationSpeed = 10f;

        private BattleState _targetState;
        private BattleState _currentState;
        private bool _isSpectating;

        public event Action<BattleState> OnStateApplied;

        public void StartSpectating(string battleId)
        {
            _isSpectating = true;
            var sync = gameObject.AddComponent<BattleStateSync>();
            sync.StartListening(battleId);
            sync.OnStateUpdated += UpdateTargetState;
            Debug.Log($"[SpectatorView] Spectating battle {battleId}");
        }

        private void UpdateTargetState(BattleState state)
        {
            _targetState = state;
        }

        private void Update()
        {
            if (!_isSpectating || _targetState == null) return;

            // Interpolate health values smoothly
            if (_currentState == null)
            {
                _currentState = _targetState;
                OnStateApplied?.Invoke(_currentState);
            }
            else if (_currentState.BattleId != _targetState.BattleId ||
                     _currentState.Round != _targetState.Round)
            {
                _currentState = _targetState;
                OnStateApplied?.Invoke(_currentState);
            }
        }

        public void StopSpectating()
        {
            _isSpectating = false;
        }
    }
}
