/**
 * okx-payment-proxy — x402 v2 payment gate in front of POST /okx/create-agent.
 *
 * Protocol: x402 v2, "exact" scheme, eip155:196 (X Layer)
 * Settlement model: OKX facilitator (gasless — OKX executes transferWithAuthorization
 * on-chain; our server only reads authorizationState to confirm it happened).
 *
 * Flow:
 *   1. No X-PAYMENT → return HTTP 402 with x402 v2 challenge JSON
 *   2. X-PAYMENT present → verify EIP-3009 sig is valid, check on-chain that OKX's
 *      facilitator already executed the transfer (authorizationState = true),
 *      then forward to agent-service. No gas wallet needed.
 */

import * as http from 'node:http';
import {
  createPublicClient,
  http as viemHttp,
  parseAbi,
  verifyTypedData,
} from 'viem';

// ── Config ────────────────────────────────────────────────────────────────────

const PORT         = parseInt(process.env.PORT ?? '8090', 10);
const UPSTREAM_URL = process.env.OKX_PROXY_UPSTREAM_URL ?? 'http://localhost:8002/okx/create-agent';
const SERVICE_KEY  = process.env.OKX_SERVICE_KEY ?? '';

// x402 v2 payment terms — values per OKX's specification for ASP #2170
const ASSET   = (process.env.X402_ASSET   ?? '0x779ded0c9e1022225f8e0630b35a9b54be713736') as `0x${string}`;
const PAY_TO  = (process.env.X402_PAY_TO  ?? '0xaa1860e22184852ae8b1890169b732da23459990') as `0x${string}`;
const AMOUNT  =   process.env.X402_AMOUNT  ?? '100000'; // 0.10 USDT (6 decimals)
const TIMEOUT = parseInt(process.env.X402_MAX_TIMEOUT_SECONDS ?? '300', 10);

// ── X Layer public client (read-only, no gas wallet needed) ───────────────────

const xlayer = {
  id: 196,
  name: 'X Layer Mainnet',
  nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.xlayer.tech'] },
    public:  { http: ['https://rpc.xlayer.tech'] },
  },
} as const;

const publicClient = createPublicClient({
  chain: xlayer,
  transport: viemHttp('https://rpc.xlayer.tech', { timeout: 10_000 }),
});

// EIP-3009: authorizationState(authorizer, nonce) → bool (true = already used/settled)
const EIP3009_STATE_ABI = parseAbi([
  'function authorizationState(address authorizer, bytes32 nonce) external view returns (bool)',
]);

// EIP-712 types for TransferWithAuthorization (EIP-3009)
const EIP3009_DOMAIN = {
  name: 'USD Tether',
  version: '1',
  chainId: 196,
  verifyingContract: ASSET,
} as const;

const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: 'from',        type: 'address' },
    { name: 'to',          type: 'address' },
    { name: 'value',       type: 'uint256' },
    { name: 'validAfter',  type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce',       type: 'bytes32' },
  ],
} as const;

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

async function verifyPayment(xPaymentHeader: string): Promise<void> {
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
  if (BigInt(auth.validBefore) * 1000n < BigInt(Date.now())) {
    throw new Error('X-PAYMENT authorization has expired');
  }

  // Verify the EIP-3009 signature (proves the buyer authorised this payment)
  const valid = await verifyTypedData({
    address: auth.from as `0x${string}`,
    domain: EIP3009_DOMAIN,
    types: EIP3009_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: {
      from:        auth.from          as `0x${string}`,
      to:          auth.to            as `0x${string}`,
      value:       BigInt(auth.value),
      validAfter:  BigInt(auth.validAfter ?? 0),
      validBefore: BigInt(auth.validBefore),
      nonce:       auth.nonce         as `0x${string}`,
    },
    signature: signature as `0x${string}`,
  });
  if (!valid) throw new Error('X-PAYMENT signature invalid');

  // Confirm OKX facilitator already executed the transfer on-chain (free read call)
  const settled = await publicClient.readContract({
    address: ASSET,
    abi: EIP3009_STATE_ABI,
    functionName: 'authorizationState',
    args: [auth.from as `0x${string}`, auth.nonce as `0x${string}`],
  });
  if (!settled) throw new Error('Payment not yet settled on-chain — facilitator has not executed the transfer');
}

// ── Node http server ──────────────────────────────────────────────────────────

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

http.createServer(async (req, res) => {
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

  const body     = await readBody(req);
  const xPayment = req.headers['x-payment'] as string | undefined;
  const host     = req.headers.host ?? 'aiarena-okx-payment-proxy.onrender.com';

  if (!xPayment) {
    const payload = make402Body(host);
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');
    res.statusCode = 402;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-PAYMENT-REQUIRED', encoded);
    res.end(JSON.stringify(payload));
    return;
  }

  try {
    await verifyPayment(xPayment);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Payment verification failed';
    console.error('[okx-payment-proxy] Payment rejected:', msg);
    res.statusCode = 402;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: msg }));
    return;
  }

  // Payment confirmed — forward to agent-service
  let upstream: Response;
  try {
    upstream = await fetch(UPSTREAM_URL, {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'X-OKX-Service-Key': SERVICE_KEY,
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
  const receipt      = Buffer.from(JSON.stringify({
    settled: true,
    network: 'eip155:196',
    asset: ASSET,
    amount: AMOUNT,
  })).toString('base64');

  res.statusCode = upstream.status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('X-PAYMENT-RESPONSE', receipt);
  res.end(upstreamBody);
}).listen(PORT, () => {
  console.log(`[okx-payment-proxy] :${PORT} → x402 v2 gasless (eip155:196)`);
  console.log(`[okx-payment-proxy] upstream=${UPSTREAM_URL}`);
  console.log(`[okx-payment-proxy] payTo=${PAY_TO} asset=${ASSET} amount=${AMOUNT}`);
});
