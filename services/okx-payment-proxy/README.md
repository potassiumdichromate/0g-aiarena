# okx-payment-proxy

Reverse-proxy that pay-walls `POST /v1/okx/create-agent` (agent-service) using OKX's Onchain OS
Payments "charge" (one-time payment) method — the integration path described in
[`../../docs/okx/okx_context.md`](../../docs/okx/okx_context.md#reverse-proxy). See
[`../../docs/okx/create-agent-endpoint.md`](../../docs/okx/create-agent-endpoint.md) for the
endpoint this fronts.

## Status: scaffold, not deployed

This typechecks and runs against the **real** `mppx` / `@okxweb3/mpp` packages (verified by
pulling their actual published `.d.ts` files — not guessed from doc summaries). It is **not**
wired into `docker-compose.yml` or `render.yaml`, and it will refuse to start
(`process.exit(1)`) until six env vars are set with real values:

| Var | Why it's missing |
|---|---|
| `OKX_CREATE_AGENT_PRICE_AMOUNT` | Pricing isn't final — see [`../../docs/okx/pricing.md`](../../docs/okx/pricing.md). Two of three cost components are measured; storage cost and the 0G→USD rate aren't. |
| `OKX_CREATE_AGENT_PRICE_CURRENCY` | Token contract address (USDG/USD₮0) on X Layer — depends on the price being final first. |
| `OKX_PAYMENT_RECIPIENT_ADDRESS` | The wallet that should receive payment — needs deciding (treasury? service account?). |
| `OKX_API_KEY` / `OKX_API_SECRET_KEY` / `OKX_API_PASSPHRASE` | Issued by OKX's Developer Portal at ASP registration — we aren't registered yet (whitelist beta, needs an OKX PoC contact). |

Do not fill these with placeholder values to make it start — it would charge real OKX users a
wrong, unreviewed price the moment it goes live.

## How it works

```
OKX caller → (HTTP 402 challenge / payment) → okx-payment-proxy → (on verified payment)
  → forwards original request to agent-service's /okx/create-agent (X-OKX-Service-Key)
  → returns agent-service's response + payment receipt
```

`src/main.ts` builds a `Mppx.create({ methods: [evm.charge({ saClient })] })` handler (the EVM
`charge` method from `@okxweb3/mpp`, backed by an `SaApiClient` that talks to OKX's settlement
API). On a 402, the payment challenge is returned untouched. On a verified payment, the original
request is forwarded to `OKX_PROXY_UPSTREAM_URL` (default `http://localhost:8002/okx/create-agent`)
with the internal `X-OKX-Service-Key` header, and its response is wrapped with a payment receipt.

Note: this uses a manual Node↔Fetch `Request`/`Response` adapter rather than `Mppx.toNodeListener`
— the latter consumes the request body itself, which conflicts with this proxy's need to read
the body once and forward it untouched to agent-service after payment verification.

## Running it (once real values exist)

```bash
pnpm --filter @ai-arena/okx-payment-proxy dev
```

Requires the six env vars above, plus optionally `OKX_PROXY_UPSTREAM_URL`,
`OKX_SERVICE_KEY` (must match agent-service's value), and `PORT` (default `8090`).

## Why this is its own package

Everything else in `services/` is CommonJS, built/run via `tsc` + `node dist/main.js`. `mppx` and
`@okxweb3/mpp` are pure ESM — rather than changing the whole monorepo's module strategy, this
package is `"type": "module"` on its own (see `package.json`), consistent with the "reverse proxy
as a separate process" pattern OKX's own docs describe.
