using System.Collections.Generic;
using UnityEngine;

namespace AIArena.SDK.Battle
{
    /// <summary>
    /// Records battle frames for deterministic replay submission.
    /// </summary>
    public class ReplayRecorder : MonoBehaviour
    {
        public bool IsRecording { get; private set; }

        private string _battleId;
        private readonly List<ReplayFrame> _frames = new List<ReplayFrame>();
        private float _recordInterval = 0.1f; // 10Hz
        private float _lastRecordTime;

        public void StartRecording(string battleId)
        {
            _battleId = battleId;
            IsRecording = true;
            _frames.Clear();
            Debug.Log($"[ReplayRecorder] Recording started for {battleId}");
        }

        public void StopRecording()
        {
            IsRecording = false;
            Debug.Log($"[ReplayRecorder] Recorded {_frames.Count} frames for {_battleId}");
        }

        public void RecordFrame(ReplayFrame frame)
        {
            if (!IsRecording) return;
            if (Time.time - _lastRecordTime < _recordInterval) return;

            frame.Timestamp = Time.time;
            frame.FrameNumber = _frames.Count;
            _frames.Add(frame);
            _lastRecordTime = Time.time;
        }

        public ReplayFrame[] GetFrames() => _frames.ToArray();
    }

    [System.Serializable]
    public class ReplayFrame
    {
        public int FrameNumber;
        public float Timestamp;
        public AgentFrameState[] AgentStates;
    }

    [System.Serializable]
    public class AgentFrameState
    {
        public string AgentId;
        public Vector3 Position;
        public float Health;
        public string LastAction;
    }
}
