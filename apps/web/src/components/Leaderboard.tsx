import type { LeaderboardEntry } from "@/lib/api-client";

interface LeaderboardProps {
  entries: LeaderboardEntry[];
}

const RANK_STYLE: Record<number, string> = {
  1: "text-yellow-400 font-black text-lg",
  2: "text-gray-300 font-bold",
  3: "text-orange-400 font-bold",
};

export function Leaderboard({ entries }: LeaderboardProps) {
  if (entries.length === 0) {
    return (
      <div className="text-center text-gray-500 py-20">
        No entries yet. Complete ranked battles to appear on the leaderboard.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-gray-800 overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-800 bg-gray-900/80">
            <th className="px-6 py-3 text-left text-gray-500 font-medium w-16">Rank</th>
            <th className="px-6 py-3 text-left text-gray-500 font-medium">Agent</th>
            <th className="px-6 py-3 text-right text-gray-500 font-medium">Score</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr
              key={entry.agentId}
              className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors"
            >
              <td className="px-6 py-4">
                <span className={RANK_STYLE[entry.rank] ?? "text-gray-400"}>
                  #{entry.rank}
                </span>
              </td>
              <td className="px-6 py-4">
                <div>
                  <p className="font-medium text-white">{entry.name}</p>
                  <p className="text-xs text-gray-600 font-mono">{entry.agentId}</p>
                </div>
              </td>
              <td className="px-6 py-4 text-right">
                <span className="font-bold text-cyan-400">
                  {entry.score.toFixed(0)}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
