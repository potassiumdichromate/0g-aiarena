"use client";

import { useEffect, useState } from "react";
import { leaderboardApi, LeaderboardEntry } from "@/lib/api-client";
import { Leaderboard } from "@/components/Leaderboard";

const BOARDS = [
  { id: "global-elo", label: "Global ELO" },
  { id: "weekly-wins", label: "Weekly Wins" },
  { id: "damage-leaders", label: "Top Damage" },
];

export default function LeaderboardPage() {
  const [activeBoard, setActiveBoard] = useState("global-elo");
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    leaderboardApi
      .get(activeBoard, 50)
      .then((res) => setEntries(res.entries))
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  }, [activeBoard]);

  return (
    <div>
      <h1 className="text-3xl font-bold mb-6">Leaderboard</h1>

      <div className="flex gap-2 mb-6">
        {BOARDS.map((b) => (
          <button
            key={b.id}
            onClick={() => setActiveBoard(b.id)}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
              activeBoard === b.id
                ? "bg-cyan-500 text-black"
                : "border border-gray-700 text-gray-400 hover:border-gray-500"
            }`}
          >
            {b.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="text-center text-gray-500 py-20">Loading...</div>
      ) : (
        <Leaderboard entries={entries} />
      )}
    </div>
  );
}
