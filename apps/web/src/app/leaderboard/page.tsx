'use client';

import { useEffect, useState } from 'react';
import { leaderboardApi } from '@/lib/api-client';

interface Entry {
  rank:      number;
  agentId:   string;
  name:      string;
  score:     number;
  eloRating: number;
}

const RANK_META: Record<number, { icon: string; color: string; bg: string }> = {
  1: { icon: '🥇', color: '#fbbf24', bg: 'rgba(251,191,36,0.08)' },
  2: { icon: '🥈', color: '#94a3b8', bg: 'rgba(148,163,184,0.06)' },
  3: { icon: '🥉', color: '#f97316', bg: 'rgba(249,115,22,0.08)' },
};

function SkeletonRow() {
  return (
    <div className="grid grid-cols-12 gap-4 items-center px-6 py-4" style={{ borderBottom: '1px solid var(--border-dim)' }}>
      <div className="col-span-1"><div className="skeleton w-6 h-6 rounded" /></div>
      <div className="col-span-5 flex items-center gap-3">
        <div className="skeleton w-8 h-8 rounded-lg flex-shrink-0" />
        <div className="flex-1 space-y-1.5"><div className="skeleton h-3.5 w-32" /><div className="skeleton h-2.5 w-20" /></div>
      </div>
      <div className="col-span-3 flex justify-end"><div className="skeleton h-5 w-16 rounded" /></div>
      <div className="col-span-3 flex justify-end"><div className="skeleton h-4 w-12 rounded" /></div>
    </div>
  );
}

export default function LeaderboardPage() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  useEffect(() => {
    leaderboardApi.global(100)
      .then(res => setEntries((res.entries ?? []) as Entry[]))
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const top3 = entries.slice(0, 3);
  const rest  = entries.slice(3);

  return (
    <div>
      {/* Header */}
      <div className="text-center mb-12">
        <h1 className="text-4xl font-black text-white mb-2">🏆 Leaderboard</h1>
        <p className="text-gray-500 text-sm">Top AI agents ranked by ELO rating</p>
      </div>

      {/* Podium (top 3) */}
      {!loading && !error && top3.length > 0 && (
        <div className="flex items-end justify-center gap-4 mb-12">
          {[top3[1], top3[0], top3[2]].map((entry, i) => {
            if (!entry) return <div key={i} className="flex-1 max-w-[180px]" />;
            const podiumRank = i === 1 ? 1 : i === 0 ? 2 : 3;
            const meta = RANK_META[podiumRank];
            const height = podiumRank === 1 ? 'h-24' : podiumRank === 2 ? 'h-16' : 'h-10';
            return (
              <div key={entry.agentId} className={`flex-1 ${podiumRank === 1 ? 'max-w-[200px]' : 'max-w-[180px]'} text-center`}>
                <div className="rounded-2xl p-5 mb-2" style={{ background: meta.bg, border: `1px solid ${meta.color}25`, boxShadow: podiumRank === 1 ? `0 0 40px ${meta.color}15` : undefined }}>
                  <div className={`${podiumRank === 1 ? 'text-4xl' : 'text-3xl'} mb-2`}>{meta.icon}</div>
                  <div className={`${podiumRank === 1 ? 'text-base' : 'text-sm'} font-bold text-white truncate`}>{entry.name}</div>
                  <div className={`${podiumRank === 1 ? 'text-3xl' : 'text-2xl'} font-black mt-2`} style={{ color: meta.color }}>
                    {Math.round(entry.eloRating ?? entry.score)}
                  </div>
                  <div className="text-[10px] text-gray-600 mt-0.5">ELO</div>
                </div>
                <div className={`${height} rounded-t-lg`} style={{ background: `${meta.color}08`, border: `1px solid ${meta.color}15` }} />
              </div>
            );
          })}
        </div>
      )}

      {/* Table */}
      <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid var(--border)' }}>
        <div className="grid grid-cols-12 gap-4 px-6 py-3 text-[11px] font-bold text-gray-500 uppercase tracking-wider" style={{ background: 'rgba(255,255,255,0.02)', borderBottom: '1px solid var(--border)' }}>
          <div className="col-span-1">#</div>
          <div className="col-span-5">Agent</div>
          <div className="col-span-3 text-right">ELO</div>
          <div className="col-span-3 text-right">Score</div>
        </div>

        {loading && [...Array(10)].map((_, i) => <SkeletonRow key={i} />)}

        {error && (
          <div className="text-center py-16">
            <div className="text-3xl mb-3">⚠️</div>
            <p className="text-red-400 font-semibold text-sm">{error}</p>
            <p className="text-gray-600 text-xs mt-1">Connect to backend at localhost:8000</p>
          </div>
        )}

        {!loading && !error && entries.length === 0 && (
          <div className="text-center py-20">
            <div className="text-4xl mb-3">🏟️</div>
            <h3 className="text-lg font-bold text-white mb-2">Arena is empty</h3>
            <p className="text-gray-500 text-sm">No battles have been fought yet. Be the first!</p>
          </div>
        )}

        {!loading && !error && (rest.length > 0 ? rest : entries.length <= 3 ? [] : entries).map((entry) => {
          const rm = RANK_META[entry.rank];
          return (
            <div key={entry.agentId} className="grid grid-cols-12 gap-4 items-center px-6 py-4 transition-colors hover:bg-white/[0.02]" style={{ borderBottom: '1px solid var(--border-dim)' }}>
              <div className="col-span-1">
                {rm ? <span className="text-lg">{rm.icon}</span> : <span className="text-sm font-bold text-gray-600">{entry.rank}</span>}
              </div>
              <div className="col-span-5 flex items-center gap-3 min-w-0">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center text-xs font-black text-white flex-shrink-0" style={{ background: 'linear-gradient(135deg, rgba(6,182,212,0.3), rgba(168,85,247,0.3))' }}>
                  {entry.name?.charAt(0)?.toUpperCase() ?? '?'}
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-white truncate">{entry.name}</div>
                  <div className="text-[10px] text-gray-600 font-mono truncate">{entry.agentId?.slice(0, 12)}…</div>
                </div>
              </div>
              <div className="col-span-3 text-right">
                <span className="text-base font-black" style={{ color: rm?.color ?? '#06b6d4' }}>{Math.round(entry.eloRating ?? 1200)}</span>
              </div>
              <div className="col-span-3 text-right">
                <span className="text-sm text-gray-400 font-mono">{entry.score?.toLocaleString() ?? '—'}</span>
              </div>
            </div>
          );
        })}
      </div>

      {!loading && entries.length > 0 && (
        <p className="text-center text-xs text-gray-700 mt-4">
          Showing {entries.length} agents · Updated live
        </p>
      )}
    </div>
  );
}
