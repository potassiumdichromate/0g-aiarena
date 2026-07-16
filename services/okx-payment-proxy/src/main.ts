/**
 * okx-payment-proxy — x402 payment gate for POST /okx/create-agent
 *
 * Correct x402 flow (per OKX onchainos docs):
 *   1. Unpaid request  → 402 + PAYMENT-REQUIRED header (base64 challenge JSON)
 *   2. Buyer signs EIP-3009 TransferWithAuthorization, replays with:
 *        PAYMENT-SIGNATURE (x402 v2) or X-PAYMENT (x402 v1) header
 *   3. We verify signature via OKX verify API (or local EIP-712 fallback)
 *   4. We settle SYNCHRONOUSLY via OKX settle API — tx must confirm before we deliver
 *   5. AFTER settlement confirmed → forward to agent-service → return 200
 *   6. Buyer CLI auto-saves 200 body as task deliverable (A2MCP flow)
 *
 * NOTE on versions: x402Version (protocol version, always 2) and extra.version
 * (EIP-712 domain version of the token, "1" for USD₮0, "2" for USDG) are
 * separate fields — they are not required to match each other.
 */

import * as http   from 'node:http';
import * as crypto from 'node:crypto';
import { verifyTypedData } from 'viem';

// ── Config ────────────────────────────────────────────────────────────────────

const PORT         = parseInt(process.env.PORT ?? '8090', 10);
const UPSTREAM_URL = process.env.OKX_PROXY_UPSTREAM_URL ?? 'http://localhost:8002/okx/create-agent';
const SERVICE_KEY  = process.env.OKX_SERVICE_KEY ?? '';

const ASSET    = process.env.X402_ASSET        ?? '0x779ded0c9e1022225f8e0630b35a9b54be713736';
const PAY_TO   = process.env.X402_PAY_TO       ?? '0xaa1860e22184852ae8b1890169b732da23459990';
const AMOUNT   = process.env.X402_AMOUNT       ?? '100000'; // 0.10 USDT (6 decimals)
const TIMEOUT  = parseInt(process.env.X402_MAX_TIMEOUT_SECONDS ?? '300', 10);
const RESOURCE = process.env.X402_RESOURCE_URL ?? 'https://aiarena-gateway.onrender.com/v1/okx/create-agent';

const OKX_API_KEY        = process.env.OKX_API_KEY         ?? '';
const OKX_API_SECRET     = process.env.OKX_API_SECRET_KEY  ?? '';
const OKX_API_PASSPHRASE = process.env.OKX_API_PASSPHRASE  ?? '';

const OKX_X402_BASE          = 'https://web3.okx.com';
const OKX_VERIFY_PATH        = '/api/v6/pay/x402/verify';
const OKX_SETTLE_PATH        = '/api/v6/pay/x402/settle';
const OKX_SETTLE_STATUS_PATH = '/api/v6/pay/x402/settle/status';

// ── EIP-712 domain for USD₮0 on X Layer ──────────────────────────────────────
// extra.version "1" = EIP-712 domain version of the USD₮0 token contract.
// This is separate from x402Version (the HTTP payment protocol version = 2).

const EIP3009_DOMAIN = {
  name:              'USD₮0',  // USD₮0 — U+20AE Mongolian Tugrik, exact on-chain name
  version:           '1',
  chainId:           196,
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

// ── Nonce cache — idempotency ─────────────────────────────────────────────────
// If buyer replays an already-settled proof, return cached response immediately.
const settledNonces = new Map<string, { body: string; txHash: string }>();

// ── Payment requirements ──────────────────────────────────────────────────────

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
    extra:             { name: 'USD₮0', version: '1' },
  };
}

// ── 402 challenge ─────────────────────────────────────────────────────────────

function send402(res: http.ServerResponse): void {
  const body = { x402Version: 2, accepts: [paymentRequirements()], error: 'Payment required' };
  const encoded = Buffer.from(JSON.stringify(body)).toString('base64');
  res.statusCode = 402;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('PAYMENT-REQUIRED', encoded);
  res.end(JSON.stringify(body));
}

// ── OKX API auth ──────────────────────────────────────────────────────────────

function okxHeaders(method: string, path: string, body: string): Record<string, string> {
  const ts      = new Date().toISOString();
  const sign    = crypto.createHmac('sha256', OKX_API_SECRET)
    .update(ts + method + path + body).digest('base64');
  return {
    'OK-ACCESS-KEY':        OKX_API_KEY,
    'OK-ACCESS-SIGN':       sign,
    'OK-ACCESS-TIMESTAMP':  ts,
    'OK-ACCESS-PASSPHRASE': OKX_API_PASSPHRASE,
  };
}

