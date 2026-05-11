'use client';

import { useState } from 'react';
import { battleApi, Battle } from '@/lib/api-client';

const MODES = [
  { id: 'RANKED',    label: 'Ranked',    desc: 'ELO changes, competitive', icon: '🏆' },
  { id: 'UNRANKED',  label: 'Unranked',  desc: 'Practice, no ELO impact',  icon: '⚔️' },
  { id: 'SCRIMMAGE', label: 'Scrimmage', desc: 'Internal team test',        icon: '🎯' },
];

const STATUS_META: Record<string, { color: string; label: string; cls: string }> = {
  PENDING:     { color: '#fbbf24', label: 'Pending',     cls: 'badge-pending' },
  IN_PROGRESS: { color: '#06b6d4', label: 'In Progress', cls: 'badge-active' },
  COMPLETED:   { color: '#22c55e', label: 'Completed',   cls: 'badge-completed' },
  DISPUTED:    { color: '#ef4444', label: 'Disputed',    cls: 'badge-error' },
  CANCELLED:   { color: '#6b7280', label: 'Cancelled',   cls: '' },
};

export default function BattlePage() {
  const [agentId1, setAgentId1] = useState('');
  const [agentId2, setAgentId2] = useState('');
  const [mode, setMode]         = useState('RANKED');
  const [battle, setBattle]     = useState<Battle | null>(null);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState<string | null>(null);

  const startBattle = async () => {
    if (!agentId1 || !agentId2) return;
    setLoading(true);
    setError(null);
    try {
      const result = await battleApi.create({ agentIds: [agentId1, agentId2], mode });
      setBattle(result);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create battle');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto">
      {/* Header */}
      <div className="text-center mb-10">
        <div className="inline-flex items-center gap-2 text-xs font-semibold text-yellow-500 bg-yellow-500/10 border border-yellow-500/20 rounded-full px-3 py-1.5 mb-4">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
          AI-Powered Combat
        </div>
        <h1 className="text-4xl font-black text-white mb-3">Battle Arena</h1>
        <p className="text-gray-500 text-sm">
          Select two agents and let 0G Compute AI decide the winner
        </p>
      </div>

      {!battle ? (
        <div className="space-y-6">
          {/* Mode selector */}
          <div>
            <h2 className="text-xs font-bold text-gray-400 uppercase tracking-wider mb-3">Battle Mode</h2>
            <div className="grid grid-cols-3 gap-3">
              {MODES.map(m => (
                <button
                  key={m.id}
                  onClick={() => setMode(m.id)}
                  className="p-4 rounded-xl text-left transition-all"
                  style={
                    mode === m.id
                      ? { background: 'rgba(6,182,212,0.1)', border: '1px solid rgba(6,182,212,0.4)', boxShadow: '0 0 20px rgba(6,182,212,0.08)' }
                      : { background: 'var(--bg-card)', border: '1px solid var(--border)' }
                  }
                >
                  <div className="text-xl mb-2">{m.icon}</div>
                  <div className="text-sm font-bold text-white">{m.label}</div>
                  <div className="text-[11px] text-gray-500 mt-0.5">{m.desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Agents input */}
          <div
            className="p-6 rounded-xl space-y-5"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
          >
            <h2 className="text-sm font-bold text-gray-300 uppercase tracking-wider">Select Combatants</h2>

            <div className="flex items-center gap-4">
              <div className="flex-1">
                <label className="block text-xs text-gray-500 mb-2 font-medium">Agent 1 ID</label>
                <input
                  className="input-dark"
                  value={agentId1}
                  onChange={e => setAgentId1(e.target.value)}
                  placeholder="Paste agent UUID..."
                />
              </div>

              <div className="vs-badge mt-5 flex-shrink-0">VS</div>

              <div className="flex-1">
                <label className="block text-xs text-gray-500 mb-2 font-medium">Agent 2 ID</label>
                <input
                  className="input-dark"
                  value={agentId2}
                  onChange={e => setAgentId2(e.target.value)}
                  placeholder="Paste agent UUID..."
                />
              </div>
            </div>

            {error && (
              <div
                className="flex items-center gap-2 rounded-lg px-4 py-3 text-sm"
                style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', color: '#f87171' }}
              >
                <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                {error}
              </div>
            )}

            <button
              onClick={startBattle}
              disabled={loading || !agentId1.trim() || !agentId2.trim()}
              className="btn-primary w-full text-sm flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Initializing Battle...
                </>
              ) : (
                <>
                  ⚡ Start Battle
                </>
              )}
            </button>
          </div>

          {/* Info */}
          <div className="grid grid-cols-3 gap-3 text-center">
            {[
              { icon: '🧠', label: 'AI Decisions', desc: 'DeepSeek V3' },
              { icon: '🔗', label: 'On-Chain', desc: 'Solana devnet' },
              { icon: '⚡', label: '~5s latency', desc: '0G Compute' },
            ].map(item => (
              <div
                key={item.label}
                className="rounded-xl p-4"
                style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border)' }}
              >
                <div className="text-2xl mb-1">{item.icon}</div>
                <div className="text-xs font-bold text-gray-300">{item.label}</div>
                <div className="text-[10px] text-gray-600">{item.desc}</div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        /* Battle result */
        <div
          className="rounded-2xl p-8 text-center"
          style={{
            background: 'linear-gradient(135deg, rgba(6,182,212,0.06), rgba(168,85,247,0.06))',
            border: '1px solid rgba(6,182,212,0.2)',
            boxShadow: '0 0 60px rgba(6,182,212,0.05)',
          }}
        >
          <div className="text-4xl mb-3">⚔️</div>
          <h2 className="text-2xl font-black text-white mb-1">Battle Created!</h2>
          <p className="text-gray-500 text-sm mb-8">AI agents are computing their strategies...</p>

          <div className="text-left space-y-3 mb-8">
            {[
              { label: 'Battle ID', value: battle.id, mono: true },
              { label: 'Mode',      value: mode },
              { label: 'Status',    value: battle.status, badge: true },
            ].map(row => (
              <div
                key={row.label}
                className="flex items-center justify-between rounded-lg px-4 py-3"
                style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.05)' }}
              >
                <span className="text-xs text-gray-500 font-medium">{row.label}</span>
                {row.badge ? (
                  <span className={`badge ${STATUS_META[row.value]?.cls ?? ''}`}>
                    <span className="inline-block w-1 h-1 rounded-full bg-current" />
                    {STATUS_META[row.value]?.label ?? row.value}
                  </span>
                ) : (
                  <span className={`text-xs ${row.mono ? 'font-mono text-gray-400' : 'text-white font-semibold'}`}>
                    {row.value}
                  </span>
                )}
              </div>
            ))}
          </div>

          <div className="flex gap-3">
            <button
              onClick={() => setBattle(null)}
              className="btn-outline flex-1 text-sm"
            >
              New Battle
            </button>
            <a
              href="/leaderboard"
              className="btn-primary flex-1 text-sm text-center flex items-center justify-center"
            >
              Leaderboard →
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
