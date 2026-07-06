/**
 * okx-payment-proxy — x402 v2 payment gate in front of POST /okx/create-agent.
 *
 * Protocol: https://x402.org  (x402 v2, "exact" scheme, eip155:196 / X Layer)
 * On each request the proxy either:
 *   - returns HTTP 402 with the x402 v2 payment-required JSON (no X-PAYMENT header)
 *   - decodes the X-PAYMENT header, calls transferWithAuthorization on the USDT
 *     contract (EIP-3009), waits for confirmation, then forwards to agent-service
 *
 * Required env vars:
 *   XLAYER_OPERATOR_PRIVATE_KEY  — private key of a wallet with OKB on X Layer
 *                                   (pays gas for transferWithAuthorization, ~$0.0001/tx)
 *   OKX_SERVICE_KEY              — forwarded to agent-service as X-OKX-Service-Key
 *   OKX_PROXY_UPSTREAM_URL       — agent-service /okx/create-agent endpoint
 */

import * as http from 'node:http';
import {
  createWalletClient,
  createPublicClient,
  http as viemHttp,
  parseAbi,
  parseSignature,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// ── Config ────────────────────────────────────────────────────────────────────

const PORT         = parseInt(process.env.PORT ?? '8090', 10);
const UPSTREAM_URL = process.env.OKX_PROXY_UPSTREAM_URL ?? 'http://localhost:8002/okx/create-agent';
const SERVICE_KEY  = process.env.OKX_SERVICE_KEY ?? '';

// x402 v2 payment terms — values per OKX's specification
const ASSET   = (process.env.X402_ASSET   ?? '0x779ded0c9e1022225f8e0630b35a9b54be713736') as `0x${string}`;
const PAY_TO  = (process.env.X402_PAY_TO  ?? '0xaa1860e22184852ae8b1890169b732da23459990') as `0x${string}`;
const AMOUNT  =   process.env.X402_AMOUNT  ?? '100000'; // 0.10 USDT (6 decimals)
const TIMEOUT = parseInt(process.env.X402_MAX_TIMEOUT_SECONDS ?? '300', 10);

const OPERATOR_KEY = process.env.XLAYER_OPERATOR_PRIVATE_KEY ?? '';
if (!OPERATOR_KEY) {
  console.error('[okx-payment-proxy] Refusing to start — XLAYER_OPERATOR_PRIVATE_KEY not set.');
  process.exit(1);
}

// ── X Layer chain + viem clients ──────────────────────────────────────────────

const xlayer = {
  id: 196,
  name: 'X Layer Mainnet',
  nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.xlayer.tech'] },
    public:  { http: ['https://rpc.xlayer.tech'] },
  },
} as const;

const account = privateKeyToAccount(
  OPERATOR_KEY.startsWith('0x') ? (OPERATOR_KEY as `0x${string}`) : `0x${OPERATOR_KEY}`,
);

const publicClient = createPublicClient({
  chain: xlayer,
  transport: viemHttp('https://rpc.xlayer.tech', { timeout: 10_000 }),
});

const walletClient = createWalletClient({
  account,
  chain: xlayer,
  transport: viemHttp('https://rpc.xlayer.tech', { timeout: 10_000 }),
});

const EIP3009_ABI = parseAbi([
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external',
]);

// In-memory nonce guard (single-instance protection; contract enforces on-chain too)
const usedNonces = new Set<string>();

// ── x402 v2 helpers ───────────────────────────────────────────────────────────

function make402Body(host: string): object {
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:196',
        asset: ASSET,
        amount: AMOUNT,
        payTo: PAY_TO,
        maxTimeoutSeconds: TIMEOUT,
        resource: `https://${host}/create-agent`,
        description: 'KULT Agent Creator — create-agent (0.10 USDT on X Layer)',
        mimeType: 'application/json',
        extra: {},
      },
    ],
    error: 'Payment required',
  };
}

interface Authorization {
  from: string;
  to: string;
  value: string;
  validAfter?: string;
  validBefore: string;
  nonce: string;
}

interface X402Payment {
  x402Version?: number;
  scheme?: string;
  network?: string;
  payload: {
    signature: string;
    authorization: Authorization;
  };
}

