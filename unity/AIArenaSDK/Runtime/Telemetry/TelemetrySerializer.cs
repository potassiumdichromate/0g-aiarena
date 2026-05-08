using System;
using System.Collections.Generic;
using System.Text;
using UnityEngine;

namespace AIArena.SDK.Telemetry
{
    /// <summary>
    /// Serializes telemetry events to JSON. Designed for MessagePack migration
    /// by keeping all fields consistently typed and named.
    /// </summary>
    public static class TelemetrySerializer
    {
        /// <summary>Serialize a single event to a JSON string.</summary>
        public static string Serialize(object evt)
        {
            return JsonUtility.ToJson(evt);
        }

        /// <summary>Serialize a collection of events into a batch payload.</summary>
        public static string SerializeBatch(string sessionId, IList<object> events)
        {
            var sb = new StringBuilder();
            sb.Append("{");
            sb.Append($"\"sessionId\":\"{EscapeJson(sessionId)}\",");
            sb.Append($"\"timestamp\":{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()},");
            sb.Append($"\"eventCount\":{events.Count},");
            sb.Append("\"events\":[");

            for (int i = 0; i < events.Count; i++)
            {
                sb.Append(Serialize(events[i]));
                if (i < events.Count - 1) sb.Append(",");
            }

            sb.Append("]}");
            return sb.ToString();
        }

        /// <summary>Deserialize a JSON string back to a typed object (for testing).</summary>
        public static T Deserialize<T>(string json)
        {
            return JsonUtility.FromJson<T>(json);
        }

        /// <summary>
        /// Build a minimal JSON object from key-value pairs without reflection.
        /// Useful for hot-path events where JsonUtility overhead matters.
        /// </summary>
        public static string BuildJson(params (string key, object value)[] fields)
        {
            var sb = new StringBuilder("{");
            for (int i = 0; i < fields.Length; i++)
            {
                var (key, value) = fields[i];
                sb.Append($"\"{EscapeJson(key)}\":");
                AppendValue(sb, value);
                if (i < fields.Length - 1) sb.Append(",");
            }
            sb.Append("}");
            return sb.ToString();
        }

        private static void AppendValue(StringBuilder sb, object value)
        {
            switch (value)
            {
                case null:
                    sb.Append("null");
                    break;
                case bool b:
                    sb.Append(b ? "true" : "false");
                    break;
                case int i:
                    sb.Append(i);
                    break;
                case long l:
                    sb.Append(l);
                    break;
                case float f:
                    sb.Append(f.ToString("G", System.Globalization.CultureInfo.InvariantCulture));
                    break;
                case double d:
                    sb.Append(d.ToString("G", System.Globalization.CultureInfo.InvariantCulture));
                    break;
                case string s:
                    sb.Append($"\"{EscapeJson(s)}\"");
                    break;
                case Vector3 v:
                    sb.Append($"{{\"x\":{v.x:G},\"y\":{v.y:G},\"z\":{v.z:G}}}");
                    break;
                default:
                    sb.Append($"\"{EscapeJson(value.ToString())}\"");
                    break;
            }
        }

        private static string EscapeJson(string s)
        {
            if (string.IsNullOrEmpty(s)) return s;
            return s.Replace("\\", "\\\\")
                    .Replace("\"", "\\\"")
                    .Replace("\n", "\\n")
                    .Replace("\r", "\\r")
                    .Replace("\t", "\\t");
        }
    }
}
