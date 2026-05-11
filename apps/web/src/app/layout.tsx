import type { Metadata } from 'next';
import './globals.css';
import { PrivyProvider } from '../providers/privy-provider';
import { WalletButton }  from '../components/WalletButton';

export const metadata: Metadata = {
  title: 'AI Arena — Web3 AI Battle Platform',
  description: 'Train, evolve, and battle AI agents on the 0G blockchain',
  openGraph: {
    title:       'AI Arena',
    description: 'Train, evolve, and battle AI agents on the 0G blockchain',
    siteName:    'AI Arena',
  },
};

const NAV_LINKS = [
  { href: '/agents',      label: 'Agents' },
  { href: '/battle',      label: 'Battle' },
  { href: '/leaderboard', label: 'Leaderboard' },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen antialiased" style={{ background: 'var(--bg)', color: 'var(--text)' }}>
        <PrivyProvider>

          {/* Nav */}
          <nav
            className="sticky top-0 z-50 backdrop-blur-xl"
            style={{
              background: 'rgba(9,9,14,0.85)',
              borderBottom: '1px solid rgba(30,30,46,0.8)',
            }}
          >
            <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
              <div className="flex h-16 items-center justify-between">

                {/* Logo */}
                <a href="/" className="flex items-center gap-2 group">
                  <div
                    className="w-8 h-8 rounded-lg flex items-center justify-center text-sm font-black"
                    style={{
                      background: 'linear-gradient(135deg, #0891b2, #06b6d4)',
                      boxShadow: '0 0 20px rgba(6,182,212,0.3)',
                    }}
                  >
                    AI
                  </div>
                  <span className="text-lg font-bold text-white group-hover:text-cyan-400 transition-colors">
                    Arena
                  </span>
                </a>

                {/* Links */}
                <div className="hidden sm:flex items-center gap-1">
                  {NAV_LINKS.map((link) => (
                    <a
                      key={link.href}
                      href={link.href}
                      className="px-4 py-2 rounded-lg text-sm font-medium text-gray-400 hover:text-white hover:bg-white/5 transition-all"
                    >
                      {link.label}
                    </a>
                  ))}
                </div>

                {/* Right side */}
                <div className="flex items-center gap-3">
                  {/* Live indicator */}
                  <div className="hidden sm:flex items-center gap-1.5 text-xs text-gray-500">
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                    <span>devnet</span>
                  </div>
                  <WalletButton />
                </div>

              </div>
            </div>
          </nav>

          {/* Page content */}
          <main className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
            {children}
          </main>

          {/* Footer */}
          <footer
            className="mt-20 py-10 text-center text-xs"
            style={{ borderTop: '1px solid var(--border)', color: 'var(--text-muted)' }}
          >
            <div className="flex items-center justify-center gap-2 mb-2">
              <div
                className="w-5 h-5 rounded flex items-center justify-center text-[9px] font-black text-black"
                style={{ background: 'linear-gradient(135deg, #0891b2, #06b6d4)' }}
              >
                AI
              </div>
              <span className="font-semibold text-gray-400">AI Arena</span>
            </div>
            <p>© 2025 AI Arena — Powered by <span className="text-cyan-500">0G Blockchain</span></p>
            <p className="mt-1 text-gray-600">
              Inference: 0G Compute · Storage: 0G Storage · INFTs: ERC-7857 · Token: Solana
            </p>
          </footer>

        </PrivyProvider>
      </body>
    </html>
  );
}
