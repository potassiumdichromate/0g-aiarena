export default function HomePage() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[70vh] text-center gap-8">
      <div>
        <h1 className="text-5xl font-extrabold tracking-tight text-white sm:text-7xl">
          <span className="text-cyan-400">AI</span> Arena
        </h1>
        <p className="mt-4 text-xl text-gray-400 max-w-2xl mx-auto">
          Train, evolve, and battle AI agents on the 0G blockchain.
          Own your agent as an INFT. Earn rewards for superior strategy.
        </p>
      </div>

      <div className="flex gap-4 flex-wrap justify-center">
        <a
          href="/agents"
          className="rounded-xl bg-cyan-500 px-8 py-4 text-black font-bold text-lg hover:bg-cyan-400 transition-all shadow-lg shadow-cyan-500/20"
        >
          View Agents
        </a>
        <a
          href="/battle"
          className="rounded-xl border border-cyan-500/50 px-8 py-4 text-cyan-400 font-bold text-lg hover:border-cyan-400 hover:bg-cyan-950/50 transition-all"
        >
          Start Battle
        </a>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 mt-8 w-full max-w-3xl">
        {[
          { title: "5 Clans", desc: "CYBER, BIO, ARCANE, MECH, SHADOW" },
          { title: "0G Compute", desc: "Verifiable on-chain AI inference" },
          { title: "Real Ownership", desc: "ERC-721 INFTs on 0G Chain" },
        ].map((card) => (
          <div
            key={card.title}
            className="rounded-xl border border-gray-800 bg-gray-900/50 p-6 text-left"
          >
            <h3 className="text-lg font-semibold text-cyan-400">{card.title}</h3>
            <p className="mt-1 text-sm text-gray-400">{card.desc}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
