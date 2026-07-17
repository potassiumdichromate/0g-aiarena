/**
 * okx-payment-proxy — x402 payment gate for POST /okx/create-agent
 *
 * Correct flow (buyer-safe):
 *   1. Unpaid request  → 402 + PAYMENT-REQUIRED header (base64 challenge JSON)
 *   2. Buyer replays with PAYMENT-SIGNATURE (v2) or X-PAYMENT (v1) header
 *   3. Verify via OKX broker API — NO local fallback (local sig ≠ OKX settlement)
 *   4. Forward to agent-service — get response BEFORE settling
 *   5. If upstream returns 2xx → settle on-chain → return 200 to buyer
 *   6. If upstream fails → NO settle → buyer keeps their money, we return 503
 *
 * This order guarantees: buyer only loses USDT if we successfully deliver.
 * Never capture payment for a 502/503. Never mint an agent without OKX verification.
 */

import * as http   from 'node:http';
import * as crypto from 'node:crypto';

// ── Config ────────────────────────────────────────────────────────────────────

const PORT         = parseInt(process.env.PORT ?? '8090', 10);
const UPSTREAM_URL = process.env.OKX_PROXY_UPSTREAM_URL ?? 'http://localhost:8002/okx/create-agent';
const SERVICE_KEY  = process.env.OKX_SERVICE_KEY ?? '';

const ASSET    = process.env.X402_ASSET        ?? '0x779ded0c9e1022225f8e0630b35a9b54be713736';
const PAY_TO   = process.env.X402_PAY_TO       ?? '0xaa1860e22184852ae8b1890169b732da23459990';
const AMOUNT   = process.env.X402_AMOUNT       ?? '100000';
const TIMEOUT  = parseInt(process.env.X402_MAX_TIMEOUT_SECONDS ?? '300', 10);
const RESOURCE = process.env.X402_RESOURCE_URL ?? 'https://aiarena-gateway.onrender.com/v1/okx/create-agent';

const OKX_API_KEY        = process.env.OKX_API_KEY         ?? '';
const OKX_API_SECRET     = process.env.OKX_API_SECRET_KEY  ?? '';
const OKX_API_PASSPHRASE = process.env.OKX_API_PASSPHRASE  ?? '';

const OKX_X402_BASE   = 'https://web3.okx.com';
const OKX_VERIFY_PATH = '/api/v6/pay/x402/verify';
const OKX_SETTLE_PATH = '/api/v6/pay/x402/settle';

// Upstream health URL — used for keep-warm pings and pre-flight check
const UPSTREAM_HEALTH = UPSTREAM_URL.replace('/okx/create-agent', '/health');

// ── Nonce cache — idempotency ─────────────────────────────────────────────────

const settledNonces = new Map<string, { body: string; txHash: string }>();

// ── Payment requirements ──────────────────────────────────────────────────────
// Shape must match docs/okx/okx_context_full.md:144-152 exactly — OKX's
// verify/settle API rejects (or silently mis-validates) extra fields here.
// `resource`/`description`/`mimeType` do NOT belong in paymentRequirements —
// they belong in the separate top-level `resource` object (see resourceInfo
// below), per the documented request body at :109-153.

function paymentRequirements() {
  return {
    scheme:            'exact',
    network:           'eip155:196',
    asset:             ASSET,
    amount:            AMOUNT,
    payTo:             PAY_TO,
    maxTimeoutSeconds: TIMEOUT,
    extra:             { name: 'USD₮0', version: '1' },
  };
}

function resourceInfo() {
  return {
    url:         RESOURCE,
    description: 'KULT Agent Creator — create-agent (0.10 USDT on X Layer)',
    mimeType:    'application/json',
  };
}

// ── 402 challenge ─────────────────────────────────────────────────────────────

function send402(res: http.ServerResponse, reason?: string): void {
  const body = { x402Version: 2, resource: resourceInfo(), accepts: [paymentRequirements()], error: reason ?? 'Payment required' };
  const encoded = Buffer.from(JSON.stringify(body)).toString('base64');
  res.statusCode = 402;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('PAYMENT-REQUIRED', encoded);
  res.end(JSON.stringify(body));
}

// ── OKX API auth ──────────────────────────────────────────────────────────────

