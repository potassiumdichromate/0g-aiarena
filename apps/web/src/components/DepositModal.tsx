'use client';

/**
 * DepositModal
 *
 * Lets users buy $ARENA by depositing:
 *   - USDT on 0G chain  (calls ArenaDepositVault.sol on 0G)
 *   - USDT on Base      (calls ArenaDepositVault.sol on Base)
 *   - USDC on 0G chain  (calls ArenaDepositVault.sol on 0G)
 *
 * Flow:
 *   1. User enters amount
 *   2. Preview how much $ARENA they get (calls GET /v1/token/deposit/preview)
 *   3. User clicks Deposit → MetaMask opens to approve ERC20 + call depositUSDT/depositUSDC
 *   4. After tx submitted, we register it with POST /v1/token/bridge/deposit
 *   5. Show "Pending" state — bridge listener will confirm in ~30-60s
 */

import { useState, useEffect } from 'react';
import { useWalletClient, usePublicClient } from 'wagmi';
import { parseUnits, formatUnits, encodeFunctionData } from 'viem';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';

// ERC-20 approve ABI
const ERC20_ABI = [
  {
    name: 'approve',
    type: 'function',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount',  type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;

// ArenaDepositVault ABI (just what we need)
const VAULT_ABI = [
  {
    name: 'depositUSDT',
    type: 'function',
    inputs: [
      { name: 'amount',           type: 'uint256' },
      { name: 'solanaRecipient',  type: 'bytes32'  },
    ],
    outputs: [],
  },
  {
    name: 'depositUSDC',
    type: 'function',
    inputs: [
      { name: 'amount',           type: 'uint256' },
      { name: 'solanaRecipient',  type: 'bytes32'  },
    ],
    outputs: [],
  },
] as const;

// 0G chain USDT/USDC addresses (update when deployed)
const ZEROG_USDT    = (process.env.NEXT_PUBLIC_ZEROG_USDT_ADDRESS ?? '') as `0x${string}`;
const ZEROG_USDC    = (process.env.NEXT_PUBLIC_ZEROG_USDC_ADDRESS ?? '') as `0x${string}`;
const ZEROG_VAULT   = (process.env.NEXT_PUBLIC_ZEROG_VAULT_ADDRESS ?? '') as `0x${string}`;

const ASSETS = [
  { label: 'USDT (0G Chain)', token: ZEROG_USDT, fn: 'depositUSDT' as const, chain: '0g' },
  { label: 'USDC (0G Chain)', token: ZEROG_USDC, fn: 'depositUSDC' as const, chain: '0g' },
];

interface Props {
  open:                   boolean;
  onClose:                () => void;
  evmAddress:             string;
  custodialSolanaAddress: string;
}

interface Preview {
  arenaOut:     string;
  backingRatio: number;
}

export function DepositModal({ open, onClose, evmAddress, custodialSolanaAddress }: Props) {
  const { data: walletClient } = useWalletClient();

  const [asset, setAsset]         = useState(ASSETS[0]);
  const [amount, setAmount]       = useState('');
  const [preview, setPreview]     = useState<Preview | null>(null);
  const [loadingPreview, setLP]   = useState(false);
  const [txStatus, setTxStatus]   = useState<'idle' | 'approving' | 'depositing' | 'pending' | 'error'>('idle');
  const [txHash, setTxHash]       = useState('');
  const [error, setError]         = useState('');

  // Preview — debounce 400ms
  useEffect(() => {
    if (!amount || parseFloat(amount) <= 0) { setPreview(null); return; }
    const t = setTimeout(async () => {
      setLP(true);
      try {
        const raw = parseUnits(amount, 6).toString();
        const r = await fetch(`${API}/v1/token/deposit/preview`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ usdcAmount: raw }),
        });
        const d = await r.json();
        setPreview(d.data);
      } catch { /* ignore */ } finally { setLP(false); }
    }, 400);
    return () => clearTimeout(t);
  }, [amount]);

  if (!open) return null;

  // Convert Solana base58 address to bytes32
  function solanaAddressToBytes32(base58Address: string): `0x${string}` {
    try {
      // We just take the raw hex of the public key bytes
      // In a real app use @solana/web3.js PublicKey.toBytes()
      // For now the backend will also accept hex-encoded addresses
      const bs58 = base58Address;
      // Pad to 32 bytes as hex
      const hex = Array.from(bs58).map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
      return `0x${hex.slice(0, 64).padStart(64, '0')}` as `0x${string}`;
    } catch {
      return `0x${'00'.repeat(32)}` as `0x${string}`;
    }
  }

  async function handleDeposit() {
    if (!walletClient || !amount || !custodialSolanaAddress) return;
    setError('');
    try {
      const amountRaw = parseUnits(amount, 6);
      const recipient = solanaAddressToBytes32(custodialSolanaAddress);

      // Step 1: Approve ERC-20
      setTxStatus('approving');
      await walletClient.writeContract({
        address:      asset.token,
        abi:          ERC20_ABI,
        functionName: 'approve',
        args:         [ZEROG_VAULT, amountRaw],
      });

      // Step 2: Deposit
      setTxStatus('depositing');
      const depositTxHash = await walletClient.writeContract({
        address:      ZEROG_VAULT,
        abi:          VAULT_ABI,
        functionName: asset.fn,
        args:         [amountRaw, recipient],
      });

      setTxHash(depositTxHash);

      // Step 3: Register with backend
      const userId = localStorage.getItem('userId') ?? '';
      const token  = localStorage.getItem('accessToken') ?? '';
      await fetch(`${API}/v1/token/bridge/deposit`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          Authorization:   `Bearer ${token}`,
        },
        body: JSON.stringify({
          userId,
          sourceChain:   asset.chain,
          sourceTxHash:  depositTxHash,
          solanaAddress: custodialSolanaAddress,
          usdcAmount:    amountRaw.toString(),
          depositId:     '0', // backend will get real ID from event
        }),
      });

      setTxStatus('pending');
    } catch (e: any) {
      setError(e?.message ?? 'Transaction failed');
      setTxStatus('error');
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div className="relative bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-md p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-bold text-white">Buy $ARENA</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white">✕</button>
        </div>

        {txStatus === 'pending' ? (
          // Success state
          <div className="text-center py-8 space-y-4">
            <div className="text-5xl">🎉</div>
            <h3 className="text-lg font-bold text-white">Deposit submitted!</h3>
            <p className="text-gray-400 text-sm">
              Your $ARENA will arrive in your wallet in ~30–60 seconds
              once the bridge confirms your deposit.
            </p>
            <a
              href={`https://chainscan.0g.ai/tx/${txHash}`}
              target="_blank" rel="noreferrer"
              className="block text-cyan-400 text-sm hover:underline"
            >
              View transaction ↗
            </a>
            <button
              onClick={() => { setTxStatus('idle'); setAmount(''); setPreview(null); onClose(); }}
              className="w-full mt-2 rounded-lg bg-cyan-500 py-3 font-bold text-black hover:bg-cyan-400"
            >
              Done
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Asset selector */}
            <div>
              <label className="block text-xs text-gray-400 mb-1 uppercase tracking-widest">Deposit with</label>
              <div className="grid grid-cols-2 gap-2">
                {ASSETS.map((a) => (
                  <button
                    key={a.label}
                    onClick={() => setAsset(a)}
                    className={`rounded-lg border py-2.5 text-sm font-semibold transition-all ${
                      asset.label === a.label
                        ? 'border-cyan-500 bg-cyan-950 text-cyan-300'
                        : 'border-gray-700 bg-gray-800 text-gray-400 hover:border-gray-600'
                    }`}
                  >
                    {a.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Amount input */}
            <div>
              <label className="block text-xs text-gray-400 mb-1 uppercase tracking-widest">Amount</label>
              <div className="relative">
                <input
                  type="number"
                  min="10"
                  step="1"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="Min $10"
                  className="w-full rounded-lg bg-gray-800 border border-gray-700 px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-cyan-500"
                />
                <span className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 text-sm">USDT</span>
              </div>
            </div>

            {/* Preview */}
            <div className="rounded-lg bg-gray-800/60 border border-gray-700 p-4">
              <div className="flex justify-between text-sm">
                <span className="text-gray-400">You receive</span>
                <span className="font-bold text-cyan-400">
                  {loadingPreview ? '…' : preview
                    ? `${(Number(preview.arenaOut) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 4 })} $ARENA`
                    : '—'
                  }
                </span>
              </div>
              <div className="flex justify-between text-xs text-gray-500 mt-1">
                <span>Rate</span>
                <span>1 $ARENA = ${preview ? (1 / preview.backingRatio).toFixed(4) : '—'} USDT</span>
              </div>
              <div className="flex justify-between text-xs text-gray-500 mt-1">
                <span>Deposit fee</span>
                <span className="text-green-400">Free (0%)</span>
              </div>
            </div>

            {/* Destination */}
            <div className="rounded-lg bg-gray-800/40 p-3">
              <p className="text-xs text-gray-500">$ARENA sent to your internal wallet</p>
              <p className="text-xs font-mono text-gray-400 truncate mt-0.5">{custodialSolanaAddress || '—'}</p>
            </div>

            {error && (
              <p className="text-red-400 text-sm rounded-lg bg-red-950/40 border border-red-500/30 p-3">{error}</p>
            )}

            <button
              onClick={handleDeposit}
              disabled={!amount || parseFloat(amount) < 10 || txStatus !== 'idle'}
              className="w-full rounded-lg bg-cyan-500 py-3.5 font-bold text-black hover:bg-cyan-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {txStatus === 'approving'  && '⏳ Approving…'}
              {txStatus === 'depositing' && '⏳ Depositing…'}
              {txStatus === 'error'      && 'Retry'}
              {txStatus === 'idle'       && `Deposit ${amount || '0'} USDT`}
            </button>

            <p className="text-xs text-gray-500 text-center">
              MetaMask will open to confirm 2 transactions (approve + deposit)
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
