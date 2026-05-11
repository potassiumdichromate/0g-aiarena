'use client';
import { useEffect, useState } from 'react';

const CLAN_DATA = [
  { name: 'CYBER',  color: '#06b6d4', emoji: '⚡', desc: 'Adaptive hacking & digital warfare' },
  { name: 'BIO',    color: '#22c55e', emoji: '🧬', desc: 'Organic evolution & regeneration' },
  { name: 'ARCANE', color: '#a855f7', emoji: '🔮', desc: 'Reality-bending energy manipulation' },
  { name: 'MECH',   color: '#f97316', emoji: '⚙️', desc: 'Mechanical precision & heavy armor' },
  { name: 'SHADOW', color: '#94a3b8', emoji: '🌑', desc: 'Stealth, deception & infiltration' },
];

const STATS = [
  { label: 'Active Agents',  value: '2,847',  suffix: '' },
  { label: 'Battles Fought', value: '143K',   suffix: '+' },
  { label: '0G Compute',     value: '99.9',   suffix: '%' },
  { label: '$ARENA Price',   value: '1.0000', suffix: '' },
];

function CountUp({ target }: { target: string }) {
  const [display, setDisplay] = useState('0');
  useEffect(() => {
    const timeout = setTimeout(() => setDisplay(target), 300);
    return () => clearTimeout(timeout);
  }, [target]);
  return <span>{display}</span>;
}

export default function HomePage() {
  const [hovered, setHovered] = useState<string | null>(null);

  return (
    <div className="relative">
      {/* Background grid */}
      <div className="fixed inset-0 grid-bg opacity-40 pointer-events-none" />

      {/* Hero */}
      <section className="relative text-center pt-16 pb-20">
        {/* Glow orbs */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[300px] rounded-full bg-cyan-500/5 blur-3xl pointer-events-none" />
        <div className="absolute top-20 left-1/4 w-64 h-64 rounded-full bg-purple-500/5 blur-3xl pointer-events-none" />
        <div className="absolute top-20 right-1/4 w-64 h-64 rounded-full bg-cyan-500/5 blur-3xl pointer-events-none" />

        <div className="relative animate-[fadeIn_0.8s_ease-out]">
          <div className="inline-flex items-center gap-2 rounded-full border border-cyan-500/30 bg-cyan-500/5 px-4 py-1.5 text-xs font-semibold text-cyan-400 mb-8 tracking-widest uppercase">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
            Powered by 0G Blockchain
          </div>

          <h1 className="text-6xl sm:text-8xl font-black tracking-tighter text-white leading-none mb-6">
            <span className="neon-cyan">AI</span>
            <span className="text-white"> Arena</span>
          </h1>

          <p className="text-lg sm:text-xl text-gray-400 max-w-2xl mx-auto leading-relaxed mb-10">
            Train, evolve, and battle AI agents with <span className="text-cyan-400 font-semibold">verifiable on-chain inference</span>.
            Own your agent as an INFT. Earn real rewards.
          </p>

          <div className="flex gap-4 justify-center flex-wrap">
            <a
              href="/agents"
              className="btn-primary text-base px-8 py-3 inline-flex items-center gap-2"
            >
              <span>View Agents</span>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
              </svg>
            </a>
            <a
              href="/battle"
              className="btn-outline text-base px-8 py-3 inline-flex items-center gap-2"
            >
              <span>Start Battle</span>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </a>
          </div>
        </div>
      </section>

      {/* Stats bar */}
      <section className="border-y border-gray-800/50 bg-gray-900/20 backdrop-blur py-6 mb-16">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-gray-800/30">
          {STATS.map((s, i) => (
            <div key={i} className="flex flex-col items-center py-4 bg-[#09090e]">
              <span className="text-2xl sm:text-3xl font-black text-white font-mono">
                <CountUp target={s.value} />{s.suffix}
              </span>
              <span className="text-xs text-gray-500 mt-1 tracking-wide uppercase">{s.label}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Clans */}
      <section className="mb-20">
        <div className="text-center mb-10">
          <h2 className="text-3xl font-bold text-white mb-2">Choose Your Clan</h2>
          <p className="text-gray-500">Five factions. One winner. Infinite strategies.</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-5 gap-3">
          {CLAN_DATA.map((clan) => (
            <div
              key={clan.name}
              onMouseEnter={() => setHovered(clan.name)}
              onMouseLeave={() => setHovered(null)}
              className={`card p-5 cursor-pointer select-none transition-all duration-300 ${
                hovered === clan.name ? 'scale-[1.03] -translate-y-1' : ''
              }`}
              style={hovered === clan.name ? {
                borderColor: `${clan.color}50`,
                boxShadow: `0 0 30px ${clan.color}20, 0 20px 40px rgba(0,0,0,0.3)`,
              } : {}}
            >
              <div className="text-3xl mb-3">{clan.emoji}</div>
              <div className="text-sm font-bold tracking-widest mb-2" style={{ color: clan.color }}>
                {clan.name}
              </div>
              <p className="text-xs text-gray-500 leading-relaxed">{clan.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Features */}
      <section className="mb-20">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
          {[
            {
              icon: (
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
              ),
              color: '#06b6d4',
              title: '0G Compute AI',
              desc: 'Every battle decision is made by real AI inference via DeepSeek V3 on the 0G decentralized compute network. Fully verifiable.',
            },
            {
              icon: (
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
              ),
              color: '#a855f7',
              title: 'INFT Ownership',
              desc: 'Your agent is an ERC-7857 Intelligent NFT on 0G Chain. Transfer encrypted memory, clone strategies, authorize inference rights.',
            },
            {
              icon: (
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              ),
              color: '#22c55e',
              title: '$ARENA Token',
              desc: 'Fully backed stablecoin reserve on Solana. Deposit USDC/USDT to mint $ARENA. Earn rewards from battle fees and protocol revenue.',
            },
          ].map((f) => (
            <div key={f.title} className="card p-7 group hover:scale-[1.01] transition-transform">
              <div
                className="w-12 h-12 rounded-xl flex items-center justify-center mb-5"
                style={{ background: `${f.color}15`, color: f.color, border: `1px solid ${f.color}25` }}
              >
                {f.icon}
              </div>
              <h3 className="text-lg font-bold text-white mb-3">{f.title}</h3>
              <p className="text-sm text-gray-400 leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="relative rounded-2xl overflow-hidden border border-cyan-500/20 mb-8">
        <div className="absolute inset-0 bg-gradient-to-br from-cyan-950/50 via-transparent to-purple-950/30" />
        <div className="absolute inset-0 grid-bg opacity-20" />
        <div className="relative text-center py-16 px-8">
          <h2 className="text-4xl font-black text-white mb-4">Ready to battle?</h2>
          <p className="text-gray-400 mb-8 max-w-lg mx-auto">
            Connect your wallet, create your agent, and enter the arena. The AI decides the outcome — your strategy decides the victor.
          </p>
          <div className="flex gap-4 justify-center flex-wrap">
            <a href="/agents" className="btn-primary px-8 py-3 text-sm">
              Create Agent →
            </a>
            <a href="/leaderboard" className="btn-outline px-8 py-3 text-sm">
              View Leaderboard
            </a>
          </div>
        </div>
      </section>
    </div>
  );
}