function okxHeaders(method: string, path: string, body: string): Record<string, string> {
  const ts   = new Date().toISOString();
  const sign = crypto.createHmac('sha256', OKX_API_SECRET)
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

function decodeHeader(raw: string): PaymentPayload {
  try {
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as PaymentPayload;
  } catch {
    throw new Error('Payment header is not valid base64-encoded JSON');
  }
}

// ── Verify ────────────────────────────────────────────────────────────────────

async function verifyViaOkx(raw: string, ver: 1 | 2): Promise<void> {
  const reqBody = JSON.stringify({
    x402Version:         ver,
    paymentPayload:      decodeHeader(raw),
    paymentRequirements: paymentRequirements(),
  });
  const r = await fetch(`${OKX_X402_BASE}${OKX_VERIFY_PATH}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', ...okxHeaders('POST', OKX_VERIFY_PATH, reqBody) },
    body:    reqBody,
  });
  if (!r.ok) throw new Error(`OKX verify ${r.status}: ${await r.text()}`);
  const resp = await r.json() as { code?: string; msg?: string; data?: { isValid?: boolean; invalidReason?: string; invalidMessage?: string } };
  const d = resp.data ?? {};
  if (!d.isValid) throw new Error(`Payment invalid: ${d.invalidReason ?? d.invalidMessage ?? resp.msg ?? 'rejected'}`);
}


// ── Settle ────────────────────────────────────────────────────────────────────
// Called ONLY after upstream returns 2xx — never before delivery is confirmed.

async function settle(raw: string, ver: 1 | 2): Promise<string> {
  if (!OKX_API_KEY || !OKX_API_SECRET) {
    console.warn('[proxy] no OKX creds — skipping on-chain settle');
    return '';
  }
  const reqBody = JSON.stringify({
    x402Version:         ver,
    paymentPayload:      decodeHeader(raw),
    paymentRequirements: paymentRequirements(),
    syncSettle:          true,
  });
  const r = await fetch(`${OKX_X402_BASE}${OKX_SETTLE_PATH}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', ...okxHeaders('POST', OKX_SETTLE_PATH, reqBody) },
    body:    reqBody,
  });
  const resp = await r.json() as { code?: string; msg?: string; data?: { status?: string; transaction?: string; errorReason?: string } };
  const d = resp.data ?? {};
  if (!r.ok || d.status === 'failed') {
    // Settle failed after we already delivered — log but do NOT fail the response,
    // the buyer got their agent. This is our revenue loss, not their problem.
    console.error('[proxy] settle failed after delivery (buyer was not charged twice):', d.errorReason ?? resp.msg ?? JSON.stringify(resp));
    return '';
  }
  console.log(`[proxy] settle ok tx=${d.transaction ?? 'n/a'} status=${d.status}`);
  return d.transaction ?? '';
}

// ── Keep-warm: ping upstream every 10 min to prevent Render free-tier sleep ───

function startKeepWarm(): void {
  const ping = () => {
    fetch(UPSTREAM_HEALTH, { signal: AbortSignal.timeout(5000) })
      .then(r => console.log(`[proxy] keep-warm ping → upstream ${r.status}`))
      .catch(e => console.warn('[proxy] keep-warm ping failed:', (e as Error).message));
  };
  // Also ping ourselves via health endpoint to keep this service warm
  const pingSelf = () => {
    fetch(`http://localhost:${PORT}/health`, { signal: AbortSignal.timeout(3000) })
      .catch(() => { /* self-ping best-effort */ });
  };
  setInterval(() => { ping(); pingSelf(); }, 10 * 60 * 1000); // every 10 minutes
  console.log('[proxy] keep-warm started — pinging upstream every 10 min');
}

// ── HTTP server ───────────────────────────────────────────────────────────────

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

