'use client';

import { useEffect, useState } from 'react';
import { agentApi, Agent } from '@/lib/api-client';
import { AgentCard } from '@/components/AgentCard';

const CLANS = ['ALL', 'ZEROG', 'BASE', 'SOLANA', 'ETHEREUM', 'COSMOS'];

const CLAN_COLORS: Record<string, string> = {
  ZEROG: '#06b6d4', BASE: '#2151f5', SOLANA: '#9945ff',
  ETHEREUM: '#f97316', COSMOS: '#22c55e',
};

function SkeletonCard() {
  return (
    <div className="card p-5">
      <div className="flex gap-3 mb-4">
        <div className="skeleton w-12 h-12 rounded-xl" />
        <div className="flex-1 space-y-2">
          <div className="skeleton h-4 w-3/4" />
          <div className="skeleton h-3 w-1/2" />
        </div>
      </div>
      <div className="skeleton h-12 rounded-lg mb-4" />
      <div className="space-y-2">
        {[1,2,3,4].map(i => <div key={i} className="skeleton h-2 rounded" />)}
      </div>
    </div>
  );
}

export default function AgentsPage() {
  const [agents, setAgents]     = useState<Agent[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [clan, setClan]         = useState('ALL');
  const [search, setSearch]     = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [newAgent, setNewAgent] = useState({ name: '', clan: 'ZEROG', archetype: 'TACTICIAN', gameId: 'standard' });

  useEffect(() => {
    setLoading(true);
    agentApi
      .list({ pageSize: 50, clan: clan === 'ALL' ? undefined : clan })
      .then(res => setAgents(res.agents))
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [clan]);

  const filtered = agents.filter(a =>
    !search || a.name.toLowerCase().includes(search.toLowerCase())
  );

  const handleCreate = async () => {
    setCreating(true);
    setCreateError(null);
    try {
      const agent = await agentApi.create(newAgent);
      setAgents(prev => [agent, ...prev]);
      setShowCreate(false);
      setNewAgent({ name: '', clan: 'ZEROG', archetype: 'TACTICIAN', gameId: 'standard' });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to create agent';
      const isAuth = msg.toLowerCase().includes('unauthorized') || msg.includes('401');
      setCreateError(
        isAuth
          ? 'Not authenticated. Click the ⚡ Dev button in the top-right nav to log in first.'
          : msg,
      );
    } finally {
      setCreating(false);
    }
  };

  return (
    <div>
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-8">
        <div>
          <h1 className="text-3xl font-black text-white">Agents</h1>
          <p className="text-gray-500 text-sm mt-1">
            {loading ? 'Loading...' : `${agents.length} agents across all clans`}
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="btn-primary text-sm flex items-center gap-2"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Create Agent
        </button>
      </div>

      {/* Search + Filters */}
      <div className="flex flex-col sm:flex-row gap-3 mb-8">
        <div className="relative flex-1">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search agents..."
            className="input-dark pl-10 text-sm"
          />
        </div>
        <div className="flex gap-2 flex-wrap">
          {CLANS.map(c => (
            <button
              key={c}
              onClick={() => setClan(c)}
              className="px-4 py-2 rounded-lg text-xs font-bold transition-all"
              style={
                clan === c
                  ? {
                      background: c === 'ALL' ? 'rgba(6,182,212,0.15)' : `${CLAN_COLORS[c]}20`,
                      color: c === 'ALL' ? '#06b6d4' : CLAN_COLORS[c],
                      border: `1px solid ${c === 'ALL' ? 'rgba(6,182,212,0.4)' : `${CLAN_COLORS[c]}40`}`,
                    }
                  : { background: 'transparent', color: '#6b7280', border: '1px solid #1e1e2e' }
              }
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      {/* Grid */}
      {loading && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {[...Array(8)].map((_, i) => <SkeletonCard key={i} />)}
        </div>
      )}

      {error && (
        <div className="text-center py-20">
          <div className="text-4xl mb-3">⚠️</div>
          <p className="text-red-400 font-semibold">{error}</p>
          <p className="text-gray-600 text-sm mt-1">Make sure the backend is running on :8000</p>
        </div>
      )}

      {!loading && !error && filtered.length === 0 && (
        <div className="text-center py-24">
          <div className="text-5xl mb-4">🤖</div>
          <h3 className="text-xl font-bold text-white mb-2">No agents yet</h3>
          <p className="text-gray-500 text-sm mb-6">
            {search ? `No agents match "${search}"` : 'Create your first AI agent to enter the arena'}
          </p>
          <button onClick={() => setShowCreate(true)} className="btn-primary text-sm">
            Create First Agent
          </button>
        </div>
      )}

      {!loading && !error && filtered.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filtered.map(agent => (
            <AgentCard key={agent.id} agent={agent} />
          ))}
        </div>
      )}

      {/* Create modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(8px)' }}>
          <div className="card w-full max-w-md p-8 relative" style={{ border: '1px solid rgba(6,182,212,0.2)', boxShadow: '0 0 60px rgba(6,182,212,0.1)' }}>
            <button
              onClick={() => { setShowCreate(false); setCreateError(null); }}
              className="absolute top-4 right-4 text-gray-500 hover:text-white transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>

            <h2 className="text-xl font-black text-white mb-6">Create Agent</h2>

            <div className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-2 uppercase tracking-wider">Agent Name</label>
                <input
                  className="input-dark"
                  placeholder="e.g. CyberPhantom-X"
                  value={newAgent.name}
                  onChange={e => setNewAgent(p => ({ ...p, name: e.target.value }))}
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-2 uppercase tracking-wider">Clan</label>
                <div className="grid grid-cols-5 gap-2">
                  {(['ZEROG','BASE','SOLANA','ETHEREUM','COSMOS'] as const).map(c => (
                    <button
                      key={c}
                      onClick={() => setNewAgent(p => ({ ...p, clan: c }))}
                      className="py-2 rounded-lg text-[10px] font-bold transition-all"
                      style={
                        newAgent.clan === c
                          ? { background: `${CLAN_COLORS[c]}20`, color: CLAN_COLORS[c], border: `1px solid ${CLAN_COLORS[c]}50` }
                          : { background: 'transparent', color: '#6b7280', border: '1px solid #1e1e2e' }
                      }
                    >
                      {c}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-400 mb-2 uppercase tracking-wider">Archetype</label>
                <select
                  className="input-dark"
                  value={newAgent.archetype}
                  onChange={e => setNewAgent(p => ({ ...p, archetype: e.target.value }))}
                >
                  {['BERSERKER','TACTICIAN','DEFENDER','ASSASSIN','SUPPORT','HYBRID'].map(a => (
                    <option key={a} value={a}>{a}</option>
                  ))}
                </select>
              </div>

              {createError && (
                <div
                  className="rounded-lg px-4 py-3 text-xs leading-relaxed"
                  style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', color: '#f87171' }}
                >
                  ⚠️ {createError}
                </div>
              )}

              <button
                onClick={handleCreate}
                disabled={creating || !newAgent.name.trim()}
                className="btn-primary w-full text-sm mt-2"
              >
                {creating ? (
                  <span className="flex items-center justify-center gap-2">
                    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Creating...
                  </span>
                ) : 'Create Agent'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
