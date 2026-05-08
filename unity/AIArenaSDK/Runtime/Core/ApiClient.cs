using System;
using System.Text;
using System.Threading.Tasks;
using UnityEngine;
using UnityEngine.Networking;

namespace AIArena.SDK.Core
{
    /// <summary>HTTP client for AI Arena API calls.</summary>
    public static class ApiClient
    {
        public static async Task<T> Get<T>(string path, AIArenaConfig config)
        {
            var url = $"{config.ApiBaseUrl}{path}";
            using var req = UnityWebRequest.Get(url);
            req.SetRequestHeader("X-API-Key", config.ApiKey);
            req.SetRequestHeader("X-Game-Id", config.GameId);
            req.timeout = (int)config.RequestTimeoutSeconds;

            var op = req.SendWebRequest();
            while (!op.isDone) await Task.Yield();

            if (req.result != UnityWebRequest.Result.Success)
                throw new Exception($"GET {path} failed: {req.error}");

            return JsonUtility.FromJson<T>(req.downloadHandler.text);
        }

        public static async Task<T> Post<T>(string path, object body, AIArenaConfig config)
        {
            var url = $"{config.ApiBaseUrl}{path}";
            var json = body != null ? JsonUtility.ToJson(body) : "{}";
            var bytes = Encoding.UTF8.GetBytes(json);

            using var req = new UnityWebRequest(url, "POST");
            req.uploadHandler = new UploadHandlerRaw(bytes);
            req.downloadHandler = new DownloadHandlerBuffer();
            req.SetRequestHeader("Content-Type", "application/json");
            req.SetRequestHeader("X-API-Key", config.ApiKey);
            req.SetRequestHeader("X-Game-Id", config.GameId);
            req.timeout = (int)config.RequestTimeoutSeconds;

            var op = req.SendWebRequest();
            while (!op.isDone) await Task.Yield();

            if (req.result != UnityWebRequest.Result.Success)
                throw new Exception($"POST {path} failed: {req.error}");

            if (typeof(T) == typeof(object)) return default;
            return JsonUtility.FromJson<T>(req.downloadHandler.text);
        }
    }
}