async function settlePayment(xPaymentHeader: string): Promise<`0x${string}`> {
  let payment: X402Payment;
  try {
    payment = JSON.parse(Buffer.from(xPaymentHeader, 'base64').toString('utf8'));
  } catch {
    throw new Error('X-PAYMENT header is not valid base64-encoded JSON');
  }

  const { authorization: auth, signature } = payment.payload ?? {};
  if (!auth || !signature) throw new Error('X-PAYMENT payload missing authorization or signature');

  // Validate payment terms match what we advertised
  if (auth.to.toLowerCase() !== PAY_TO.toLowerCase()) {
    throw new Error(`X-PAYMENT payTo mismatch: expected ${PAY_TO}`);
  }
  if (BigInt(auth.value) < BigInt(AMOUNT)) {
    throw new Error(`X-PAYMENT amount too low: got ${auth.value}, need ${AMOUNT}`);
  }
  const validBefore = BigInt(auth.validBefore);
  if (validBefore * 1000n < BigInt(Date.now())) {
    throw new Error('X-PAYMENT authorization has expired');
  }

  // Replay guard
  const nonceKey = `${auth.from.toLowerCase()}:${auth.nonce}`;
  if (usedNonces.has(nonceKey)) throw new Error('X-PAYMENT nonce already used');

  // Decode ECDSA signature
  const { v, r, s } = parseSignature(signature as `0x${string}`);

  // Execute EIP-3009 transferWithAuthorization on-chain
  const txHash = await walletClient.writeContract({
    address: ASSET,
    abi: EIP3009_ABI,
    functionName: 'transferWithAuthorization',
    args: [
      auth.from          as `0x${string}`,
      auth.to            as `0x${string}`,
      BigInt(auth.value),
      BigInt(auth.validAfter ?? 0),
      validBefore,
      auth.nonce         as `0x${string}`,
      Number(v),           // uint8
      r,                   // bytes32
      s,                   // bytes32
    ],
  });

  await publicClient.waitForTransactionReceipt({ hash: txHash, pollingInterval: 500 });

  usedNonces.add(nonceKey);
  return txHash;
}

// ── Node http server ──────────────────────────────────────────────────────────

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

http.createServer(async (req, res) => {
  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', service: 'okx-payment-proxy', protocol: 'x402-v2' }));
    return;
  }

  if (req.method !== 'POST' || req.url !== '/create-agent') {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  const body       = await readBody(req);
  const xPayment   = req.headers['x-payment'] as string | undefined;
  const host       = req.headers.host ?? 'aiarena-okx-payment-proxy.onrender.com';

  if (!xPayment) {
    // No payment — return x402 v2 challenge
    const payload = make402Body(host);
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');
    res.statusCode = 402;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-PAYMENT-REQUIRED', encoded);
    res.end(JSON.stringify(payload));
    return;
  }

  // Settle payment on-chain, then forward
  let txHash: `0x${string}`;
  try {
    txHash = await settlePayment(xPayment);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Payment settlement failed';
    console.error('[okx-payment-proxy] Settlement error:', msg);
    res.statusCode = 402;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: msg }));
    return;
  }

  // Forward to agent-service
  let upstream: Response;
  try {
    upstream = await fetch(UPSTREAM_URL, {
      method:  'POST',
      headers: {
        'Content-Type':       'application/json',
        'X-OKX-Service-Key':  SERVICE_KEY,
      },
      body,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Upstream unreachable';
    console.error('[okx-payment-proxy] Upstream error:', msg);
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Upstream service error', details: msg }));
    return;
  }

  const upstreamBody = await upstream.text();
  const paymentResp  = Buffer.from(JSON.stringify({
    txHash,
    success: true,
    network: 'eip155:196',
  })).toString('base64');

  res.statusCode = upstream.status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('X-PAYMENT-RESPONSE', paymentResp);
  res.end(upstreamBody);
}).listen(PORT, () => {
  console.log(`[okx-payment-proxy] :${PORT} → x402 v2 (eip155:196) operator=${account.address}`);
  console.log(`[okx-payment-proxy] upstream=${UPSTREAM_URL}`);
  console.log(`[okx-payment-proxy] payTo=${PAY_TO} asset=${ASSET} amount=${AMOUNT}`);
});