http.createServer(async (req, res) => {
  const url = req.url ?? '/';

  if (req.method === 'GET' && url === '/health') {
    // Report upstream status so x402-check can pre-validate
    let upstreamOk = false;
    try {
      const r = await fetch(UPSTREAM_HEALTH, { signal: AbortSignal.timeout(4000) });
      upstreamOk = r.ok;
    } catch { /* upstream unreachable */ }

    res.statusCode = upstreamOk ? 200 : 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      status:   upstreamOk ? 'ok' : 'degraded',
      service:  'okx-payment-proxy',
      upstream: upstreamOk ? 'ok' : 'unreachable',
    }));
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
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  // ── POST /create-agent ────────────────────────────────────────────────────

  const body = await readBody(req);

  const hdrV2  = req.headers['payment-signature'] as string | undefined;
  const hdrV1  = req.headers['x-payment']         as string | undefined;
  const payHdr = hdrV2 ?? hdrV1;
  const ver: 1 | 2 = hdrV2 ? 2 : 1;

  if (!payHdr) {
    send402(res);
    return;
  }

  console.log(`[proxy] payment header detected (x402 v${ver})`);

  // ── Idempotency: already delivered for this nonce? ────────────────────────
  let nonce: string | undefined;
  try { nonce = decodeHeader(payHdr).payload?.authorization?.nonce; } catch { /* ok */ }

  if (nonce && settledNonces.has(nonce)) {
    const cached = settledNonces.get(nonce)!;
    console.log(`[proxy] nonce already processed — returning cached response`);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-PAYMENT-RESPONSE', Buffer.from(JSON.stringify({
      settled: true, transaction: cached.txHash, network: 'eip155:196',
    })).toString('base64'));
    res.end(cached.body);
    return;
  }

  // ── Step 1: Verify via OKX API — required, no fallback ──────────────────
  // Local EIP-712 is intentionally removed: a valid local signature does NOT
  // mean OKX will settle on-chain. Bypassing OKX verify = free agents.
  if (!OKX_API_KEY || !OKX_API_SECRET) {
    console.error('[proxy] OKX API credentials not configured — cannot verify payment');
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Payment service misconfigured' }));
    return;
  }
  try {
    await verifyViaOkx(payHdr, ver);
    console.log('[proxy] OKX verify ok');
  } catch (e: unknown) {
    const msg = (e as Error).message ?? 'Payment verification failed';
    // Distinguish OKX API being down vs payment actively rejected
    const isNetworkError = msg.includes('fetch failed') || msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT');
    console.error(`[proxy] OKX verify ${isNetworkError ? 'unreachable' : 'rejected'}:`, msg);
    res.statusCode = isNetworkError ? 503 : 402;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: isNetworkError ? 'Payment verification service unavailable — please retry' : msg }));
    return;
  }
  // Extract nonce for idempotency cache after verify passes
  try { nonce = decodeHeader(payHdr).payload?.authorization?.nonce; } catch { /* ok */ }

  // ── Step 1.5: Backfill required fields ────────────────────────────────────
  // A generic x402 buyer has no way to know agent-service requires `name` /
  // `idempotencyKey` in the body — the 402 challenge doesn't declare an
  // input schema. Backfill idempotencyKey from the payment's own nonce
  // (ties dedup to the actual payment, stronger than a caller-supplied one)
  // and a generated name, rather than rejecting a paid request as a 400.
  let forwardBody = body;
  try {
    const parsed = JSON.parse(body.toString('utf8') || '{}') as Record<string, unknown>;
    if (!parsed.idempotencyKey && nonce) parsed.idempotencyKey = nonce;
    if (!parsed.name) parsed.name = `KULT-${(nonce ?? crypto.randomUUID()).slice(2, 10)}`;
    forwardBody = Buffer.from(JSON.stringify(parsed));
  } catch {
    forwardBody = Buffer.from(JSON.stringify({
      name:           `KULT-${(nonce ?? crypto.randomUUID()).slice(2, 10)}`,
      idempotencyKey: nonce ?? crypto.randomUUID(),
    }));
  }

  // ── Step 2: Forward to upstream FIRST — before any settlement ────────────
  // If upstream is down, we return 503 and buyer keeps their money.
  let upstream: Response;
  let upstreamBody: string;
  try {
    upstream = await fetch(UPSTREAM_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-OKX-Service-Key': SERVICE_KEY },
      body: forwardBody,
    });
    upstreamBody = await upstream.text();
  } catch (e: unknown) {
    // Upstream unreachable — do NOT settle. Buyer pays nothing.
    console.error('[proxy] upstream unreachable — aborting without settlement:', (e as Error).message);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      error:   'Service temporarily unavailable — payment was NOT captured, please retry',
      settled: false,
    }));
    return;
  }

  if (!upstream.ok) {
    // Upstream returned an error — do NOT settle. Buyer pays nothing.
    console.error(`[proxy] upstream error ${upstream.status} — aborting without settlement`);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      error:   `Service error (${upstream.status}) — payment was NOT captured, please retry`,
      settled: false,
    }));
    return;
  }

  console.log(`[proxy] upstream 200 — proceeding to settle`);

  // ── Step 3: Settle on-chain — only now that delivery is confirmed ─────────
  const txHash = await settle(payHdr, ver);

  // ── Step 4: Return 200 to buyer ───────────────────────────────────────────
  const receipt = Buffer.from(JSON.stringify({
    settled: true, transaction: txHash, network: 'eip155:196', asset: ASSET, amount: AMOUNT,
  })).toString('base64');

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('X-PAYMENT-RESPONSE', receipt);
  res.end(upstreamBody);

  if (nonce) {
    settledNonces.set(nonce, { body: upstreamBody, txHash });
    setTimeout(() => settledNonces.delete(nonce!), TIMEOUT * 2 * 1000);
  }

}).listen(PORT, () => {
  console.log(`[proxy] :${PORT} ready — x402 eip155:196`);
  console.log(`[proxy] resource=${RESOURCE}`);
  console.log(`[proxy] upstream=${UPSTREAM_URL}`);
  console.log(`[proxy] okx-api=${OKX_API_KEY ? 'configured' : 'NOT SET'}`);
  startKeepWarm();
});
