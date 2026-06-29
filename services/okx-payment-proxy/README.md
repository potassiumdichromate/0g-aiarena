# okx-payment-proxy

Reverse-proxy that pay-walls `POST /v1/okx/create-agent` (agent-service) using OKX's Onchain OS
Payments "charge" (one-time payment) method — the integration path described in
[`../../docs/okx/okx_context.md`](../../docs/okx/okx_context.md#reverse-proxy). See
[`../../docs/okx/create-agent-endpoint.md`](../../docs/okx/create-agent-endpoint.md) for the
endpoint this fronts.

## Status: deployed (`aiarena-okx-payment-proxy` on Render)

This runs against the **real** `@okxweb3/mpp` package (verified by pulling its actual published
`.d.ts` files — not guessed from doc summaries) and has been smoke-tested end-to-end: a real,
unpaid `POST /create-agent` call returns a correct `402 Payment Required` challenge from
`mppx`.

Two real runtime bugs were caught only by actually running it (not by `tsc --noEmit`, which
checks types, not module resolution or byte-encoding rules):
1. A duplicate `mppx` dependency conflict — see "Why no direct `mppx` dependency" below.
2. An em-dash (`—`) in the service description broke HTTP header encoding (`ByteString`
   conversion requires Latin-1 bytes) — replaced with a plain hyphen.

Pricing defaults to **0.10 USDG per call**, paid to `0x63F63DC442299cCFe470657a769fdC6591d65eCa`
(see [`../../docs/okx/pricing.md`](../../docs/okx/pricing.md)) — override via
`OKX_CREATE_AGENT_PRICE_AMOUNT` / `OKX_CREATE_AGENT_PRICE_CURRENCY` /
`OKX_PAYMENT_RECIPIENT_ADDRESS` if needed.

Refuses to start (`process.exit(1)`) unless four env vars are set:

| Var | Source |
|---|---|
| `OKX_API_KEY` / `OKX_API_SECRET_KEY` / `OKX_API_PASSPHRASE` | Issued by OKX's Developer Portal (`https://web3.okx.com/onchainos/dev-portal`), tied to the wallet/account that owns ASP `#2170`. |
| `MPPX_SECRET_KEY` | Local HMAC secret `mppx` uses to bind/verify its own 402 challenges — **not** an OKX credential, generate with `openssl rand -hex 32` same as `OKX_SERVICE_KEY`. A leak lets attackers forge challenges; rotating it requires a restart. |

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

## Running it

```bash
pnpm --filter @ai-arena/okx-payment-proxy dev
```

Requires `OKX_API_KEY` / `OKX_API_SECRET_KEY` / `OKX_API_PASSPHRASE` / `MPPX_SECRET_KEY`, plus
optionally `OKX_PROXY_UPSTREAM_URL`, `OKX_SERVICE_KEY` (must match agent-service's value), and
`PORT` (default `8090`). `GET /health` is unauthenticated, for Render's health checks.

## Why no direct `mppx` dependency

`@okxweb3/mpp` depends on `mppx@^0.3.x` internally. An earlier version of this package also
declared `mppx@^0.7.0` directly to get the top-level `Mppx` export — pnpm installed two
incompatible copies, and the hoisted 0.7.0 copy broke at runtime
(`ERR_PACKAGE_PATH_NOT_EXPORTED` resolving `viem/tempo/chains`, a subpath only the newer mppx
expects). Fixed by importing `Mppx` from `@okxweb3/mpp`'s own root export instead — it re-exports
`Mppx` from the exact `mppx` version it depends on, so there's only ever one copy in the graph.
Caught via an actual runtime smoke test, not just `tsc --noEmit` (which doesn't catch
module-resolution-only failures like this one).

## Why this is its own package

Everything else in `services/` is CommonJS, built/run via `tsc` + `node dist/main.js`. `mppx` and
`@okxweb3/mpp` are pure ESM — rather than changing the whole monorepo's module strategy, this
package is `"type": "module"` on its own (see `package.json`), consistent with the "reverse proxy
as a separate process" pattern OKX's own docs describe.
