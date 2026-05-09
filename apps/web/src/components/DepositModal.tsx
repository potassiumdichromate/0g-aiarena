'use client';

/**
 * DepositModal — Buy $ARENA
 *
 * Four deposit methods:
 *   1. USDT on Base mainnet   (chainId 8453)  — ERC-20 approve + depositUSDT
 *   2. USDC on Base mainnet   (chainId 8453)  — ERC-20 approve + depositUSDC
 *   3. 0G native token        (chainId 16661) — payable depositNative
 *   4. Solana                 — send USDC-SPL or SOL from Phantom to custodial wallet
 *
 * All EVM deposits call ArenaDepositVault which emits DepositQueued.
 * The backend bridge listener picks it up and mints $ARENA in ~30-60s.
 *
 * Solana deposits: user sends to their custodial wallet directly from Phantom.
 * The backend Solana watcher credits $ARENA when it detects the transfer.
 */

import { useState, useEffect, useRef } from 'react';
import { useWalletClient, useChainId, useSwitchChain } from 'wagmi';
import { parseUnits, parseEther, encodeFunctionData } from 'viem';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';

// ── Chain IDs ─────────────────────────────────────────────────────────────────
const BASE_CHAIN_ID  = 8453;
const ZEROG_CHAIN_ID = 16661;