// ── Decode payment header ─────────────────────────────────────────────────────

interface Authorization {
  from: string; to: string; value: string;
  validAfter?: string; validBefore: string; nonce: string;
}
interface PaymentPayload {
  payload: { signature: string; authorization: Authorization };
}

function decodePaymentHeader(raw: string): PaymentPayload {
  try {
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as PaymentPayload;
  } catch {
    throw new Error('Payment header is not valid base64-encoded JSON');
  }
}

// ── Step 1: Verify ────────────────────────────────────────────────────────────

async function verifyViaOkxApi(raw: string, version: 1 | 2): Promise<void> {
  const paymentPayload = decodePaymentHeader(raw);
  const reqBody = JSON.stringify({ x402Version: version, paymentPayload, paymentRequirements: paymentRequirements() });
  const res = await fetch(`${OKX_X402_BASE}${OKX_VERIFY_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...okxHeaders('POST', OKX_VERIFY_PATH, reqBody) },
    body: reqBody,
  });
  if (!res.ok) throw new Error(`OKX verify API ${res.status}: ${await res.text()}`);
  const data = await res.json() as { isValid?: boolean; invalidReason?: string; invalidMessage?: string };
  if (!data.isValid) throw new Error(`Payment invalid: ${data.invalidReason ?? data.invalidMessage ?? 'rejected'}`);
}

async function verifyLocal(raw: string): Promise<string> {
  const payment = decodePaymentHeader(raw);
  const { authorization: auth, signature } = payment.payload ?? {};
  if (!auth || !signature) throw new Error('Payment payload missing authorization or signature');

  if (auth.to.toLowerCase() !== PAY_TO.toLowerCase())
    throw new Error(`Payment payTo mismatch: expected ${PAY_TO}, got ${auth.to}`);
  if (BigInt(auth.value) < BigInt(AMOUNT))
    throw new Error(`Payment amount too low: got ${auth.value}, need ${AMOUNT}`);
  if (BigInt(auth.validBefore) * 1000n < BigInt(Date.now()))
    throw new Error('Payment authorization expired');

  const valid = await verifyTypedData({
    address: auth.from as `0x${string}`,
    domain:  EIP3009_DOMAIN,
    types:   EIP3009_TYPES,
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
  if (!valid) throw new Error('Payment EIP-712 signature invalid');
  return auth.nonce;
}

// ── Step 2: Settle (SYNCHRONOUS — must complete before we deliver 200) ────────
// Per OKX docs: verify → settle → deliver. Settlement must confirm on-chain
// before the 200 response goes back to buyer. syncSettle:true waits for tx.

async function settleSync(raw: string, version: 1 | 2): Promise<string> {
  if (!OKX_API_KEY || !OKX_API_SECRET) {
    console.warn('[proxy] OKX creds not set — skipping on-chain settle');
    return '';
  }

  const paymentPayload = decodePaymentHeader(raw);
  const reqBody = JSON.stringify({
    x402Version:         version,
    paymentPayload,
    paymentRequirements: paymentRequirements(),
    syncSettle:          true,   // wait for on-chain confirmation before responding
  });
  const res = await fetch(`${OKX_X402_BASE}${OKX_SETTLE_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...okxHeaders('POST', OKX_SETTLE_PATH, reqBody) },
    body: reqBody,
  });

  const data = await res.json() as {
    success?: boolean;
    status?: string;
    transaction?: string;
    errorReason?: string;
  };

  if (!res.ok || data.status === 'failed') {
    throw new Error(`Settlement failed: ${data.errorReason ?? JSON.stringify(data)}`);
  }

  // "timeout" means tx was broadcast but confirmation timed out — still deliver,
  // the USDT transfer will confirm on-chain shortly after.
  if (data.status === 'timeout') {
    console.warn(`[proxy] settle timeout — tx submitted but unconfirmed, delivering anyway tx=${data.transaction ?? 'n/a'}`);
  } else {
    console.log(`[proxy] settle ok tx=${data.transaction ?? 'n/a'} status=${data.status}`);
  }

  return data.transaction ?? '';
}

// ── HTTP server ───────────────────────────────────────────────────────────────

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

