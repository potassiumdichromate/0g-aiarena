/**
 * okx-payment-proxy — x402 v2 payment gate in front of POST /okx/create-agent.
 *
 * Protocol: x402 v2, "exact" scheme, eip155:196 (X Layer)
 * Settlement model: client-side — OKX's marketplace submits the ERC-4337
 * sponsored tx; our server verifies the EIP-3009 signature is valid and the
 * payment terms match, then forwards to agent-service immediately.
 * No on-chain read needed — the marketplace handles settlement lifecycle.
 *
 * Handlers:
 *   GET  /create-agent  → 402 v2 challenge (for marketplace x402-validate probe)
 *   POST /create-agent  → verify X-PAYMENT sig → forward to agent-service
 *   OPTIONS /create-agent → 200 (liveness probe)
 *   GET  /health        → 200
 */

import * as http from 'node:http';
import { verifyTypedData } from 'viem';

// ── Config ────────────────────────────────────────────────────────────────────

const PORT         = parseInt(process.env.PORT ?? '8090', 10);
const UPSTREAM_URL = process.env.OKX_PROXY_UPSTREAM_URL ?? 'http://localhost:8002/okx/create-agent';
const SERVICE_KEY  = process.env.OKX_SERVICE_KEY ?? '';

// x402 v2 payment terms — per OKX's specification for ASP #2170
const ASSET    = (process.env.X402_ASSET        ?? '0x779ded0c9e1022225f8e0630b35a9b54be713736') as `0x${string}`;
const PAY_TO   = (process.env.X402_PAY_TO       ?? '0xaa1860e22184852ae8b1890169b732da23459990') as `0x${string}`;
const AMOUNT   =   process.env.X402_AMOUNT       ?? '100000'; // 0.10 USDT (6 decimals)
const TIMEOUT  = parseInt(process.env.X402_MAX_TIMEOUT_SECONDS ?? '300', 10);
// Resource URL shown in 402 body — must match the registered ASP endpoint
const RESOURCE = process.env.X402_RESOURCE_URL ?? 'https://aiarena-gateway.onrender.com/v1/okx/create-agent';

// ── EIP-712 domain for signature verification ─────────────────────────────────
// name from contract name() on X Layer (0x779ded…): "USD₮0"

const EIP3009_DOMAIN = {
  name: 'USD₮0',
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

// ── x402 v2 challenge payload ─────────────────────────────────────────────────

function make402Body(): object {
  return {
    x402Version: 2,
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:196',
        asset: ASSET,
        amount: AMOUNT,
        payTo: PAY_TO,
        maxTimeoutSeconds: TIMEOUT,
        resource: RESOURCE,
        description: 'KULT Agent Creator — create-agent (0.10 USDT on X Layer)',
        mimeType: 'application/json',
        extra: { name: 'USD₮0', version: '1' },
      },
    ],
    error: 'Payment required',
  };
}

function send402(res: http.ServerResponse): void {
  const payload = make402Body();
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');
  res.statusCode = 402;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('X-PAYMENT-REQUIRED', encoded);
  res.end(JSON.stringify(payload));
}

// ── EIP-3009 signature verification (off-chain, no RPC needed) ───────────────

interface Authorization {
  from: string;
  to: string;
  value: string;
  validAfter?: string;
  validBefore: string;
  nonce: string;
}

interface X402Payment {
  payload: { signature: string; authorization: Authorization };
}

async function verifyPayment(xPaymentHeader: string): Promise<void> {
  let payment: X402Payment;
  try {
    payment = JSON.parse(Buffer.from(xPaymentHeader, 'base64').toString('utf8'));
  } catch {
    throw new Error('X-PAYMENT is not valid base64-encoded JSON');
  }

  const { authorization: auth, signature } = payment.payload ?? {};
  if (!auth || !signature) throw new Error('X-PAYMENT payload missing authorization or signature');

  if (auth.to.toLowerCase() !== PAY_TO.toLowerCase())
    throw new Error(`X-PAYMENT payTo mismatch: expected ${PAY_TO}`);

  if (BigInt(auth.value) < BigInt(AMOUNT))
    throw new Error(`X-PAYMENT amount too low: got ${auth.value}, need ${AMOUNT}`);

  if (BigInt(auth.validBefore) * 1000n < BigInt(Date.now()))
    throw new Error('X-PAYMENT authorization has expired');

  // Verify EIP-712 signature — proves buyer authorised this exact payment
  const valid = await verifyTypedData({
    address:     auth.from as `0x${string}`,
    domain:      EIP3009_DOMAIN,
    types:       EIP3009_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: {
      from:        auth.from         as `0x${string}`,
      to:          auth.to           as `0x${string}`,
      value:       BigInt(auth.value),
      validAfter:  BigInt(auth.validAfter ?? 0),
      validBefore: BigInt(auth.validBefore),
      nonce:       auth.nonce        as `0x${string}`,
    },
    signature: signature as `0x${string}`,
  });
  if (!valid) throw new Error('X-PAYMENT signature invalid');
  // On-chain settlement is handled by OKX marketplace's ERC-4337 sponsored tx.
  // We trust a valid signature; marketplace manages payment lifecycle.
}

// ── Node http server ──────────────────────────────────────────────────────────

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

http.createServer(async (req, res) => {
  const url = req.url ?? '/';

  // Liveness / health
  if (req.method === 'GET' && url === '/health') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', service: 'okx-payment-proxy', protocol: 'x402-v2' }));
    return;
  }

  // OPTIONS — liveness probe (marketplace monitoring)
  if (req.method === 'OPTIONS' && url === '/create-agent') {
    res.statusCode = 200;
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    res.end();
    return;
  }

  // GET — x402-validate probe (marketplace CLI uses GET to check the endpoint)
  if (req.method === 'GET' && url === '/create-agent') {
    send402(res);
    return;
  }

  if (req.method !== 'POST' || url !== '/create-agent') {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  // POST — payment gate
  const body     = await readBody(req);
  const xPayment = req.headers['x-payment'] as string | undefined;

  if (!xPayment) {
    send402(res);
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

  // Payment verified — forward to agent-service
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
    asset:   ASSET,
    amount:  AMOUNT,
  })).toString('base64');

  res.statusCode = upstream.status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('X-PAYMENT-RESPONSE', receipt);
  res.end(upstreamBody);

}).listen(PORT, () => {
  console.log(`[okx-payment-proxy] :${PORT} → x402 v2 (eip155:196)`);
  console.log(`[okx-payment-proxy] resource=${RESOURCE}`);
  console.log(`[okx-payment-proxy] upstream=${UPSTREAM_URL}`);
});
