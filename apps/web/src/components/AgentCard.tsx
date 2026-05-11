import type { Agent } from '@/lib/api-client';

const CLAN_META: Record<string, { color: string; glow: string; emoji: string; cls: string }> = {
  CYBER:  { color: '#06b6d4', glow: 'rgba(6,182,212,0.2)',   emoji: '⚡', cls: 'clan-CYBER' },
  BIO:    { color: '#22c55e', glow: 'rgba(34,197,94,0.2)',   emoji: '🧬', cls: 'clan-BIO' },
  ARCANE: { color: '#a855f7', glow: 'rgba(168,85,247,0.2)',  emoji: '🔮', cls: 'clan-ARCANE' },
  MECH:   { color: '#f97316', glow: 'rgba(249,115,22,0.2)',  emoji: '⚙️', cls: 'clan-MECH' },
  SHADOW: { color: '#94a3b8', glow: 'rgba(148,163,184,0.15)',emoji: '🌑', cls: 'clan-SHADOW' },
};

const STAGE_LABELS: Record<string, { label: string; stars: number }> = {
  GENESIS:   { label: 'Genesis',   stars: 1 },
  AWAKENED:  { label: 'Awakened',  stars: 2 },
  ASCENDED:  { label: 'Ascended',  stars: 3 },
  LEGENDARY: { label: 'Legendary', stars: 4 },
  MYTHIC:    { label: 'MYTHIC',    stars: 5 },
};

const TRAIT_LABELS: Record<string, string> = {
  aggression:   'AGG',
  intelligence: 'INT',
  adaptability: 'ADP',
  resilience:   'RES',
  creativity:   'CRE',
  loyalty:      'LOY',
  deception:    'DCP',
  patience:     'PAT',
};

interface AgentCardProps {
  agent: Agent;
  onClick?: () => void;
}

export function AgentCard({ agent, onClick }: AgentCardProps) {
  const meta  = CLAN_META[agent.clan] ?? CLAN_META.SHADOW;
  const stage = STAGE_LABELS[agent.evolutionStage] ?? { label: agent.evolutionStage, stars: 1 };
  const elo   = (agent as any).eloRating ?? (agent as any).elo ?? 1200;
  const traits = agent.traits ? Object.entries(agent.traits).slice(0, 5) : [];

  return (
    <div
      onClick={onClick}
      className="card p-5 cursor-pointer group"
      style={{ '--clan-color': meta.color } as React.CSSProperties}
    >
      {/* Top row: avatar + name + stage */}
      <div className="flex items-start gap-3 mb-4">
        {/* Avatar */}
        <div
          className="w-12 h-12 rounded-xl flex items-center justify-center text-xl flex-shrink-0 transition-transform group-hover:scale-110"
          style={{
            background: `linear-gradient(135deg, ${meta.color}20, ${meta.color}10)`,
            border: `1px solid ${meta.color}30`,
          }}
        >
          {meta.emoji}
        </div>

        <div className="flex-1 min-w-0">
          <h3 className="font-bold text-white text-base leading-tight truncate group-hover:text-cyan-300 transition-colors">
            {agent.name}
          </h3>
          <div className="flex items-center gap-1.5 mt-1">
            <span
              className={`badge ${meta.cls} text-[10px]`}
              style={{ fontSize: 10 }}
            >
              {agent.clan}
            </span>
            <span className="text-[10px] text-gray-600">·</span>
            <span className="text-[10px] text-gray-500">{agent.archetype}</span>
          </div>
        </div>

        {/* Stage */}
        <div className="text-right flex-shrink-0">
          <div className="text-[9px] font-bold tracking-widest uppercase" style={{ color: meta.color }}>
            {stage.label}
          </div>
          <div className="text-[10px] mt-0.5" style={{ color: meta.color }}>
            {'★'.repeat(stage.stars)}{'☆'.repeat(5 - stage.stars)}
          </div>
        </div>
      </div>

      {/* ELO rating */}
      <div
        className="flex items-center justify-between rounded-lg px-3 py-2.5 mb-4"
        style={{ background: `${meta.color}08`, border: `1px solid ${meta.color}15` }}
      >
        <div className="text-xs text-gray-500 font-medium">ELO Rating</div>
        <div className="flex items-center gap-2">
          <span className="text-lg font-black" style={{ color: meta.color }}>
            {Math.round(elo)}
          </span>
          <div className="flex flex-col gap-0.5">
            <div className="text-[10px] text-green-400">
              {agent.wins ?? 0}W
            </div>
            <div className="text-[10px] text-red-400">
              {agent.losses ?? 0}L
            </div>
          </div>
        </div>
      </div>

      {/* Trait bars */}
      {traits.length > 0 && (
        <div className="space-y-2">
          {traits.map(([trait, value]) => {
            const pct = Math.min(Math.max(Number(value), 0), 100);
            return (
              <div key={trait} className="flex items-center gap-2">
                <span className="text-[9px] font-bold text-gray-600 w-7 tracking-wider">
                  {TRAIT_LABELS[trait] ?? trait.slice(0, 3).toUpperCase()}
                </span>
                <div className="flex-1 h-1 rounded-full bg-gray-800">
                  <div
                    className="h-full rounded-full transition-all duration-700"
                    style={{
                      width: `${pct}%`,
                      background: `linear-gradient(90deg, ${meta.color}90, ${meta.color})`,
                    }}
                  />
                </div>
                <span className="text-[10px] text-gray-500 w-6 text-right font-mono">
                  {Math.round(pct)}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* INFT badge */}
      {agent.inftTokenId && (
        <div
          className="mt-3 flex items-center gap-1.5 rounded-lg px-2.5 py-1.5"
          style={{ background: 'rgba(168,85,247,0.06)', border: '1px solid rgba(168,85,247,0.15)' }}
        >
          <span className="text-[9px]">🔮</span>
          <span className="text-[10px] text-purple-400 font-mono truncate">
            INFT #{agent.inftTokenId}
          </span>
        </div>
      )}
    </div>
  );
}
