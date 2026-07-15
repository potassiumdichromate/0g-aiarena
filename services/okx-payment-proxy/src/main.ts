/**
 * okx-payment-proxy — x402 v2 payment gate in front of POST /okx/create-agent.
 *
 * Protocol: x402 v2, "exact" scheme, eip155:196 (X Layer)
 *
 * 402 challenge flow:
 *   1. Any request without payment → 402 with PAYMENT-REQUIRED header (base64 JSON)
 *      x402Version: 2 in challenge; extra.version: "1" is the EIP-712 domain version
 *      for USD₮0 (separate concept — not the x402 protocol version)
 *   2. Buyer signs EIP-3009 TransferWithAuthorization, replays with:
 *      PAYMENT-SIGNATURE header (x402 v2) or X-PAYMENT header (x402 v1)
 *   3. We detect which header arrived and verify accordingly:
 *      - Primary: OKX x402 broker API (version matched to detected header)
 *      - Fallback: local EIP-712 (USD₮0 domain, chainId 196)
 *   4. Forward to agent-service, return 200 + result body
 *   5. Buyer CLI auto-saves 200 response body as task deliverable (A2MCP flow)
 *   6. OKX settle API called async to move USDT to PAY_TO on X Layer
 *
 * Handlers:
 *   GET  /create-agent  → 402 challenge (x402-validate probe)
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

// OKX Developer Portal credentials (x402 verify + settle API)
const OKX_API_KEY        = process.env.OKX_API_KEY         ?? '';
const OKX_API_SECRET     = process.env.OKX_API_SECRET_KEY  ?? '';
const OKX_API_PASSPHRASE = process.env.OKX_API_PASSPHRASE  ?? '';

// OKX x402 broker API (verified from onchainos dev docs)
const OKX_X402_BASE   = 'https://web3.okx.com';
const OKX_VERIFY_PATH = '/api/v6/pay/x402/verify';
const OKX_SETTLE_PATH = '/api/v6/pay/x402/settle';

// ── Nonce idempotency cache ───────────────────────────────────────────────────
// Prevents re-payment rejection if buyer replays a valid, already-processed proof.
// Keys: EIP-3009 nonce (bytes32 hex). Values: upstream response body.
// In-memory is fine for Render (single process, ~300s TIMEOUT covers the window).
const processedNonces = new Map<string, string>();

// ── EIP-712 domain for USD₮0 on X Layer (chainId 196) ────────────────────────
// extra.version "1" is the EIP-712 domain version of the USD₮0 token contract —
// a separate concept from x402Version (the HTTP payment protocol version).

const EIP3009_DOMAIN = {
  name: 'USD₮0',  // USD₮0 — U+20AE is Mongolian Tugrik, exact on-chain name
  version: '1',        // EIP-712 domain version of the token, not x402 protocol version
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
    scheme:            'exact',
    network:           'eip155:196',
    asset:             ASSET,
    amount:            AMOUNT,
    payTo:             PAY_TO,
    maxTimeoutSeconds: TIMEOUT,
    resource:          RESOURCE,
    description:       'KULT Agent Creator — create-agent (0.10 USDT on X Layer)',
    mimeType:          'application/json',
    // extra carries EIP-712 domain metadata for USD₮0; version "1" is the
    // token contract's domain version, required for signature reconstruction.
    extra: { name: 'USD₮0', version: '1' },
  };
}

// ── 402 challenge ─────────────────────────────────────────────────────────────

function make402Body(): object {
  return {
    x402Version: 2,
    accepts: [paymentRequirements()],
    error: 'Payment required',
  };
}

function send402(res: http.ServerResponse): void {
  const payload = make402Body();
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

// ── OKX broker API verify ─────────────────────────────────────────────────────
// x402Version passed to API must match the header the buyer actually used:
//   PAYMENT-SIGNATURE header → x402 v2
//   X-PAYMENT header         → x402 v1
// Mismatch here is the "version mismatch" OKX reported.

async function verifyViaOkxApi(rawHeader: string, x402Version: 1 | 2): Promise<void> {
  let paymentPayload: unknown;
  try {
    paymentPayload = JSON.parse(Buffer.from(rawHeader, 'base64').toString('utf8'));
  } catch {
    throw new Error('Payment header is not valid base64-encoded JSON');
  }

  const reqBody = JSON.stringify({
    x402Version,          // matched to detected header, not hardcoded
    paymentPayload,
    paymentRequirements: paymentRequirements(),
  });
  const headers = okxAuthHeaders('POST', OKX_VERIFY_PATH, reqBody);

  const verifyRes = await fetch(`${OKX_X402_BASE}${OKX_VERIFY_PATH}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body:    reqBody,
  });

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

// ── Local EIP-712 verification ────────────────────────────────────────────────
// Used when OKX API creds absent OR as fallback if OKX API call fails.
// Verifies EIP-3009 TransferWithAuthorization signature directly against USD₮0
// domain (name: USD₮0, version: "1", chainId: 196, contract: 0x779ded...).

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

async function verifyLocal(rawHeader: string): Promise<string> {
  let payment: X402Payment;
  try {
    payment = JSON.parse(Buffer.from(rawHeader, 'base64').toString('utf8')) as X402Payment;
  } catch {
    throw new Error('Payment header is not valid base64-encoded JSON');
  }

  const { authorization: auth, signature } = payment.payload ?? {};
  if (!auth || !signature) throw new Error('Payment payload missing authorization or signature');

  if (auth.to.toLowerCase() !== PAY_TO.toLowerCase())
    throw new Error(`Payment payTo mismatch: expected ${PAY_TO}, got ${auth.to}`);

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
      from:        auth.from          as `0x${string}`,
      to:          auth.to            as `0x${string}`,
      value:       BigInt(auth.value),
      validAfter:  BigInt(auth.validAfter ?? 0),
      validBefore: BigInt(auth.validBefore),
      nonce:       auth.nonce         as `0x${string}`,
    },
    signature: signature as `0x${string}`,
  });
  if (!valid) throw new Error('Payment EIP-712 signature invalid (domain: USD₮0, chainId: 196)');

  // Return nonce so caller can cache it for idempotency
  return auth.nonce;
}

// ── Settle (async, fire-and-forget) ──────────────────────────────────────────

function settleAsync(rawHeader: string, x402Version: 1 | 2): void {
  if (!OKX_API_KEY || !OKX_API_SECRET) return;

  let paymentPayload: unknown;
  try {
    paymentPayload = JSON.parse(Buffer.from(rawHeader, 'base64').toString('utf8'));
  } catch {
    return;
  }

  const reqBody = JSON.stringify({
    x402Version,
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
      console.log(`[proxy] settle ok tx=${d.transaction ?? 'n/a'} status=${d.status ?? 'broadcast'}`);
    } else {
      console.error('[proxy] settle failed:', d.errorReason ?? JSON.stringify(d));
    }
  }).catch((err: unknown) => {
    console.error('[proxy] settle error:', err instanceof Error ? err.message : err);
  });
}

// ── HTTP server ───────────────────────────────────────────────────────────────

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

  // ── POST /create-agent — payment gate ──────────────────────────────────────

  const body = await readBody(req);

  // Detect which x402 version the buyer used from the header name.
  // PAYMENT-SIGNATURE = v2 (header-based challenge flow).
  // X-PAYMENT         = v1 (body-based challenge flow).
  // The x402Version we pass to OKX verify API MUST match this, or it rejects.
  const hdrV2 = req.headers['payment-signature'] as string | undefined;
  const hdrV1 = req.headers['x-payment']         as string | undefined;
  const paymentHeader  = hdrV2 ?? hdrV1;
  const detectedVersion: 1 | 2 = hdrV2 ? 2 : 1;

  if (!paymentHeader) {
    console.log('[proxy] POST /create-agent — no payment header, sending 402 challenge');
    send402(res);
    return;
  }

  console.log(`[proxy] POST /create-agent — payment header detected (x402 v${detectedVersion})`);

  // ── Idempotency: extract nonce before verify ──────────────────────────────
  // If this nonce was already processed, return the cached response immediately.
  let incomingNonce: string | undefined;
  try {
    const decoded = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf8')) as X402Payment;
    incomingNonce = decoded?.payload?.authorization?.nonce;
  } catch { /* ignore — verify will catch malformed headers */ }

  if (incomingNonce && processedNonces.has(incomingNonce)) {
    console.log(`[proxy] nonce ${incomingNonce} already processed — returning cached response`);
    const cached = processedNonces.get(incomingNonce)!;
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-PAYMENT-RESPONSE', Buffer.from(JSON.stringify({ settled: true, network: 'eip155:196' })).toString('base64'));
    res.end(cached);
    return;
  }

  // ── Verify payment ────────────────────────────────────────────────────────
  let nonce: string | undefined = incomingNonce;

  try {
    if (OKX_API_KEY && OKX_API_SECRET) {
      try {
        // Primary: OKX broker API — version MUST match detected header
        await verifyViaOkxApi(paymentHeader, detectedVersion);
        console.log('[proxy] OKX API verify: ok');
      } catch (okxErr: unknown) {
        // Fallback: local EIP-712 — OKX API unavailable or returned error
        const okxMsg = okxErr instanceof Error ? okxErr.message : String(okxErr);
        console.warn('[proxy] OKX API verify failed, falling back to local EIP-712:', okxMsg);
        nonce = await verifyLocal(paymentHeader);
        console.log('[proxy] local EIP-712 verify: ok');
      }
    } else {
      console.warn('[proxy] OKX API creds not set — using local EIP-712 verify');
      nonce = await verifyLocal(paymentHeader);
      console.log('[proxy] local EIP-712 verify: ok');
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Payment verification failed';
    console.error('[proxy] Payment rejected:', msg);
    res.statusCode = 402;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: msg }));
    return;
  }

  // ── Forward to agent-service ──────────────────────────────────────────────
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
    console.error('[proxy] Upstream error:', msg);
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Upstream service error', details: msg }));
    return;
  }

  const upstreamBody = await upstream.text();
  console.log(`[proxy] upstream responded ${upstream.status}`);

  const receipt = Buffer.from(JSON.stringify({
    settled: true,
    network: 'eip155:196',
    asset:   ASSET,
    amount:  AMOUNT,
  })).toString('base64');

  res.statusCode = upstream.status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('X-PAYMENT-RESPONSE', receipt);
  res.end(upstreamBody);

  if (upstream.ok) {
    // Cache nonce so the same payment proof can be replayed without re-payment
    if (nonce) {
      processedNonces.set(nonce, upstreamBody);
      // Evict after 2× timeout window so memory doesn't grow unbounded
      setTimeout(() => processedNonces.delete(nonce!), TIMEOUT * 2 * 1000);
    }
    // Settle async — moves USDT to PAY_TO on X Layer
    settleAsync(paymentHeader, detectedVersion);
  }

}).listen(PORT, () => {
  console.log(`[proxy] :${PORT} ready — x402 v2, eip155:196`);
  console.log(`[proxy] resource=${RESOURCE}`);
  console.log(`[proxy] upstream=${UPSTREAM_URL}`);
  console.log(`[proxy] okx-api=${OKX_API_KEY ? 'configured' : 'NOT SET — local EIP-712 only'}`);
});
