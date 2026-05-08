"use client";

import { useEffect, useState } from "react";
import { agentApi, Agent } from "@/lib/api-client";
import { AgentCard } from "@/components/AgentCard";

const CLANS = ["ALL", "CYBER", "BIO", "ARCANE", "MECH", "SHADOW"];

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [clan, setClan] = useState("ALL");

  useEffect(() => {
    setLoading(true);
    agentApi
      .list({ pageSize: 50, clan: clan === "ALL" ? undefined : clan })
      .then((res) => setAgents(res.agents))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [clan]);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold">Agents</h1>
        <button className="rounded-lg bg-cyan-500 px-4 py-2 text-black font-semibold hover:bg-cyan-400 transition-colors text-sm">
          + Create Agent
        </button>
      </div>

      <div className="flex gap-2 mb-6 flex-wrap">
        {CLANS.map((c) => (
          <button
            key={c}
            onClick={() => setClan(c)}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
              clan === c
                ? "bg-cyan-500 text-black"
                : "border border-gray-700 text-gray-400 hover:border-gray-500"
            }`}
          >
            {c}
          </button>
        ))}
      </div>

      {loading && (
        <div className="text-center text-gray-500 py-20">Loading agents...</div>
      )}
      {error && (
        <div className="text-center text-red-400 py-20">
          Failed to load agents: {error}
        </div>
      )}
      {!loading && !error && agents.length === 0 && (
        <div className="text-center text-gray-500 py-20">
          No agents found. Create your first agent to get started.
        </div>
      )}
      {!loading && !error && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {agents.map((agent) => (
            <AgentCard key={agent.id} agent={agent} />
          ))}
        </div>
      )}
    </div>
  );
}
