/**
 * okx-payment-proxy (Vercel) — x402 payment gate for POST /create-agent
 *
 * Ported from services/okx-payment-proxy (Render) unchanged in behavior --
 * moved here specifically because Render fronts every service with
 * Cloudflare's edge, which we found silently interferes with the
 * marketplace's task-402-pay replay client (works via curl, works against
 * two other non-Cloudflare-fronted agents in side-by-side tests, never
 * works against this endpoint while it sat behind Cloudflare). Vercel's
 * edge is not Cloudflare, so this routes around that specific problem.
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

import * as crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

// ── Config ────────────────────────────────────────────────────────────────────

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

export const UPSTREAM_HEALTH = UPSTREAM_URL.replace('/okx/create-agent', '/health');

// ── Nonce cache — idempotency ─────────────────────────────────────────────────
// Best-effort only: serverless instances are ephemeral/concurrent, so this
// in-memory cache isn't a reliable single source of truth the way it was on
// a long-lived Render process. OKX's own on-chain nonce-reuse rejection is
// the real backstop against double-settlement; this just smooths over
// same-instance retries.

const settledNonces = new Map<string, { body: string; txHash: string }>();

// ── Payment requirements ──────────────────────────────────────────────────────

export function paymentRequirements() {
  return {
    scheme:            'exact',
    network:           'eip155:196',
    asset:             ASSET,
    amount:            AMOUNT,
    payTo:             PAY_TO,
    maxTimeoutSeconds: TIMEOUT,
    extra:             { name: 'USD₮0', version: '1', decimals: 6 },
  };
}

export function resourceInfo() {
  return {
    url:         RESOURCE,
    description: 'KULT Agent Creator — create-agent (0.10 USDT on X Layer)',
    mimeType:    'application/json',
  };
}

// ── 402 challenge ─────────────────────────────────────────────────────────────

export function send402(res: ServerResponse, reason?: string, headersOnly = false): void {
  const challengeNonce = crypto.randomBytes(16).toString('hex');
  const body = { x402Version: 2, resource: resourceInfo(), accepts: [paymentRequirements()], nonce: challengeNonce, error: reason ?? 'Payment required' };
  const encoded = Buffer.from(JSON.stringify(body)).toString('base64');
  res.statusCode = 402;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('PAYMENT-REQUIRED', encoded);
  if (headersOnly) { res.end(); return; }
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

export function decodeHeader(raw: string): PaymentPayload {
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
    console.error('[proxy] settle failed after delivery (buyer was not charged twice):', d.errorReason ?? resp.msg ?? JSON.stringify(resp));
    return '';
  }
  console.log(`[proxy] settle ok tx=${d.transaction ?? 'n/a'} status=${d.status}`);
  return d.transaction ?? '';
}

// ── Body reading ──────────────────────────────────────────────────────────────

export async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

// ── Core /create-agent handling (shared across GET/HEAD/OPTIONS/POST) ────────

export async function handleCreateAgent(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'OPTIONS') {
    const body = { x402Version: 2, resource: resourceInfo(), accepts: [paymentRequirements()], error: 'Payment required' };
    res.statusCode = 200;
    res.setHeader('Allow', 'GET, HEAD, POST, OPTIONS');
    res.setHeader('PAYMENT-REQUIRED', Buffer.from(JSON.stringify(body)).toString('base64'));
    res.end();
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  // ── GET/HEAD/POST /create-agent ───────────────────────────────────────────
  // The marketplace's task-402-pay replay sends its payment as a GET request
  // (confirmed via echo test), not POST — a payment header must be honored
  // regardless of method, or a paid GET is indistinguishable from a bare
  // unpaid probe. Only fall back to a fresh 402 challenge when no payment
  // header is present.

  const body = req.method === 'POST' ? await readBody(req) : Buffer.alloc(0);

  const KNOWN_HEADERS = ['payment-signature', 'payment-sig', 'x-payment'] as const;
  let payHdr: string | undefined;
  let matchedHeaderName: string | undefined;
  for (const h of KNOWN_HEADERS) {
    const v = req.headers[h] as string | undefined;
    if (v) { payHdr = v; matchedHeaderName = h.toUpperCase(); break; }
  }
  if (!payHdr) {
    for (const [key, value] of Object.entries(req.headers)) {
      if (key.toLowerCase().includes('payment') && typeof value === 'string' && value.length > 20) {
        payHdr = value;
        matchedHeaderName = key;
        break;
      }
    }
  }
  let ver: 1 | 2 = matchedHeaderName === 'PAYMENT-SIGNATURE' || matchedHeaderName === 'PAYMENT-SIG' ? 2 : 1;
  if (payHdr) {
    try {
      const peek = decodeHeader(payHdr) as unknown as { x402Version?: number };
      if (peek.x402Version === 1) ver = 1;
      else if (peek.x402Version === 2) ver = 2;
    } catch { /* fall back to header-name guess above */ }
  }

  if (!payHdr) {
    send402(res, undefined, req.method === 'HEAD');
    return;
  }

  console.log(`[proxy] payment header detected (x402 v${ver}, method=${req.method}, header=${matchedHeaderName})`);

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
    const isNetworkError = msg.includes('fetch failed') || msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT');
    console.error(`[proxy] OKX verify ${isNetworkError ? 'unreachable' : 'rejected'}:`, msg);
    res.statusCode = isNetworkError ? 503 : 402;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: isNetworkError ? 'Payment verification service unavailable — please retry' : msg }));
    return;
  }
  try { nonce = decodeHeader(payHdr).payload?.authorization?.nonce; } catch { /* ok */ }

  // ── Step 1.5: Backfill required fields ────────────────────────────────────
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
  let upstream: Response;
  let upstreamBody: string;
  try {
    upstream = await fetch(UPSTREAM_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-OKX-Service-Key': SERVICE_KEY },
      body: new Uint8Array(forwardBody),
    });
    upstreamBody = await upstream.text();
  } catch (e: unknown) {
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
}
