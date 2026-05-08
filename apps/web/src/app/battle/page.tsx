"use client";

import { useState } from "react";
import { battleApi, Battle } from "@/lib/api-client";

export default function BattlePage() {
  const [agentId1, setAgentId1] = useState("");
  const [agentId2, setAgentId2] = useState("");
  const [mode, setMode] = useState("RANKED");
  const [battle, setBattle] = useState<Battle | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startBattle = async () => {
    if (!agentId1 || !agentId2) return;
    setLoading(true);
    setError(null);
    try {
      const result = await battleApi.create({
        agentIds: [agentId1, agentId2],
        mode,
      });
      setBattle(result);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to create battle");
    } finally {
      setLoading(false);
    }
  };

  const statusColor: Record<string, string> = {
    PENDING: "text-yellow-400",
    IN_PROGRESS: "text-cyan-400",
    COMPLETED: "text-green-400",
    DISPUTED: "text-red-400",
    CANCELLED: "text-gray-500",
  };

  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-3xl font-bold mb-8">Battle Arena</h1>

      {!battle ? (
        <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-8 space-y-6">
          <h2 className="text-xl font-semibold text-cyan-400">Create Battle</h2>

          <div>
            <label className="block text-sm text-gray-400 mb-2">Agent 1 ID</label>
            <input
              type="text"
              value={agentId1}
              onChange={(e) => setAgentId1(e.target.value)}
              placeholder="uuid..."
              className="w-full rounded-lg bg-gray-800 border border-gray-700 px-4 py-3 text-white text-sm focus:outline-none focus:border-cyan-500"
            />
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-2">Agent 2 ID</label>
            <input
              type="text"
              value={agentId2}
              onChange={(e) => setAgentId2(e.target.value)}
              placeholder="uuid..."
              className="w-full rounded-lg bg-gray-800 border border-gray-700 px-4 py-3 text-white text-sm focus:outline-none focus:border-cyan-500"
            />
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-2">Mode</label>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value)}
              className="w-full rounded-lg bg-gray-800 border border-gray-700 px-4 py-3 text-white text-sm focus:outline-none focus:border-cyan-500"
            >
              {["RANKED", "UNRANKED", "SCRIMMAGE"].map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>

          {error && (
            <p className="text-red-400 text-sm">{error}</p>
          )}

          <button
            onClick={startBattle}
            disabled={loading || !agentId1 || !agentId2}
            className="w-full rounded-lg bg-cyan-500 px-6 py-3 text-black font-bold hover:bg-cyan-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {loading ? "Creating..." : "Start Battle"}
          </button>
        </div>
      ) : (
        <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-8 space-y-4">
          <h2 className="text-xl font-semibold text-cyan-400">Battle Created</h2>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-500">Battle ID</span>
              <span className="font-mono text-xs">{battle.id}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Status</span>
              <span className={statusColor[battle.status] ?? "text-white"}>
                {battle.status}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Mode</span>
              <span>{mode}</span>
            </div>
          </div>
          <button
            onClick={() => setBattle(null)}
            className="mt-4 rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors"
          >
            Create Another
          </button>
        </div>
      )}
    </div>
  );
}
