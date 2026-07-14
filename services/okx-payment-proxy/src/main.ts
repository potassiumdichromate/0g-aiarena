/**
 * okx-payment-proxy — x402 v2 payment gate in front of POST /okx/create-agent.
 *
 * Protocol: x402 v2, "exact" scheme, eip155:196 (X Layer)
 *
 * 402 challenge flow (x402 v2):
 *   1. Any request without payment → 402 with PAYMENT-REQUIRED header (base64 JSON)
 *   2. Buyer (OKX task-402-pay CLI) reads PAYMENT-REQUIRED, signs EIP-3009, replays
 *      with PAYMENT-SIGNATURE header (v2) or X-PAYMENT header (v1)
 *   3. We verify via OKX x402 broker API (web3.okx.com/api/v6/pay/x402/verify)
 *   4. Forward to agent-service, return 200 + result body
 *   5. OKX settle API called async (web3.okx.com/api/v6/pay/x402/settle)
 *   6. Buyer CLI auto-saves our 200 response body as the task deliverable (A2MCP flow)
 *
 * Handlers:
 *   GET  /create-agent  → 402 v2 challenge (x402-validate probe)
 *   POST /create-agent  → verify → forward to agent-service → 200
 *   OPTIONS /create-agent → 200 (liveness)
 *   GET  /health        → 200
 */

import * as http   from 'node:http';
import * as crypto from 'node:crypto';
import { verifyTypedData } from 'viem';

// ── Config ────────────────────────────────────────────────────────────────────

const PORT         = parseInt(process.env.PORT ?? '8090', 10);
const UPSTREAM_URL = process.env.OKX_PROXY_UPSTREAM_URL ?? 'http://localhost:8002/okx/create-agent';
const SERVICE_KEY  = process.env.OKX_SERVICE_KEY ?? '';

const ASSET    = process.env.X402_ASSET              ?? '0x779ded0c9e1022225f8e0630b35a9b54be713736';
const PAY_TO   = process.env.X402_PAY_TO             ?? '0xaa1860e22184852ae8b1890169b732da23459990';
const AMOUNT   = process.env.X402_AMOUNT             ?? '100000'; // 0.10 USDT (6 decimals)
const TIMEOUT  = parseInt(process.env.X402_MAX_TIMEOUT_SECONDS ?? '300', 10);
const RESOURCE = process.env.X402_RESOURCE_URL       ?? 'https://aiarena-gateway.onrender.com/v1/okx/create-agent';

// OKX Developer Portal credentials (used for x402 verify + settle API)
const OKX_API_KEY        = process.env.OKX_API_KEY         ?? '';
const OKX_API_SECRET     = process.env.OKX_API_SECRET_KEY  ?? '';
const OKX_API_PASSPHRASE = process.env.OKX_API_PASSPHRASE  ?? '';

// OKX x402 broker API — verified from onchainos dev docs
const OKX_X402_BASE   = 'https://web3.okx.com';
const OKX_VERIFY_PATH = '/api/v6/pay/x402/verify';
const OKX_SETTLE_PATH = '/api/v6/pay/x402/settle';

// ── EIP-712 fallback domain (used when OKX API creds not set) ────────────────

