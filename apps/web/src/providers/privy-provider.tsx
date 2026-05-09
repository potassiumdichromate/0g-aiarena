'use client';

/**
 * PrivyProvider
 *
 * Wraps the app with Privy auth + wagmi.
 * Configured for 0G chain (chainId 16661) as the primary network.
 * MetaMask is the default wallet, WalletConnect as fallback.
 *
 * After Privy login, we exchange the Privy token for our own JWT
 * via POST /v1/auth/privy — all subsequent API calls use that JWT.
 */

import { PrivyProvider as BasePrivyProvider } from '@privy-io/react-auth';
import { ReactNode, useEffect } from 'react';
import { usePrivy } from '@privy-io/react-auth';
import { apiClient } from '../lib/api-client';

// 0G chain definition for wagmi/viem
const zeroGChain = {
  id:   16661,
  name: '0G Chain',
  nativeCurrency: { name: '0G', symbol: '0G', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://evmrpc.0g.ai'] },
    public:  { http: ['https://evmrpc.0g.ai'] },
  },
  blockExplorers: {
    default: { name: '0G Explorer', url: 'https://chainscan.0g.ai' },
  },
};

// ── Auto-login: exchange Privy token for our JWT after auth ──────────────────

export function PrivyAuthSync({ children }: { children: ReactNode }) {
  const { ready, authenticated, getAccessToken, user } = usePrivy();

  useEffect(() => {
    if (!ready || !authenticated) return;

    // Only exchange if we don't already have a valid JWT
    const existing = localStorage.getItem('accessToken');
    const expires  = localStorage.getItem('tokenExpiresAt');
    if (existing && expires && Date.now() < parseInt(expires)) return;

    (async () => {
      try {
        const privyToken = await getAccessToken();
        if (!privyToken) return;

        const res = await fetch(
          `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000'}/v1/auth/privy`,
          {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ accessToken: privyToken }),
          },
        );

        if (!res.ok) return;
        const data = await res.json();

        localStorage.setItem('accessToken',           data.accessToken);
        localStorage.setItem('refreshToken',          data.refreshToken);
        localStorage.setItem('userId',                data.userId);
        localStorage.setItem('walletAddress',         data.walletAddress);
        localStorage.setItem('custodialSolanaAddress', data.custodialSolanaAddress ?? '');
        localStorage.setItem('tokenExpiresAt', String(Date.now() + data.expiresIn * 1000));

        // Emit so any component can react
        window.dispatchEvent(new CustomEvent('ai-arena:login', { detail: data }));
      } catch (e) {
        console.error('[PrivyAuthSync] Failed to exchange token:', e);
      }
    })();
  }, [ready, authenticated, user]);

  return <>{children}</>;
}

// ── Root provider ─────────────────────────────────────────────────────────────

export function PrivyProvider({ children }: { children: ReactNode }) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  if (!appId) {
    console.warn('[Privy] NEXT_PUBLIC_PRIVY_APP_ID not set — auth will not work');
  }

  return (
    <BasePrivyProvider
      appId={appId ?? 'clxxxxxxxxxxxxxxxxxxxxxx'}
      config={{
        appearance: {
          theme:       'dark',
          accentColor: '#06b6d4', // cyan-500
          logo:        '/logo.png',
        },
        loginMethods: ['wallet', 'email'],
        defaultChain: zeroGChain as any,
        supportedChains: [zeroGChain as any],
        embeddedWallets: {
          createOnLogin: 'off', // We manage custodial wallets server-side
        },
        // Show MetaMask first
        walletConnectCloudProjectId: process.env.NEXT_PUBLIC_WC_PROJECT_ID,
      }}
    >
      <PrivyAuthSync>
        {children}
      </PrivyAuthSync>
    </BasePrivyProvider>
  );
}