http.createServer(async (req, res) => {
  const url = req.url ?? '/';

  // Health
  if (req.method === 'GET' && url === '/health') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', service: 'okx-payment-proxy' }));
    return;
  }

  // Liveness
  if (req.method === 'OPTIONS' && url === '/create-agent') {
    res.statusCode = 200;
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    res.end();
    return;
  }

  // x402-validate probe: GET returns 402 challenge
  if (req.method === 'GET' && url === '/create-agent') {
    send402(res);
    return;
  }

  if (req.method !== 'POST' || url !== '/create-agent') {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  // ── POST /create-agent ────────────────────────────────────────────────────

  const body = await readBody(req);

  // Detect x402 version from header name — must match what we tell OKX verify API
  const hdrV2  = req.headers['payment-signature'] as string | undefined;
  const hdrV1  = req.headers['x-payment']         as string | undefined;
  const payHdr = hdrV2 ?? hdrV1;
  const ver: 1 | 2 = hdrV2 ? 2 : 1;

  if (!payHdr) {
    console.log('[proxy] no payment header → 402 challenge');
    send402(res);
    return;
  }

  console.log(`[proxy] payment header detected (x402 v${ver})`);

  // ── Idempotency: check if nonce already settled ───────────────────────────
  let nonce: string | undefined;
  try {
    nonce = decodePaymentHeader(payHdr).payload?.authorization?.nonce;
  } catch { /* malformed — verify will catch it */ }

  if (nonce && settledNonces.has(nonce)) {
    const cached = settledNonces.get(nonce)!;
    console.log(`[proxy] nonce ${nonce} already settled — returning cached response`);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-PAYMENT-RESPONSE', Buffer.from(JSON.stringify({
      settled: true, transaction: cached.txHash, network: 'eip155:196',
    })).toString('base64'));
    res.end(cached.body);
    return;
  }

  // ── Step 1: Verify ────────────────────────────────────────────────────────
  try {
    if (OKX_API_KEY && OKX_API_SECRET) {
      try {
        await verifyViaOkxApi(payHdr, ver);
        console.log('[proxy] OKX verify: ok');
      } catch (e: unknown) {
        console.warn('[proxy] OKX verify failed, falling back to local EIP-712:', (e as Error).message);
        nonce = await verifyLocal(payHdr);
        console.log('[proxy] local verify: ok');
      }
    } else {
      console.warn('[proxy] no OKX creds — local EIP-712 only');
      nonce = await verifyLocal(payHdr);
      console.log('[proxy] local verify: ok');
    }
  } catch (e: unknown) {
    const msg = (e as Error).message ?? 'Payment verification failed';
    console.error('[proxy] verify rejected:', msg);
    res.statusCode = 402;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: msg }));
    return;
  }

  // ── Step 2: Settle (sync — wait for on-chain confirmation) ───────────────
  let txHash = '';
  try {
    txHash = await settleSync(payHdr, ver);
  } catch (e: unknown) {
    const msg = (e as Error).message ?? 'Settlement failed';
    console.error('[proxy] settle failed:', msg);
    res.statusCode = 402;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: msg }));
    return;
  }

  // ── Step 3: Forward to agent-service (deliver) ────────────────────────────
  let upstream: Response;
  try {
    upstream = await fetch(UPSTREAM_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-OKX-Service-Key': SERVICE_KEY },
      body,
    });
  } catch (e: unknown) {
    console.error('[proxy] upstream error:', (e as Error).message);
    res.statusCode = 502;
    res.end(JSON.stringify({ error: 'Upstream unreachable' }));
    return;
  }

  const upstreamBody = await upstream.text();
  console.log(`[proxy] upstream responded ${upstream.status}`);

  const receipt = Buffer.from(JSON.stringify({
    settled: true, transaction: txHash, network: 'eip155:196', asset: ASSET, amount: AMOUNT,
  })).toString('base64');

  res.statusCode = upstream.status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('X-PAYMENT-RESPONSE', receipt);
  res.end(upstreamBody);

  // Cache nonce → response for idempotency
  if (upstream.ok && nonce) {
    settledNonces.set(nonce, { body: upstreamBody, txHash });
    setTimeout(() => settledNonces.delete(nonce!), TIMEOUT * 2 * 1000);
  }

}).listen(PORT, () => {
  console.log(`[proxy] :${PORT} ready — x402 eip155:196`);
  console.log(`[proxy] resource=${RESOURCE}`);
  console.log(`[proxy] upstream=${UPSTREAM_URL}`);
  console.log(`[proxy] okx-api=${OKX_API_KEY ? 'configured' : 'NOT SET'}`);
});
