'use client';

/**
 * WalletButton
 *
 * - Not connected: shows "Connect Wallet" (Privy) + a "Dev Login" button for local dev
 * - Dev Login: calls /v1/auth/dev-login → stores JWT in localStorage → enables agent creation
 * - Connected: shows truncated address + opens internal wallet drawer
 */

import { useState } from 'react';
import { usePrivy } from '@privy-io/react-auth';
import { InternalWalletDrawer } from './InternalWalletDrawer';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';

function truncate(addr: string) {
  if (addr.startsWith('0xdev-')) return addr.replace('0xdev-', '').replace('-local', '') + ' (dev)';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function storeAuthData(data: {
  accessToken: string; refreshToken: string; expiresIn: number;
  userId: string; walletAddress: string; custodialSolanaAddress: string;
}) {
  localStorage.setItem('accessToken',            data.accessToken);
  localStorage.setItem('refreshToken',           data.refreshToken);
  localStorage.setItem('userId',                 data.userId);
  localStorage.setItem('walletAddress',          data.walletAddress);
  localStorage.setItem('custodialSolanaAddress', data.custodialSolanaAddress ?? '');
  localStorage.setItem('tokenExpiresAt',         String(Date.now() + data.expiresIn * 1000));
  window.dispatchEvent(new CustomEvent('ai-arena:login', { detail: data }));
}

export function WalletButton() {
  const { ready, authenticated, login, logout, user } = usePrivy();
  const [drawerOpen, setDrawerOpen]   = useState(false);
  const [devLogging, setDevLogging]   = useState(false);
  const [devLoggedIn, setDevLoggedIn] = useState(() => {
    if (typeof window === 'undefined') return false;
    const token   = localStorage.getItem('accessToken');
    const expires = localStorage.getItem('tokenExpiresAt');
    const wallet  = localStorage.getItem('walletAddress') ?? '';
    return !!(token && expires && Date.now() < parseInt(expires) && wallet.startsWith('0xdev-'));
  });

  const devWallet = typeof window !== 'undefined'
    ? localStorage.getItem('walletAddress') ?? ''
    : '';

  // ── Dev login handler ────────────────────────────────────────────────────────
  const handleDevLogin = async () => {
    setDevLogging(true);
    try {
      const res = await fetch(`${API_BASE}/v1/auth/dev-login`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ username: 'DevPlayer' }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err.error ?? 'Dev login failed — is the identity service running on port 8001?');
        return;
      }
      const data = await res.json();
      storeAuthData(data);
      setDevLoggedIn(true);
    } catch (e) {
      alert('Could not reach backend — make sure services are running (pnpm dev)');
    } finally {
      setDevLogging(false);
    }
  };

  const handleDevLogout = () => {
    localStorage.removeItem('accessToken');
    localStorage.removeItem('refreshToken');
    localStorage.removeItem('userId');
    localStorage.removeItem('walletAddress');
    localStorage.removeItem('custodialSolanaAddress');
    localStorage.removeItem('tokenExpiresAt');
    setDevLoggedIn(false);
    window.dispatchEvent(new CustomEvent('ai-arena:logout'));
  };

  // ── Dev-logged-in state ──────────────────────────────────────────────────────
  if (devLoggedIn && !authenticated) {
    return (
      <div className="flex items-center gap-2 ml-4">
        <div className="flex items-center gap-2 rounded-lg border border-yellow-500/40 bg-gray-900 px-3 py-2 text-xs font-semibold text-yellow-400">
          <span className="inline-block w-2 h-2 rounded-full bg-yellow-400" />
          {truncate(devWallet)}
        </div>
        <button
          onClick={handleDevLogout}
          className="rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-xs text-gray-500 hover:text-white hover:border-gray-500 transition-all"
          title="Dev logout"
        >
          ✕
        </button>
      </div>
    );
  }

  // ── Privy not ready ──────────────────────────────────────────────────────────
  if (!ready) {
    return (
      <button disabled className="ml-4 rounded-lg bg-gray-700 px-4 py-2 text-gray-400 font-semibold text-sm cursor-wait">
        Loading…
      </button>
    );
  }

  // ── Not authenticated ────────────────────────────────────────────────────────
  if (!authenticated) {
    return (
      <div className="flex items-center gap-2 ml-4">
        <button
          onClick={login}
          className="rounded-lg bg-cyan-500 px-4 py-2 text-black font-semibold text-sm hover:bg-cyan-400 transition-colors"
        >
          Connect Wallet
        </button>
        {/* Dev login — only shown in non-production */}
        {process.env.NODE_ENV !== 'production' && (
          <button
            onClick={handleDevLogin}
            disabled={devLogging}
            className="rounded-lg border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-xs font-bold text-yellow-400 hover:bg-yellow-500/20 transition-all disabled:opacity-50"
            title="Quick dev login — bypasses Privy for local testing"
          >
            {devLogging ? '…' : '⚡ Dev'}
          </button>
        )}
      </div>
    );
  }

  // ── Privy authenticated ──────────────────────────────────────────────────────
  const evmWallet = user?.linkedAccounts?.find((a) => a.type === 'wallet');
  const address   = (evmWallet as any)?.address ?? '';

  return (
    <>
      <button
        onClick={() => setDrawerOpen(true)}
        className="ml-4 flex items-center gap-2 rounded-lg border border-cyan-500/40 bg-gray-900 px-4 py-2 text-sm font-semibold text-cyan-400 hover:border-cyan-400 hover:bg-gray-800 transition-all"
      >
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