// ── Contract addresses ────────────────────────────────────────────────────────
// Base mainnet (official Circle / Tether addresses — verified)
const BASE_USDT  = (process.env.NEXT_PUBLIC_BASE_USDT_ADDRESS  ?? '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2') as `0x${string}`;
const BASE_USDC  = (process.env.NEXT_PUBLIC_BASE_USDC_ADDRESS  ?? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913') as `0x${string}`;
const BASE_VAULT = (process.env.NEXT_PUBLIC_BASE_VAULT_ADDRESS ?? '') as `0x${string}`;
const ZEROG_VAULT = (process.env.NEXT_PUBLIC_ZEROG_VAULT_ADDRESS ?? '') as `0x${string}`;

// Solana USDC-SPL mainnet mint
const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// ── ABIs ──────────────────────────────────────────────────────────────────────
const ERC20_ABI = [
  { name: 'approve',   type: 'function', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { name: 'allowance', type: 'function', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

const VAULT_ERC20_ABI = [
  { name: 'depositUSDT', type: 'function', inputs: [{ name: 'amount', type: 'uint256' }, { name: 'solanaRecipient', type: 'bytes32' }], outputs: [] },
  { name: 'depositUSDC', type: 'function', inputs: [{ name: 'amount', type: 'uint256' }, { name: 'solanaRecipient', type: 'bytes32' }], outputs: [] },
] as const;

const VAULT_NATIVE_ABI = [
  { name: 'depositNative', type: 'function', inputs: [{ name: 'solanaRecipient', type: 'bytes32' }], outputs: [], stateMutability: 'payable' },
] as const;

// ── Types ─────────────────────────────────────────────────────────────────────

type DepositMethod = 'usdt-base' | 'usdc-base' | 'zerog-native' | 'solana';

interface Preview { arenaOut: string; backingRatio: number; }

interface Props {
  open:                   boolean;
  onClose:                () => void;
  evmAddress:             string;
  custodialSolanaAddress: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Encode a Solana base58 address as bytes32 for the vault contract */
function solanaToBytes32(base58: string): `0x${string}` {
  // Decode base58 → bytes → left-pad to 32 bytes
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let num = 0n;
  for (const char of base58) {
    const idx = ALPHABET.indexOf(char);
    if (idx < 0) throw new Error('invalid base58 char');
    num = num * 58n + BigInt(idx);
  }
  const hex = num.toString(16).padStart(64, '0');
  return `0x${hex}` as `0x${string}`;
}

function truncate(s: string, n = 8) {
  return s.length > n * 2 ? `${s.slice(0, n)}…${s.slice(-n)}` : s;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function DepositModal({ open, onClose, evmAddress, custodialSolanaAddress }: Props) {
  const { data: walletClient }      = useWalletClient();
  const chainId                     = useChainId();
  const { switchChain }             = useSwitchChain();

  const [method, setMethod]         = useState<DepositMethod>('usdt-base');
  const [amount, setAmount]         = useState('');
  const [preview, setPreview]       = useState<Preview | null>(null);
  const [loadingPreview, setLP]     = useState(false);
  const [status, setStatus]         = useState<'idle' | 'switching' | 'approving' | 'depositing' | 'done' | 'error'>('idle');
  const [txHash, setTxHash]         = useState('');
  const [error, setError]           = useState('');
  const [copied, setCopied]         = useState(false);

  // Debounced preview fetch
  useEffect(() => {
    if (!amount || parseFloat(amount) <= 0 || method === 'solana') {
      setPreview(null); return;
    }
    const t = setTimeout(async () => {
      setLP(true);
      try {
        // Convert to 6-decimal USDC units for preview
        // For 0G native: pass raw amount as-is, backend handles conversion
        const decimals = method === 'zerog-native' ? 18 : 6;
        const raw = (BigInt(Math.round(parseFloat(amount) * 10 ** decimals))).toString();
        const r = await fetch(`${API}/v1/token/deposit/preview`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ usdcAmount: raw }),
        });
        const d = await r.json();
        setPreview(d.data);
      } catch { /* ignore */ }
      finally { setLP(false); }
    }, 500);
    return () => clearTimeout(t);
  }, [amount, method]);

  if (!open) return null;

  // ── Method config ───────────────────────────────────────────────────────────

  const methods: { id: DepositMethod; label: string; sublabel: string; chain: number; symbol: string }[] = [
    { id: 'usdt-base',    label: 'USDT',    sublabel: 'Base mainnet', chain: BASE_CHAIN_ID,  symbol: 'USDT' },
    { id: 'usdc-base',    label: 'USDC',    sublabel: 'Base mainnet', chain: BASE_CHAIN_ID,  symbol: 'USDC' },
    { id: 'zerog-native', label: '0G',      sublabel: '0G mainnet',   chain: ZEROG_CHAIN_ID, symbol: '0G'   },
    { id: 'solana',       label: 'Solana',  sublabel: 'Phantom/any',  chain: 0,              symbol: 'SOL/USDC' },
  ];

  const selected = methods.find(m => m.id === method)!;
  const needsChainSwitch = selected.chain !== 0 && chainId !== selected.chain;

  // ── Copy to clipboard ───────────────────────────────────────────────────────

  async function copy(text: string) {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  // ── Register deposit with backend ───────────────────────────────────────────

  async function registerDeposit(hash: string, rawAmount: string, chain: string) {
    const userId = localStorage.getItem('userId') ?? '';
    const token  = localStorage.getItem('accessToken') ?? '';
    await fetch(`${API}/v1/token/bridge/deposit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        userId, sourceChain: chain, sourceTxHash: hash,
        solanaAddress: custodialSolanaAddress,
        usdcAmount: rawAmount, depositId: '0',
      }),
    }).catch(() => {/* non-blocking */});
  }

  // ── EVM deposit handler ─────────────────────────────────────────────────────

  async function handleEVMDeposit() {
    if (!walletClient || !amount || !custodialSolanaAddress) return;
    setError(''); setStatus('idle');

    try {
      // 1. Switch chain if needed
      if (needsChainSwitch) {
        setStatus('switching');
        await switchChain({ chainId: selected.chain });
        await new Promise(r => setTimeout(r, 1500)); // let wagmi settle
      }

      const recipient = solanaToBytes32(custodialSolanaAddress);

      if (method === 'zerog-native') {
        // ── 0G native token ───────────────────────────────────────────────────
        if (!ZEROG_VAULT) throw new Error('ZEROG_VAULT address not set in env');
        setStatus('depositing');
        const value = parseEther(amount);
        const hash = await walletClient.writeContract({
          address: ZEROG_VAULT, abi: VAULT_NATIVE_ABI,
          functionName: 'depositNative', args: [recipient], value,
        });
        setTxHash(hash);
        await registerDeposit(hash, value.toString(), '0g');

      } else {
        // ── Base ERC-20 (USDT or USDC) ────────────────────────────────────────
        if (!BASE_VAULT) throw new Error('BASE_VAULT address not set in env');
        const token = method === 'usdt-base' ? BASE_USDT : BASE_USDC;
        const fnName = method === 'usdt-base' ? 'depositUSDT' : 'depositUSDC';
        const rawAmt = parseUnits(amount, 6);

        setStatus('approving');
        await walletClient.writeContract({
          address: token, abi: ERC20_ABI,
          functionName: 'approve', args: [BASE_VAULT, rawAmt],
        });

        setStatus('depositing');
        const hash = await walletClient.writeContract({
          address: BASE_VAULT, abi: VAULT_ERC20_ABI,
          functionName: fnName, args: [rawAmt, recipient],
        });
        setTxHash(hash);
        await registerDeposit(hash, rawAmt.toString(), 'base');
      }

      setStatus('done');
    } catch (e: any) {
      setError(e?.shortMessage ?? e?.message ?? 'Transaction failed');
      setStatus('error');
    }
  }

  // ── Explorer URL ────────────────────────────────────────────────────────────

  function explorerUrl(hash: string) {
    if (method === 'zerog-native') return `https://chainscan.0g.ai/tx/${hash}`;
    return `https://basescan.org/tx/${hash}`;
  }

  // ── UI ──────────────────────────────────────────────────────────────────────

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />

      <div className="relative bg-gray-900 border border-gray-800 rounded-2xl w-full max-w-md shadow-2xl max-h-[90vh] overflow-y-auto">

        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-gray-800 sticky top-0 bg-gray-900 z-10">
          <div>
            <h2 className="text-xl font-bold text-white">Buy $ARENA</h2>
            <p className="text-xs text-gray-500 mt-0.5">Deposit → get $ARENA in your wallet</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xl w-8 h-8 flex items-center justify-center">✕</button>
        </div>

        {status === 'done' ? (
          // ── Success state ────────────────────────────────────────────────────
          <div className="p-6 text-center space-y-4">
            <div className="text-5xl">🎉</div>
            <h3 className="text-lg font-bold text-white">Deposit submitted!</h3>
            <p className="text-sm text-gray-400">
              $ARENA will appear in your wallet within <strong className="text-white">30–60 seconds</strong> once the bridge confirms.
            </p>
            {txHash && (
              <a href={explorerUrl(txHash)} target="_blank" rel="noreferrer"
                className="block text-cyan-400 text-sm hover:underline font-mono">
                {truncate(txHash, 10)} ↗
              </a>
            )}
            <button onClick={() => { setStatus('idle'); setAmount(''); setPreview(null); onClose(); }}
              className="w-full rounded-lg bg-cyan-500 py-3 font-bold text-black hover:bg-cyan-400">
              Done
            </button>
          </div>
        ) : (
          <div className="p-5 space-y-5">

            {/* Method selector */}
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-widest mb-2">Deposit with</p>
              <div className="grid grid-cols-4 gap-2">
                {methods.map(m => (
                  <button key={m.id} onClick={() => { setMethod(m.id); setAmount(''); setPreview(null); setError(''); setStatus('idle'); }}
                    className={`rounded-xl border p-2.5 text-center transition-all ${
                      method === m.id
                        ? 'border-cyan-500 bg-cyan-950/60 text-white'
                        : 'border-gray-700 bg-gray-800/40 text-gray-400 hover:border-gray-600'
                    }`}>
                    <p className="text-sm font-bold">{m.label}</p>
                    <p className="text-[10px] mt-0.5 text-gray-500">{m.sublabel}</p>
                  </button>
                ))}
              </div>
            </div>

            {/* Chain switch warning */}
            {needsChainSwitch && (
              <div className="rounded-lg bg-yellow-950/40 border border-yellow-500/30 p-3 flex items-center gap-2">
                <span className="text-yellow-400 text-lg">⚠</span>
                <p className="text-xs text-yellow-300">
                  MetaMask will switch to <strong>{selected.sublabel}</strong> when you deposit.
                </p>
              </div>
            )}

            {/* ── Solana method ──────────────────────────────────────────────── */}
            {method === 'solana' ? (
              <div className="space-y-4">
                <div className="rounded-xl bg-gradient-to-br from-purple-950/60 to-gray-800 border border-purple-500/30 p-4">
                  <p className="text-xs text-gray-400 uppercase tracking-widest mb-2">Send to your $ARENA wallet</p>
                  <p className="text-xs text-gray-500 mb-3">
                    Open Phantom / Backpack / any Solana wallet and send <strong className="text-white">USDC-SPL or SOL</strong> directly to your internal $ARENA wallet address below.
                    We'll credit your $ARENA balance automatically.
                  </p>

                  {/* Address */}
                  <div className="rounded-lg bg-gray-900 border border-gray-700 p-3 space-y-1">
                    <p className="text-[10px] text-gray-500 uppercase tracking-widest">Your $ARENA wallet (Solana)</p>
                    <p className="font-mono text-xs text-white break-all">{custodialSolanaAddress || 'Loading…'}</p>
                    <button onClick={() => copy(custodialSolanaAddress)}
                      className="mt-1 text-xs text-cyan-400 hover:underline">
                      {copied ? '✓ Copied!' : 'Copy address'}
                    </button>
                  </div>

                  {/* USDC-SPL info */}
                  <div className="mt-3 rounded-lg bg-gray-900/60 border border-gray-700 p-3">
                    <p className="text-[10px] text-gray-500 uppercase tracking-widest mb-1">Accepted tokens</p>
                    <div className="flex flex-col gap-1.5">
                      <div className="flex items-center gap-2">
                        <span className="text-green-400 text-xs">●</span>
                        <span className="text-xs text-gray-300">
                          <strong>USDC-SPL</strong>
                          <span className="text-gray-500 ml-1 font-mono text-[10px]">{truncate(SOLANA_USDC_MINT, 6)}</span>
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-purple-400 text-xs">●</span>
                        <span className="text-xs text-gray-300"><strong>SOL</strong> (native Solana)</span>
                      </div>
                    </div>
                  </div>

                  <p className="text-[10px] text-gray-500 mt-3">
                    ⏱ Credits in ~60 seconds after confirmation on Solana.
                    Minimum: $10 equivalent.
                  </p>
                </div>
              </div>

            ) : (
              // ── EVM method (Base USDT/USDC or 0G native) ────────────────────
              <div className="space-y-4">

                {/* Amount input */}
                <div>
                  <div className="flex justify-between mb-1">
                    <label className="text-xs text-gray-500 uppercase tracking-widest">Amount</label>
                    <span className="text-xs text-gray-500">
                      Min: {method === 'zerog-native' ? '0.1 0G' : '$10'}
                    </span>
                  </div>
                  <div className="relative">
                    <input
                      type="number"
                      min={method === 'zerog-native' ? '0.1' : '10'}
                      step={method === 'zerog-native' ? '0.1' : '1'}
                      value={amount}
                      onChange={e => setAmount(e.target.value)}
                      placeholder={method === 'zerog-native' ? 'e.g. 10' : 'e.g. 100'}
                      className="w-full rounded-lg bg-gray-800 border border-gray-700 px-4 py-3 text-white placeholder-gray-600 focus:outline-none focus:border-cyan-500"
                    />
                    <span className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-400 text-sm font-semibold">
                      {selected.symbol}
                    </span>
                  </div>
                </div>

                {/* Preview */}
                <div className="rounded-lg bg-gray-800/60 border border-gray-700 p-4 space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-400">You receive</span>
                    <span className="font-bold text-cyan-400">
                      {loadingPreview ? (
                        <span className="inline-block w-20 h-4 bg-gray-700 rounded animate-pulse" />
                      ) : preview ? (
                        `${(Number(preview.arenaOut) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 4 })} $ARENA`
                      ) : '—'}
                    </span>
                  </div>
                  {method === 'zerog-native' && (
                    <p className="text-[10px] text-yellow-400/80">
                      ℹ Preview uses current 0G/USD price. Final amount confirmed by bridge relayer.
                    </p>
                  )}
                  <div className="flex justify-between text-xs text-gray-500">
                    <span>Deposit fee</span>
                    <span className="text-green-400">Free (0%)</span>
                  </div>
                </div>

                {/* Destination */}
                <div className="rounded-lg bg-gray-800/40 p-3">
                  <p className="text-[10px] text-gray-500 uppercase tracking-widest">$ARENA sent to</p>
                  <p className="text-xs font-mono text-gray-400 truncate mt-0.5">{custodialSolanaAddress || '—'}</p>
                  <p className="text-[10px] text-gray-600 mt-0.5">Your internal AI Arena wallet on Solana</p>
                </div>

                {/* Vault address warning if not configured */}
                {((method !== 'zerog-native' && !BASE_VAULT) || (method === 'zerog-native' && !ZEROG_VAULT)) && (
                  <div className="rounded-lg bg-red-950/40 border border-red-500/30 p-3">
                    <p className="text-xs text-red-300">
                      ⚠ Vault contract not deployed yet. Add <code className="bg-gray-800 px-1 rounded">
                        {method === 'zerog-native' ? 'NEXT_PUBLIC_ZEROG_VAULT_ADDRESS' : 'NEXT_PUBLIC_BASE_VAULT_ADDRESS'}
                      </code> to your env after deploying.
                    </p>
                  </div>
                )}

                {error && (
                  <div className="rounded-lg bg-red-950/40 border border-red-500/30 p-3">
                    <p className="text-xs text-red-300">{error}</p>
                  </div>
                )}

                {/* Action button */}
                <button
                  onClick={handleEVMDeposit}
                  disabled={!amount || parseFloat(amount) <= 0 || !['idle', 'error'].includes(status)}
                  className="w-full rounded-lg bg-cyan-500 py-3.5 font-bold text-black hover:bg-cyan-400 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm"
                >
                  {status === 'switching'  && '⏳ Switching network…'}
                  {status === 'approving'  && '⏳ Approving token…'}
                  {status === 'depositing' && '⏳ Sending deposit…'}
                  {status === 'error'      && '↩ Try again'}
                  {status === 'idle'       && `Deposit ${amount || '0'} ${selected.symbol}`}
                </button>

                <p className="text-[10px] text-gray-600 text-center">
                  {method === 'zerog-native'
                    ? 'MetaMask will prompt once for the 0G transfer'
                    : 'MetaMask will prompt twice: approve token, then deposit'}
                </p>
              </div>
            )}

          </div>
        )}
      </div>
    </div>
  );
}
