import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Arena — Web3 AI Battle Platform",
  description: "Train, evolve, and battle AI agents on the 0G blockchain",
  openGraph: {
    title: "AI Arena",
    description: "Train, evolve, and battle AI agents on the 0G blockchain",
    siteName: "AI Arena",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-gray-950 text-gray-100 antialiased">
        <nav className="border-b border-gray-800 bg-gray-900/80 backdrop-blur sticky top-0 z-50">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="flex h-16 items-center justify-between">
              <a href="/" className="text-xl font-bold text-cyan-400 tracking-tight">
                AI Arena
              </a>
              <div className="flex items-center gap-6 text-sm font-medium text-gray-400">
                <a href="/agents" className="hover:text-white transition-colors">Agents</a>
                <a href="/battle" className="hover:text-white transition-colors">Battle</a>
                <a href="/leaderboard" className="hover:text-white transition-colors">Leaderboard</a>
                <button className="ml-4 rounded-lg bg-cyan-500 px-4 py-2 text-black font-semibold hover:bg-cyan-400 transition-colors">
                  Connect Wallet
                </button>
              </div>
            </div>
          </div>
        </nav>
        <main className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8">
          {children}
        </main>
        <footer className="border-t border-gray-800 mt-16 py-8 text-center text-gray-600 text-sm">
          AI Arena &copy; 2025 — Powered by 0G
        </footer>
      </body>
    </html>
  );
}
