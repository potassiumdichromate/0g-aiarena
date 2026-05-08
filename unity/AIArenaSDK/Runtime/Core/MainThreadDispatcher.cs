using System;
using System.Collections.Generic;
using System.Threading;
using UnityEngine;

namespace AIArena.SDK.Core
{
    /// <summary>
    /// Dispatches actions from background threads to the Unity main thread.
    /// Required for updating GameObjects from async callbacks.
    /// </summary>
    public class MainThreadDispatcher : MonoBehaviour
    {
        private static MainThreadDispatcher _instance;
        private static readonly Queue<Action> _actions = new Queue<Action>();
        private static readonly object _lock = new object();
        private static Thread _mainThread;

        public static MainThreadDispatcher Instance
        {
            get
            {
                if (_instance == null)
                {
                    var go = new GameObject("[MainThreadDispatcher]");
                    _instance = go.AddComponent<MainThreadDispatcher>();
                    DontDestroyOnLoad(go);
                }
                return _instance;
            }
        }

        private void Awake()
        {
            _mainThread = Thread.CurrentThread;
            if (_instance == null) _instance = this;
            DontDestroyOnLoad(gameObject);
        }

        /// <summary>Dispatch an action to run on the main thread in the next Update().</summary>
        public static void Enqueue(Action action)
        {
            if (action == null) return;

            if (Thread.CurrentThread == _mainThread)
            {
                action();
                return;
            }

            lock (_lock)
            {
                _actions.Enqueue(action);
            }
        }

        private void Update()
        {
            lock (_lock)
            {
                while (_actions.Count > 0)
                {
                    try
                    {
                        _actions.Dequeue()?.Invoke();
                    }
                    catch (Exception ex)
                    {
                        Debug.LogError($"[MainThreadDispatcher] Action failed: {ex.Message}");
                    }
                }
            }
        }
    }
}
