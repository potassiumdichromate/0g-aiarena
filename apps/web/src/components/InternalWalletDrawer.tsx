'use client';

/**
 * InternalWalletDrawer
 *
 * Stake.com-style side panel showing:
 *   - User's $ARENA balance + USD value
 *   - Custodial Solana address (the internal wallet)
 *   - Deposit button (opens DepositModal)
 *   - Withdraw button (Phase 2)
 *   - MetaMask / 0G EVM address
 *   - Disconnect option
 */

import { useEffect, useState } from 'react';
import { usePrivy }            from '@privy-io/react-auth';
import { DepositModal }        from './DepositModal';

interface Props {
  open:       boolean;
  onClose:    () => void;
  evmAddress: string;
}

interface ArenaBalance {
  raw:           string;
  human:         number;
  usdcEquivalent: number;
}

interface TokenPrice {
  backingRatioHuman: number;
}

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';

export function InternalWalletDrawer({ open, onClose, evmAddress }: Props) {
  const { logout } = usePrivy();
  const [balance, setBalance]           = useState<ArenaBalance | null>(null);
  const [price, setPrice]               = useState<TokenPrice | null>(null);
  const [depositOpen, setDepositOpen]   = useState(false);
  const [loading, setLoading]           = useState(false);

  const custodialAddr = typeof window !== 'undefined'
    ? localStorage.getItem('custodialSolanaAddress') ?? ''
    : '';

  useEffect(() => {
    if (!open || !custodialAddr) return;
    setLoading(true);

    Promise.all([
      fetch(`${API}/v1/token/balance/${custodialAddr}`).then(r => r.json()),
      fetch(`${API}/v1/token/price`).then(r => r.json()),
    ])
      .then(([bal, prc]) => {
        setBalance(bal.data);
        setPrice(prc.data);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [open, custodialAddr]);

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40"
        onClick={onClose}
      />

      {/* Drawer */}
      <div className="fixed right-0 top-0 h-full w-80 bg-gray-900 border-l border-gray-800 z-50 flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-gray-800">
          <h2 className="text-lg font-bold text-white">Wallet</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xl">✕</button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">

          {/* $ARENA balance card */}
          <div className="rounded-xl bg-gradient-to-br from-cyan-950 to-gray-800 border border-cyan-500/30 p-5">
            <p className="text-xs text-gray-400 uppercase tracking-widest mb-1">$ARENA Balance</p>
            {loading ? (
              <div className="h-8 w-32 bg-gray-700 rounded animate-pulse" />
            ) : (
              <>
                <p className="text-3xl font-extrabold text-cyan-400">
                  {balance ? balance.human.toLocaleString(undefined, { maximumFractionDigits: 4 }) : '—'}
                </p>
                <p className="text-sm text-gray-400 mt-1">
                  ≈ ${balance ? balance.usdcEquivalent.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '0.00'} USD
                </p>
                <p className="text-xs text-gray-500 mt-0.5">
                  1 $ARENA = ${price ? price.backingRatioHuman.toFixed(4) : '—'} USDC
                </p>
              </>
            )}
          </div>

          {/* Action buttons */}
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => setDepositOpen(true)}
              className="rounded-lg bg-cyan-500 py-3 text-sm font-bold text-black hover:bg-cyan-400 transition-colors"
            >
              ↓ Deposit
            </button>
            <button
              disabled
              title="Coming soon"
              className="rounded-lg border border-gray-700 py-3 text-sm font-semibold text-gray-500 cursor-not-allowed"
            >
              ↑ Withdraw
            </button>
          </div>

          {/* EVM wallet */}
          <div className="rounded-lg bg-gray-800/60 p-4 space-y-1">
            <p className="text-xs text-gray-500 uppercase tracking-widest">0G Wallet (MetaMask)</p>
            <p className="text-xs font-mono text-gray-300 break-all">{evmAddress || '—'}</p>
            <a
              href={`https://chainscan.0g.ai/address/${evmAddress}`}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-cyan-500 hover:underline"
            >
              View on Explorer ↗
            </a>
          </div>

          {/* Custodial Solana wallet */}
          <div className="rounded-lg bg-gray-800/60 p-4 space-y-1">
            <p className="text-xs text-gray-500 uppercase tracking-widest">$ARENA Wallet (Solana)</p>
            <p className="text-xs font-mono text-gray-300 break-all">{custodialAddr || '—'}</p>
            <p className="text-xs text-gray-500">Managed by AI Arena • holds your $ARENA</p>
            {custodialAddr && (
              <a
                href={`https://solscan.io/account/${custodialAddr}`}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-cyan-500 hover:underline"
              >
                View on Solscan ↗
              </a>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="p-5 border-t border-gray-800">
          <button
            onClick={() => {
              localStorage.clear();
              logout();
              onClose();
            }}
            className="w-full rounded-lg border border-red-500/40 py-2.5 text-sm font-semibold text-red-400 hover:bg-red-950/40 transition-colors"
          >
            Disconnect
          </button>
        </div>
      </div>

      {/* Deposit Modal */}
      <DepositModal
        open={depositOpen}
        onClose={() => setDepositOpen(false)}
        evmAddress={evmAddress}
        custodialSolanaAddress={custodialAddr}
      />
    </>
  );
}
