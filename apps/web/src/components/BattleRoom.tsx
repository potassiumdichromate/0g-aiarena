"use client";

import { useEffect, useState } from "react";
import type { Battle } from "@/lib/api-client";
import { battleApi } from "@/lib/api-client";

interface BattleRoomProps {
  battleId: string;
}

const STATUS_COLORS: Record<string, string> = {
  PENDING: "bg-yellow-500",
  IN_PROGRESS: "bg-cyan-500",
  COMPLETED: "bg-green-500",
  DISPUTED: "bg-red-500",
  CANCELLED: "bg-gray-500",
};

export function BattleRoom({ battleId }: BattleRoomProps) {
  const [battle, setBattle] = useState<Battle | null>(null);
  const [polling, setPolling] = useState(true);

  useEffect(() => {
    let interval: NodeJS.Timeout;

    const fetchBattle = async () => {
      try {
        const data = await battleApi.get(battleId);
        setBattle(data);
        if (data.status === "COMPLETED" || data.status === "CANCELLED" || data.status === "DISPUTED") {
          setPolling(false);
        }
      } catch {
        setPolling(false);
      }
    };

    fetchBattle();
    if (polling) {
      interval = setInterval(fetchBattle, 2000);
    }

    return () => clearInterval(interval);
  }, [battleId, polling]);

  if (!battle) {
    return (
      <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-8 text-center text-gray-500">
        Loading battle...
      </div>
    );
  }

  const statusColor = STATUS_COLORS[battle.status] ?? "bg-gray-500";

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Battle</h2>
        <span className={`px-3 py-1 rounded-full text-xs font-medium text-black ${statusColor}`}>
          {battle.status}
        </span>
      </div>

      <div className="text-xs text-gray-500 font-mono">{battle.id}</div>

      <div className="flex gap-4">
        {battle.agentIds.map((id, i) => (
          <div
            key={id}
            className={`flex-1 rounded-lg p-4 border ${
              battle.winnerId === id
                ? "border-green-500/50 bg-green-950/30"
                : "border-gray-700 bg-gray-800/50"
            }`}
          >
            <p className="text-xs text-gray-500">Agent {i + 1}</p>
            <p className="font-mono text-xs text-white mt-1 truncate">{id}</p>
            {battle.winnerId === id && (
              <p className="text-green-400 text-xs font-bold mt-2">WINNER</p>
            )}
          </div>
        ))}
      </div>

      {battle.startedAt && (
        <p className="text-xs text-gray-600">
          Started: {new Date(battle.startedAt).toLocaleString()}
        </p>
      )}
      {battle.endedAt && (
        <p className="text-xs text-gray-600">
          Ended: {new Date(battle.endedAt).toLocaleString()}
        </p>
      )}
    </div>
  );
}
