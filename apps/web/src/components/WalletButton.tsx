'use client';

/**
 * WalletButton
 *
 * - Not connected: shows "Connect Wallet" → opens Privy modal (MetaMask first)
 * - Connected: shows truncated address + opens internal wallet drawer
 */

import { useState } from 'react';
import { usePrivy } from '@privy-io/react-auth';
import { InternalWalletDrawer } from './InternalWalletDrawer';

function truncate(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function WalletButton() {
  const { ready, authenticated, login, logout, user } = usePrivy();
  const [drawerOpen, setDrawerOpen] = useState(false);

  if (!ready) {
    return (
      <button disabled className="ml-4 rounded-lg bg-gray-700 px-4 py-2 text-gray-400 font-semibold text-sm cursor-wait">
        Loading…
      </button>
    );
  }

  if (!authenticated) {
    return (
      <button
        onClick={login}
        className="ml-4 rounded-lg bg-cyan-500 px-4 py-2 text-black font-semibold text-sm hover:bg-cyan-400 transition-colors"
      >
        Connect Wallet
      </button>
    );
  }

  const evmWallet = user?.linkedAccounts?.find(
    (a) => a.type === 'wallet',
  );
  const address = (evmWallet as any)?.address ?? '';

  return (
    <>
      <button
        onClick={() => setDrawerOpen(true)}
        className="ml-4 flex items-center gap-2 rounded-lg border border-cyan-500/40 bg-gray-900 px-4 py-2 text-sm font-semibold text-cyan-400 hover:border-cyan-400 hover:bg-gray-800 transition-all"
      >
        {/* Green dot */}
        <span className="inline-block w-2 h-2 rounded-full bg-green-400" />
        {address ? truncate(address) : 'Connected'}
      </button>

      <InternalWalletDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        evmAddress={address}
      />
    </>
  );
}
