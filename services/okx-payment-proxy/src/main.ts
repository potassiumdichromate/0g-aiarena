/**
 * okx-payment-proxy — pay-walls POST /okx/create-agent (agent-service) with
 * OKX's Onchain OS Payments "charge" (one-time payment) method, per the
 * reverse-proxy integration path documented in
 * docs/okx/okx_context.md#reverse-proxy. Verified against the real published
 * type definitions of `mppx` and `@okxweb3/mpp` (not guessed from docs prose).
 *
 * Deployed as its own Render service (see render.yaml). Refuses to start
 * unless OKX_API_KEY / OKX_API_SECRET_KEY / OKX_API_PASSPHRASE are set.
 */

import * as http from 'node:http';
// Mppx is imported from @okxweb3/mpp's own root export (not a separate
// top-level `mppx` dependency) so it resolves against the exact mppx version
// @okxweb3/mpp itself depends on (^0.3.x) — depending on `mppx` directly
// alongside @okxweb3/mpp installs two incompatible copies and breaks at
// runtime with ERR_PACKAGE_PATH_NOT_EXPORTED inside mppx's own viem usage.
import { Mppx } from '@okxweb3/mpp';
import { evm } from '@okxweb3/mpp/evm/server';
import { SaApiClient } from '@okxweb3/mpp/evm';

const PORT          = parseInt(process.env.PORT ?? '8090', 10);
const UPSTREAM_URL  = process.env.OKX_PROXY_UPSTREAM_URL ?? 'http://localhost:8002/okx/create-agent';
const OKX_SERVICE_KEY = process.env.OKX_SERVICE_KEY ?? '';

// ── Pricing — 0.10 USDG per call (USDG contract address on X Layer) ─────────
const PRICE_AMOUNT   = process.env.OKX_CREATE_AGENT_PRICE_AMOUNT   ?? '100000';
const PRICE_CURRENCY = process.env.OKX_CREATE_AGENT_PRICE_CURRENCY ?? '0x4ae46a509f6b1d9056937ba4500cb143933d2dc8';
const RECIPIENT      = process.env.OKX_PAYMENT_RECIPIENT_ADDRESS   ?? '0x63F63DC442299cCFe470657a769fdC6591d65eCa';

const OKX_API_KEY      = process.env.OKX_API_KEY ?? '';
const OKX_API_SECRET    = process.env.OKX_API_SECRET_KEY ?? '';
const OKX_API_PASSPHRASE = process.env.OKX_API_PASSPHRASE ?? '';

// Local HMAC secret mppx uses to bind/verify its own 402 challenges — distinct
// from the OKX SA API credentials above. Per OKX's own reverse-proxy docs
// (docs/okx/okx_context.md#reverse-proxy): "a leak lets attackers forge
// Challenges, and rotation requires a proxy restart." Generate with
// `openssl rand -hex 32`, same as OKX_SERVICE_KEY.
const MPPX_SECRET_KEY = process.env.MPPX_SECRET_KEY ?? '';

const missing = [
  // Issued by OKX at ASP registration — there's no number to fill in for
  // these, they simply don't exist until then.
  !OKX_API_KEY && 'OKX_API_KEY',
  !OKX_API_SECRET && 'OKX_API_SECRET_KEY',
  !OKX_API_PASSPHRASE && 'OKX_API_PASSPHRASE',
  !MPPX_SECRET_KEY && 'MPPX_SECRET_KEY',
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
  methods:   [evm.charge({ saClient })],
  realm:     'kult-arena-agent-creator',
  secretKey: MPPX_SECRET_KEY,
});

async function handler(request: Request): Promise<Response> {
  const result = await mppx.charge({
    amount:      PRICE_AMOUNT,
    currency:    PRICE_CURRENCY,
    recipient:   RECIPIENT,
    description: 'KULT - Arena Agent Creator (create-agent)',
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
  if (req.method === 'GET' && req.url === '/health') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', service: 'okx-payment-proxy' }));
    return;
  }

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
