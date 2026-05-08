import type { Agent } from "@/lib/api-client";

const CLAN_COLORS: Record<string, string> = {
  CYBER: "text-cyan-400 border-cyan-500/30 bg-cyan-950/30",
  BIO: "text-green-400 border-green-500/30 bg-green-950/30",
  ARCANE: "text-purple-400 border-purple-500/30 bg-purple-950/30",
  MECH: "text-orange-400 border-orange-500/30 bg-orange-950/30",
  SHADOW: "text-gray-400 border-gray-500/30 bg-gray-900/50",
};

const STAGE_LABEL: Record<string, string> = {
  GENESIS: "Genesis",
  AWAKENED: "Awakened",
  ASCENDED: "Ascended",
  LEGENDARY: "Legendary",
  MYTHIC: "MYTHIC",
};

interface AgentCardProps {
  agent: Agent;
  onClick?: () => void;
}

export function AgentCard({ agent, onClick }: AgentCardProps) {
  const colors = CLAN_COLORS[agent.clan] ?? CLAN_COLORS.SHADOW;

  return (
    <div
      onClick={onClick}
      className={`rounded-xl border p-5 cursor-pointer transition-all hover:scale-[1.02] hover:shadow-lg ${colors}`}
    >
      <div className="flex items-start justify-between mb-3">
        <div>
          <h3 className="font-bold text-white text-lg leading-tight">{agent.name}</h3>
          <p className="text-xs text-gray-500 mt-0.5">{agent.clan} · {agent.archetype}</p>
        </div>
        <span className="text-xs font-medium px-2 py-1 rounded-full border border-current opacity-80">
          {STAGE_LABEL[agent.evolutionStage] ?? agent.evolutionStage}
        </span>
      </div>

      <div className="flex items-center justify-between text-sm">
        <span className="text-gray-400">ELO</span>
        <span className="font-bold text-white">{agent.elo.toFixed(0)}</span>
      </div>

      {agent.traits && (
        <div className="mt-3 space-y-1">
          {Object.entries(agent.traits)
            .slice(0, 3)
            .map(([trait, value]) => (
              <div key={trait} className="flex items-center gap-2 text-xs">
                <span className="text-gray-500 w-20 capitalize">{trait}</span>
                <div className="flex-1 h-1.5 rounded-full bg-gray-800">
                  <div
                    className="h-full rounded-full bg-current opacity-70"
                    style={{ width: `${Math.min(value, 100)}%` }}
                  />
                </div>
                <span className="text-gray-400 w-6 text-right">{Math.round(value)}</span>
              </div>
            ))}
        </div>
      )}

      {agent.inftTokenId && (
        <p className="mt-3 text-xs text-gray-600 font-mono truncate">
          #{agent.inftTokenId}
        </p>
      )}
    </div>
  );
}