const EIP3009_DOMAIN = {
  name: 'USD₮0',
  version: '1',
  chainId: 196,
  verifyingContract: ASSET as `0x${string}`,
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

// ── Payment requirements (matches our 402 challenge accepts[0]) ───────────────

function paymentRequirements() {
  return {
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
  };
}

// ── x402 v2 challenge ─────────────────────────────────────────────────────────

function make402Body(): object {
  return {
    x402Version: 2,
    accepts: [paymentRequirements()],
    error: 'Payment required',
  };
}

function send402(res: http.ServerResponse): void {
  const payload = make402Body();
  // v2: challenge goes in PAYMENT-REQUIRED response header (base64-encoded JSON)
  // The OKX buyer CLI (task-402-pay) reads this header to get pricing terms.
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64');
  res.statusCode = 402;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('PAYMENT-REQUIRED', encoded);
  res.end(JSON.stringify(payload));
}

// ── OKX API auth ──────────────────────────────────────────────────────────────

function okxAuthHeaders(method: string, path: string, body: string): Record<string, string> {
  const ts      = new Date().toISOString();
  const preHash = ts + method + path + body;
  const sign    = crypto.createHmac('sha256', OKX_API_SECRET).update(preHash).digest('base64');
  return {
    'OK-ACCESS-KEY':        OKX_API_KEY,
    'OK-ACCESS-SIGN':       sign,
    'OK-ACCESS-TIMESTAMP':  ts,
    'OK-ACCESS-PASSPHRASE': OKX_API_PASSPHRASE,
  };
}

// ── Payment verification — OKX broker API (primary) ──────────────────────────

async function verifyViaOkxApi(rawHeader: string): Promise<void> {
  let paymentPayload: unknown;
  try {
    paymentPayload = JSON.parse(Buffer.from(rawHeader, 'base64').toString('utf8'));
  } catch {
    throw new Error('Payment header is not valid base64-encoded JSON');
  }

  const reqBody = JSON.stringify({
    x402Version: 2,
    paymentPayload,
    paymentRequirements: paymentRequirements(),
  });
  const headers = okxAuthHeaders('POST', OKX_VERIFY_PATH, reqBody);

  let verifyRes: Response;
  try {
    verifyRes = await fetch(`${OKX_X402_BASE}${OKX_VERIFY_PATH}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body:    reqBody,
    });
  } catch (err: unknown) {
    throw new Error(`OKX verify API unreachable: ${err instanceof Error ? err.message : err}`);
  }

  if (!verifyRes.ok) {
    const txt = await verifyRes.text();
    throw new Error(`OKX verify API ${verifyRes.status}: ${txt}`);
  }

  const data = await verifyRes.json() as {
    isValid?: boolean;
    invalidReason?: string;
    invalidMessage?: string;
  };

  if (!data.isValid) {
    throw new Error(`Payment invalid: ${data.invalidReason ?? data.invalidMessage ?? 'rejected'}`);
  }
}

// ── Settlement — async fire-and-forget after 200 returned to buyer ────────────
// OKX settle API broadcasts the ERC-4337 sponsored transfer on X Layer.
// asyncSettle: false means we don't wait for on-chain confirmation.

function settleAsync(rawHeader: string): void {
  if (!OKX_API_KEY || !OKX_API_SECRET) return;

  let paymentPayload: unknown;
  try {
    paymentPayload = JSON.parse(Buffer.from(rawHeader, 'base64').toString('utf8'));
  } catch {
    return;
  }

  const reqBody = JSON.stringify({
    x402Version:         2,
    paymentPayload,
    paymentRequirements: paymentRequirements(),
    syncSettle:          false,
  });
  const headers = okxAuthHeaders('POST', OKX_SETTLE_PATH, reqBody);

  fetch(`${OKX_X402_BASE}${OKX_SETTLE_PATH}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body:    reqBody,
  }).then(async (r) => {
    const d = await r.json() as { transaction?: string; status?: string; errorReason?: string };
    if (r.ok && d.status !== 'failed') {
      console.log(`[okx-payment-proxy] Settle ${d.status ?? 'broadcast'} tx=${d.transaction ?? 'n/a'}`);
    } else {
      console.error('[okx-payment-proxy] Settle failed:', d.errorReason ?? 'unknown');
    }
  }).catch((err: unknown) => {
    console.error('[okx-payment-proxy] Settle error:', err instanceof Error ? err.message : err);
  });
}

// ── EIP-712 verification — local fallback (no OKX API creds needed) ──────────

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

async function verifyLocal(rawHeader: string): Promise<void> {
  let payment: X402Payment;
  try {
    payment = JSON.parse(Buffer.from(rawHeader, 'base64').toString('utf8')) as X402Payment;
  } catch {
    throw new Error('Payment header is not valid base64-encoded JSON');
  }

  const { authorization: auth, signature } = payment.payload ?? {};
  if (!auth || !signature) throw new Error('Payment payload missing authorization or signature');

  if (auth.to.toLowerCase() !== PAY_TO.toLowerCase())
    throw new Error(`Payment payTo mismatch: expected ${PAY_TO}`);

  if (BigInt(auth.value) < BigInt(AMOUNT))
    throw new Error(`Payment amount too low: got ${auth.value}, need ${AMOUNT}`);

  if (BigInt(auth.validBefore) * 1000n < BigInt(Date.now()))
    throw new Error('Payment authorization has expired');

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
  if (!valid) throw new Error('Payment signature invalid');
}

// ── Node http server ──────────────────────────────────────────────────────────

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

http.createServer(async (req, res) => {
  const url = req.url ?? '/';

  if (req.method === 'GET' && url === '/health') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', service: 'okx-payment-proxy', protocol: 'x402-v2' }));
    return;
  }

  if (req.method === 'OPTIONS' && url === '/create-agent') {
    res.statusCode = 200;
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    res.end();
    return;
  }

  // GET — x402-validate probe: return 402 challenge so buyer can read payment terms
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
  const body = await readBody(req);

  // x402 v2 uses PAYMENT-SIGNATURE; v1 uses X-PAYMENT. Accept both.
  const paymentHeader =
    (req.headers['payment-signature'] ?? req.headers['x-payment']) as string | undefined;

  if (!paymentHeader) {
    send402(res);
    return;
  }

  try {
    if (OKX_API_KEY && OKX_API_SECRET) {
      // Primary: OKX x402 broker API (web3.okx.com/api/v6/pay/x402/verify)
      await verifyViaOkxApi(paymentHeader);
    } else {
      // Fallback: local EIP-712 (no OKX creds — local dev)
      console.warn('[okx-payment-proxy] OKX API creds missing — using local EIP-712 verify');
      await verifyLocal(paymentHeader);
    }
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

  // After returning 200 to the buyer:
  // - Buyer's task-402-pay CLI auto-saves the response body as the task deliverable (A2MCP x402 flow)
  // - We settle the payment async so funds move to PAY_TO on X Layer
  if (upstream.ok) {
    settleAsync(paymentHeader);
  }

}).listen(PORT, () => {
  console.log(`[okx-payment-proxy] :${PORT} → x402 v2 (eip155:196)`);
  console.log(`[okx-payment-proxy] resource=${RESOURCE}`);
  console.log(`[okx-payment-proxy] upstream=${UPSTREAM_URL}`);
  console.log(`[okx-payment-proxy] okx-api=${OKX_API_KEY ? 'configured' : 'MISSING — falling back to local EIP-712'}`);
});
