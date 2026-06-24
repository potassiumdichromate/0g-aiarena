/**
 * okx-payment-proxy — pay-walls POST /okx/create-agent (agent-service) with
 * OKX's Onchain OS Payments "charge" (one-time payment) method, per the
 * reverse-proxy integration path documented in
 * docs/okx/okx_context.md#reverse-proxy. Verified against the real published
 * type definitions of `mppx` and `@okxweb3/mpp` (not guessed from docs prose).
 *
 * STATUS: scaffold only — see docs/okx/README.md. This process is not wired
 * into docker-compose/render.yaml and will refuse to start until the four
 * required env vars below are set with real values (final price, OKX API
 * credentials, recipient address). None of those exist yet.
 */

import * as http from 'node:http';
import { Mppx } from 'mppx/server';
import { evm } from '@okxweb3/mpp/evm/server';
import { SaApiClient } from '@okxweb3/mpp/evm';

const PORT          = parseInt(process.env.PORT ?? '8090', 10);
const UPSTREAM_URL  = process.env.OKX_PROXY_UPSTREAM_URL ?? 'http://localhost:8002/okx/create-agent';
const OKX_SERVICE_KEY = process.env.OKX_SERVICE_KEY ?? '';

// ── Pricing ──────────────────────────────────────────────────────────────────
// Two of three cost components are real measurements (see docs/okx/pricing.md):
//   ~0.000474 0G token  — personality generation (0G Compute, measured 2026-06-24)
//   ~0.0020837 0G token — INFT mint gas (0G Chain, measured via eth_estimateGas)
// Still missing: 0G Storage upload cost, and the 0G→USD/USDG conversion needed
// to set these env vars for real. DO NOT set placeholder values just to make
// this start — it will charge real OKX users a wrong, unreviewed price.
const PRICE_AMOUNT   = process.env.OKX_CREATE_AGENT_PRICE_AMOUNT ?? '';   // smallest-unit string (token decimals)
const PRICE_CURRENCY = process.env.OKX_CREATE_AGENT_PRICE_CURRENCY ?? ''; // token contract address on X Layer (USDG/USD₮0)
const RECIPIENT       = process.env.OKX_PAYMENT_RECIPIENT_ADDRESS ?? '';  // our wallet to receive payment

const OKX_API_KEY      = process.env.OKX_API_KEY ?? '';
const OKX_API_SECRET    = process.env.OKX_API_SECRET_KEY ?? '';
const OKX_API_PASSPHRASE = process.env.OKX_API_PASSPHRASE ?? '';

const missing = [
  !PRICE_AMOUNT && 'OKX_CREATE_AGENT_PRICE_AMOUNT',
  !PRICE_CURRENCY && 'OKX_CREATE_AGENT_PRICE_CURRENCY',
  !RECIPIENT && 'OKX_PAYMENT_RECIPIENT_ADDRESS',
  !OKX_API_KEY && 'OKX_API_KEY',
  !OKX_API_SECRET && 'OKX_API_SECRET_KEY',
  !OKX_API_PASSPHRASE && 'OKX_API_PASSPHRASE',
].filter(Boolean);

if (missing.length > 0) {
  console.error(`[okx-payment-proxy] Refusing to start — missing: ${missing.join(', ')}. See docs/okx/pricing.md and docs/okx/README.md.`);
  process.exit(1);
}

const saClient = new SaApiClient({
  apiKey:     OKX_API_KEY,
  secretKey:  OKX_API_SECRET,
  passphrase: OKX_API_PASSPHRASE,
  onError: (info) => console.error('[okx-payment-proxy] SA API error:', info),
});

const mppx = Mppx.create({
  methods: [evm.charge({ saClient })],
  realm:   'kult-arena-agent-creator',
});

async function handler(request: Request): Promise<Response> {
  const result = await mppx.charge({
    amount:      PRICE_AMOUNT,
    currency:    PRICE_CURRENCY,
    recipient:   RECIPIENT,
    description: 'KULT — Arena Agent Creator (create-agent)',
    methodDetails: { chainId: 196, feePayer: true },
  })(request);

  if (result.status === 402) {
    return result.challenge;
  }

  // Payment verified — forward the original request body to agent-service.
  const body = await request.text();
  const upstream = await fetch(UPSTREAM_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'X-OKX-Service-Key': OKX_SERVICE_KEY },
    body,
  });
  const upstreamBody = await upstream.text();

  return result.withReceipt(
    new Response(upstreamBody, {
      status:  upstream.status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

// `handler` is a Fetch-style (Request) => Promise<Response> function — the
// same contract `mppx.charge(...)(request)` itself uses (per its own
// docstring example). `Mppx.toNodeListener` exists for the simpler case where
// you don't need to inject custom logic (e.g. our upstream forward) between
// the 402 challenge and the 200 response, so it's not used here — it
// consumes the Node request stream itself, which would conflict with reading
// the body for forwarding. Plain Node http + the Fetch Request/Response
// globals (already used above via `fetch`) cover this case directly.
async function toFetchRequest(req: http.IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(', '));
  }

  return new Request(`http://internal${req.url}`, {
    method: req.method,
    headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
  });
}

http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/create-agent') {
    res.statusCode = 404;
    res.end('Not found');
    return;
  }

  const fetchRequest = await toFetchRequest(req);
  const fetchResponse = await handler(fetchRequest);

  res.statusCode = fetchResponse.status;
  fetchResponse.headers.forEach((value, key) => res.setHeader(key, value));
  res.end(Buffer.from(await fetchResponse.arrayBuffer()));
}).listen(PORT, () => {
  console.log(`[okx-payment-proxy] listening on :${PORT}, forwarding paid requests to ${UPSTREAM_URL}`);
});
