# OKX OnchainOS Full Context Reference

> Compiled from https://web3.okx.com/onchainos/dev-docs (Payments, Home, Wallet, Market sections).
> Purpose: authoritative reference for the KULT Agent Creator x402 payment proxy (ASP #2170).
> All code blocks below are reproduced verbatim from the docs where the source exposed them.

---

## Table of Contents
1. [Payment System (x402)](#payment-system-x402)
2. [Core Concepts](#core-concepts)
3. [API Reference](#api-reference)
4. [SDK Usage](#sdk-usage)
5. [Wallet](#wallet)
6. [Error Handling](#error-handling)
7. [Critical Findings for ASP #2170 (version mismatch)](#critical-findings-for-asp-2170)

---

## Payment System (x402)

### What it is
OKX OnchainOS "Agent Payments Protocol" (APP) builds on two open protocols:
- **x402** — "an open payment protocol proposed by Coinbase that activates the HTTP 402 status code." The server returns a 402 with response content (amount, token, recipient); the client signs, and re-sends with the signature. Signatures use **EIP-3009** (`TransferWithAuthorization`), which lets a user "sign a transfer authorization — once a contract receives the signature, it can initiate the on-chain transfer on the user's behalf," so the buyer pays no gas.
- **MPP** — OKX's own extension for charge/session/voucher metered billing.

### Schemes implemented
| Scheme | Meaning | Recipients | Amount | Settlement | Token support |
|--------|---------|-----------|--------|-----------|---------------|
| `exact` | Direct one-time transfer, fixed amount | Single | Fixed pre-call | Sync/async | EIP-3009 stablecoins (Permit2 for any ERC-20) |
| `charge` (MPP) | One-time with splits | Up to 10 | Fixed pre-call | Sync only | EIP-3009 stablecoins |
| `upto` | Authorization ceiling; actual usage billed | Single | Cap; settled post-call ≤ cap | Sync/async | Any ERC-20 via Permit2 |
| `aggr_deferred` | Batch micropayments (Session Key + TEE) | Single | per-call | Async (TEE bundle) | Agentic Wallet only |
| `period` | Subscription (Permit2 PermitSingle + SubscriptionTerms EIP-712) | Single | recurring | scheduled | — |

### End-to-end flow (HTTP Seller)
```
Buyer → Seller: Request resource
Seller → Buyer: 402 Challenge (amount, payTo, accepted schemes)
Buyer: Sign with wallet (EIP-3009 authorization)
Buyer → Seller: Submit Credential (X-PAYMENT / PAYMENT-SIGNATURE header)
Seller → Facilitator: Verify (crypto validation + KYT screening)
[If approved]
Seller → Facilitator: Settle
Facilitator → Chain: Submit transaction
Seller → Buyer: Deliver resource (200)
```
Key point: "The Broker submits on-chain transactions, but funds flow directly from Buyer to Seller's recipient address."

### Roles / integration paths (Service Seller)
Three integration paths, "all three deliver the same business outcome; they differ only in integration point and refactor cost":
1. **Prompt-based** — AI generates integration from a SELLER.md prompt.
2. **SDK-direct** — drop Node.js/Go/Rust/Java/Python middleware onto an existing HTTP service.
3. **Reverse Proxy** — run a separate proxy without touching core logic.

The SDK/proxy "intercepts unpaid requests and returns HTTP 402 directly — they never reach your business logic." Seller needs only a receiving address; "the Broker handles all on-chain interactions for you — RPC connections, gas management, transaction submission."

---

## Core Concepts

**Challenge** (Seller → Buyer): "After the Seller places an order with the Broker, the Broker generates a payment declaration carrying `paymentId` / `realm` / `method` / `intent` / `expires` / `request body`, etc."
- `realm` — context (e.g. host `api.example.com`)
- `method` — payment rail (e.g. `evm`)
- `intent` — protocol operation (e.g. `charge`)
- `paymentId` — unique identifier
- `expires` — expiration timestamp

**Credential** (Buyer → Broker): "The signed credential the Buyer constructs and submits in response to the challenge (one of EIP-3009 / EIP-712 / Permit2 witness signature forms)."

**Broker** — intermediary responsible for verification, settlement, and state management; checks signature validity, submits verified signatures on-chain, tracks `paymentId` and persists challenges.

**Facilitator** — "designed for a single HTTP round-trip and is stateless; the Broker shoulders commercial relationships that may span many steps and many days." In practice the SDK's `OKXFacilitatorClient` is the client to the OKX-hosted verify/settle service (the Broker).

**EIP-3009** — signature foundation for one-time payments; buyer signs a `TransferWithAuthorization` and the contract executes the transfer, so the buyer pays no gas.

**Vouchers (session/pay-as-you-go)** — use EIP-712 signatures so wallets can render "you're signing a cumulative bill."

---

## API Reference

### Base URL & networks
- **Base URL:** `https://web3.okx.com`
- `exact` / `upto` prefix: `/api/v6/pay/x402`
- `charge` (MPP) prefix: `/api/v6/pay/mpp/charge`
- **Network:** X Layer only, chainId `196`, CAIP-2 `eip155:196` (testnet `eip155:1952`)

### Authentication (all endpoints)
Standard OKX API auth headers:
- `OK-ACCESS-KEY` — API Key
- `OK-ACCESS-SIGN` — request signature (HMAC-SHA256)
- `OK-ACCESS-PASSPHRASE` — API passphrase
- `OK-ACCESS-TIMESTAMP` — ISO 8601 timestamp
- `Content-Type: application/json` (POST)

Response envelope:
```json
{
  "code": "0",
  "msg": "success",
  "data": { /* business fields */ }
}
```

### GET `/api/v6/pay/x402/supported`
Query supported schemes, networks, signers. Returns a `kinds` array with protocol version, scheme (`exact`/`upto`), network, and scheme-specific config (including signer addresses per network).

### POST `/api/v6/pay/x402/verify`
Validates a buyer's signed authorization **without** executing on-chain.

Request body (verbatim example — note `x402Version: 2` and `extra.version: "2"` for USDG):
```json
{
  "x402Version": 2,
  "paymentPayload": {
    "x402Version": 2,
    "resource": {
      "url": "https://api.example.com/premium-data",
      "description": "Access to premium data",
      "mimeType": "application/json"
    },
    "accepted": {
      "scheme": "exact",
      "network": "eip155:196",
      "amount": "10000",
      "asset": "0x4ae46a509f6b1d9056937ba4500cb143933d2dc8",
      "payTo": "0xRecipientAddress",
      "maxTimeoutSeconds": 60,
      "extra": { "name": "USDG", "version": "2" }
    },
    "payload": {
      "signature": "0xf3746613c2d920b5fdabc0856f2aeb2d4f88ee6037b8cc5d04a71a4462f13480...",
      "authorization": {
        "from": "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
        "to": "0xRecipientAddress",
        "value": "10000",
        "validAfter": "0",
        "validBefore": "1740672154",
        "nonce": "0xf374661..."
      }
    }
  },
  "paymentRequirements": {
    "scheme": "exact",
    "network": "eip155:196",
    "amount": "10000",
    "asset": "0x4ae46a509f6b1d9056937ba4500cb143933d2dc8",
    "payTo": "0xRecipientAddress",
    "maxTimeoutSeconds": 60,
    "extra": { "name": "USDG", "version": "2" }
  }
}
```

Response (verify passed):
```json
{
  "code": "0",
  "msg": "success",
  "data": {
    "isValid": true,
    "invalidReason": null,
    "invalidMessage": null,
    "payer": "0xcb30ed083ad246b126a3aa1f414b44346e83e67d"
  }
}
```

### POST `/api/v6/pay/x402/settle`
Submits on-chain settlement after verify passes. Parameters:
- `x402Version` — protocol version (`2`)
- `paymentPayload` — same object as verify
- `paymentRequirements` — same as verify (for `upto`, `amount` is the actual paid amount ≤ ceiling)
- `syncSettle` — boolean, optional. `true` waits for confirmation; `false` (default) broadcasts async.

Response (sync success):
```json
{
  "code": "0",
  "msg": "success",
  "data": {
    "success": true,
    "errorReason": null,
    "errorMessage": null,
    "payer": "0xcb30ed083ad246b126a3aa1f414b44346e83e67d",
    "transaction": "0x4f46ed8eac92ddbccfb56a88ff827db3616c7beb191adabbeeded901340bd7d5",
    "network": "eip155:196",
    "status": "success"
  }
}
```
Status values: `success` (confirmed), `pending` (async broadcast), `timeout` (wait exceeded), `failed` (verification/simulation error).

### GET `/api/v6/pay/x402/settle/status?txHash={hash}`
Polls settlement by tx hash:
```json
{
  "code": "0",
  "msg": "success",
  "data": {
    "success": true,
    "payer": "0xcb30ed083ad246b126a3aa1f414b44346e83e67d",
    "transaction": "0x4f46ed8eac92ddbccfb56a88ff827db3616c7beb191adabbeeded901340bd7d5",
    "network": "eip155:196",
    "status": "success",
    "amount": null
  }
}
```

### `upto` scheme notes
- EOA path = secp256k1 signature; SESSION path = Ed25519 (OKX agentic wallet with `sessionCert`).
- `witness.facilitator` must be set and allowlisted; `permitted.amount` = ceiling; settle amount ≤ ceiling.
- Zero-settle returns `transaction=null`, `status=success`, `amount="0"` with no on-chain tx.

### `charge` (MPP) endpoints
POST `/api/v6/pay/mpp/charge/settle` — server-side submission with EIP-3009 authorization, supports splits (≤10 recipients):
```json
{
  "challenge": {
    "id": "qB3wErTyU7iOpAsD9fGhJk",
    "realm": "api.example.com",
    "method": "evm",
    "intent": "charge",
    "request": "eyJhbW91bnQiOiIxMDAwMCIsImN1cnJlbmN5Ijoi...",
    "expires": "2026-04-01T12:05:00Z"
  },
  "payload": {
    "type": "transaction",
    "authorization": {
      "type": "eip-3009",
      "from": "0x1234567890abcdef1234567890abcdef12345678",
      "to": "0x742d35Cc6634c0532925a3b844bC9e7595F8fE00",
      "value": "10000",
      "validAfter": "0",
      "validBefore": "9999999999",
      "nonce": "0x9337d07c707c703b86f05e66b9097e38e7587e7ecfe740551ac608693864abdd",
      "signature": "0x5a9827232b5c640d7239462dbb3f0eede1aa2522eb53e552369db8db66720293..."
    }
  }
}
```
Response:
```json
{
  "code": "0",
  "msg": "",
  "data": {
    "method": "evm",
    "reference": "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
    "status": "success",
    "timestamp": "2026-04-01T12:04:30Z",
    "chainId": 196,
    "challengeId": "qB3wErTyU7iOpAsD9fGhJk",
    "externalId": "order-12345"
  }
}
```
POST `/api/v6/pay/mpp/charge/verifyHash` — client-side pre-broadcast verification:
```json
{
  "challenge": { /* same as above */ },
  "payload": {
    "type": "hash",
    "hash": "0xd9a703784f0cb489ea90c52f5626a22516f39c5063558733bb742972fdf6f722"
  },
  "source": "did:pkh:eip155:196:0x1234567890abcdef1234567890abcdef12345678"
}
```

### Agent API (A2A) one-time payment
POST `/api/v6/pay/a2a/payment/create` (auth required). Fields: `type:"charge"`, `amount` (decimal string), `symbol`, `recipient`, `externalId` (idempotency), `expiresIn` (default 1800s).
```json
{
  "code": "0",
  "msg": "success",
  "data": {
    "paymentId": "a2a_01HZX8Q9RK3JWYV7M2N5T8P4AB",
    "status": "pending",
    "challenge": { /* MPP challenge */ },
    "deliveries": [
      { "type": "url", "value": "https://pay.okx.com/p/{paymentId}" }
    ]
  }
}
```
Status poll: GET `/api/v6/pay/a2a/p/{paymentId}/status` (public). Status: `pending`, `settling`, `completed`, `failed`, `expired`. Completed includes `executed.txHash`, `executed.blockNumber`, `fee`.

### Supported networks & tokens
| Network | ChainId | CAIP-2 |
|---------|---------|--------|
| X Layer Mainnet | 196 | `eip155:196` |
| X Layer Testnet | 1952 | `eip155:1952` |

| Token | Contract Address | EIP-712 domain `version` (from docs examples) |
|-------|------------------|-----------------------------------------------|
| USDG  | `0x4ae46a509f6b1d9056937ba4500cb143933d2dc8` | `"2"` |
| USD₮0 | `0x779ded0c9e1022225f8e0630b35a9b54be713736` | `"1"` |

> "Free for a limited time: zero gas on X Layer when paying with USDG / USD₮0."
> NOTE: testnet examples use USD₮0 at `0x9e29b3aada05bf2d2c827af80bd28dc0b9b4fb0c` with `version: "1"`.

---

## SDK Usage

Five SDKs: Node.js, Go, Rust, Java, Python. Packages (Node.js): `@okxweb3/x402-core` (client/server/facilitator/types/subscriptions), `@okxweb3/x402-evm` (exact/aggr_deferred/period schemes), framework middleware (`@okxweb3/x402-express`, Next.js, Hono, Fastify), buyer-side HTTP clients (fetch/axios), plus MCP integration and `@okxweb3/mpp` for charge/session.

### Node.js — install
```bash
npm install express @okxweb3/x402-express @okxweb3/x402-core @okxweb3/x402-evm
npm install -D typescript tsx @types/express @types/node
```

### Node.js — HTTP Seller (exact scheme) — VERBATIM
```typescript
import express from "express";
import {
  paymentMiddleware,
  x402ResourceServer,
} from "@okxweb3/x402-express";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";
import { OKXFacilitatorClient } from "@okxweb3/x402-core";

const app = express();
const NETWORK = "eip155:196";
const PAY_TO = process.env.PAY_TO_ADDRESS || "0xYourWalletAddress";

const facilitatorClient = new OKXFacilitatorClient({
  apiKey: "OKX_API_KEY",
  secretKey: "OKX_SECRET_KEY",
  passphrase: "OKX_PASSPHRASE",
});

const resourceServer = new x402ResourceServer(facilitatorClient);
resourceServer.register(NETWORK, new ExactEvmScheme());

app.use(
  paymentMiddleware(
    {
      "GET /generateImg": {
        accepts: [{
          scheme: "exact",
          network: NETWORK,
          payTo: PAY_TO,
          price: "$0.01",
        }],
        description: "AI Image Generation Service",
        mimeType: "application/json",
      },
    },
    resourceServer,
  ),
);

app.get("/generateImg", (_req, res) => {
  res.json({
    success: true,
    imageUrl: "https://placehold.co/512x512/png?text=AI+Generated",
    prompt: "a sunset over mountains",
    timestamp: new Date().toISOString(),
  });
});

app.listen(4000, () => {
  console.log("[Seller] Image generation service listening at http://localhost:4000");
});
```

Testnet switch:
```diff
- const NETWORK = "eip155:196";    // X Layer Mainnet
+ const NETWORK = "eip155:1952";   // X Layer Testnet
```

### Node.js SDK server-side primitives
Register schemes on `x402ResourceServer`, then:
- `buildPaymentRequirements()` — build the 402 requirements object
- `verifyPayment()` — verify incoming credential (calls facilitator `/verify`)
- `settlePayment()` — settle (calls facilitator `/settle`)
- `x402HTTPResourceServer` wrapper adds HTTP routing, 402 response generation, and lifecycle hooks: `onBeforeVerify`, `onAfterSettle`, etc.

The `paymentMiddleware` handles the whole loop automatically: intercept → 402 (if no valid header) → on X-PAYMENT header, verify → settle → deliver. `syncSettle: true` in the route's `accepts` makes the middleware wait for on-chain confirmation before returning 200.

### One-time route with syncSettle (VERBATIM excerpt)
```typescript
const facilitator = new OKXFacilitatorClient({...});
const resourceServer = new x402ResourceServer(facilitator)
  .register("eip155:196", new ExactEvmScheme());

app.use(paymentMiddleware({
  "GET /api/premium": {
    accepts: [{
      scheme: "exact",
      network: "eip155:196",
      payTo: "0x...",
      price: "$0.10",
      syncSettle: true
    }]
  }
}, resourceServer));
```

### Reverse Proxy (no code changes)
Intercepts requests → verify credential → strip buyer creds, inject upstream creds → forward. "The buyer never sees your upstream credentials."
Dependencies: `@okxweb3/mpp`, `mppx` (≥0.3.15), `viem` (≥2.21).
Local HMAC key required:
```bash
openssl rand -base64 32   # → MPPX_SECRET_KEY (rotation requires proxy restart)
```
Route modes: `mppx.charge` (one-time per request), `mppx.session` (pay-as-you-go channel), `true` (free passthrough). Auto-exposes `/llms.txt`, `/discover`, `/discover/<serviceId>`. Non-matching routes return 404 (never forwarded).

### Other language installs (reference)
```bash
# Go
go get github.com/okx/payments/go/x402
# Python
pip install okxweb3-app-x402 fastapi uvicorn
```
```toml
# Rust (Cargo.toml)
okxweb3-app-x402-axum = "0.2"
okxweb3-app-x402-core = "0.2"
okxweb3-app-x402-evm  = "0.2"
```

### Batch / subscription notes
- **Batch (`aggr_deferred`)** requires Agentic Wallet (Session Keys + TEE). Register `AggrDeferredEvmScheme`. Buyer gets resource on `status=success`; on-chain settlement is async via `submitBundle tryAggregate`.
- **Subscription (`period`)** two-signature model: Permit2 `PermitSingle` + `SubscriptionTerms` EIP-712; needs a persistent `SubscriptionStore`.

---

## Wallet

**Agentic Wallet** — "a dedicated onchain wallet for AI Agents — turning them from query assistants into onchain executors that can hold assets, sign, and submit transactions."
- **TEE security**: "Private keys are untouchable — Generated and stored within a TEE secure environment, AI Agents can trade but cannot access the keys."
- Pre-execution risk simulation and scoring; identity verification, address blacklist filtering, token risk alerts.
- ~20 chains (X Layer, Ethereum, Solana, ...). Zero gas on X Layer. Up to 50 sub-wallets. Email login, no seed phrase.
- For x402: the Agentic Wallet detects a 402 (or a `pay.okx.com` link), signs the EIP-3009 authorization (Session Key for batch), and replays the request with the payment header — transparently to the agent.

---

## Error Handling

### x402 verify/settle validation failures
`insufficient_balance`, `insufficient_allowance`, `invalid_signature`, `expired`, `not_yet_valid`.

### Market/payment error codes (full table, verbatim)
| Error Code | Meaning | Troubleshooting |
|-----------|---------|-----------------|
| Empty / null response | Request did not include PAYMENT-SIGNATURE or X-PAYMENT header | Include required headers after signing |
| invalid payment header | PAYMENT-SIGNATURE content is invalid | Check for truncation, encoding issues, or multiple base64 nesting |
| param_mismatch | Missing required fields or invalid parameters (address / nonce format) | Verify signature parameters match expected values |
| toAddr mismatch | PayTo address does not match or is zero address | Ensure address matches exactly; avoid 0x0000… |
| amount mismatch | Signed amount does not match returned amount | Ensure EIP-3009 signature value equals returned amount |
| unsupported_chain | Parsed chainIndex from network is not supported | Only X Layer (eip155:196) currently supported |
| payer_blocked | authorization.from triggered risk control rules | Contact OKX support or risk team |
| risk_address | Payer or payTo is flagged (blacklist / sanctioned address) | Use different address |
| resource mismatch | Signed URL does not match request URL | Use exact request URL when signing |
| no matching payment option | Payment token does not match required token | Sign using token specified in response |
| invalid_signature | Invalid signature format (length, r/s range, v value, etc.) | Use OKXEvmSigner; avoid manual EIP-712 construction |
| not_yet_valid | validAfter > now | Check system time |
| expired | validBefore <= now | Check system time |
| invalid signature, nonce_used | Nonce already used on-chain | Generate new 32-byte nonce and sign again |
| insufficient_balance | Insufficient balance | Fund account or reduce concurrent payments |
| onchain_error | On-chain RPC / multicall failure | Retry request |
| payment processing | Duplicate request within cache window | Avoid signature reuse within cache period |

### API error codes (HTTP one-time)
- Authentication (401): 50103–50113
- Request errors: 50011, 50014
- Business: 81001 (parameter), 81004 (unsupported chain), 80007 (risky address)

---

## Critical Findings for ASP #2170

### 1. Correct `x402Version`
**`x402Version` must be the integer `2`.** It appears in three places, all `2`:
- top-level of the verify/settle request body,
- inside `paymentPayload`,
- inside the buyer's base64 X-PAYMENT payload.

### 2. What `extra.version` must be
**`extra.version` is the ERC-20 token's EIP-712 domain `version` string — NOT the x402 protocol version.** `extra` = `{ name, version }` = the EIP-712 domain `name` and `version` of the payment token contract, used to build the EIP-3009 `TransferWithAuthorization` signing domain. Docs examples prove the two numbers are independent and are *supposed* to differ:
- USDG example: `x402Version: 2`, `extra: { "name": "USDG", "version": "2" }`
- USD₮0 example: `x402Version: 2`, `extra: { "name": "USD₮0", "version": "1" }`

So `x402Version: 2` with `extra.version: "1"` is **not** inherently a mismatch — it is correct for USD₮0. The relevant equality is: `extra.version` MUST equal the on-chain token contract's actual EIP-712 domain version. If it does not, the domain separator the server rebuilds differs from what the buyer signed, `ecrecover` yields the wrong signer, and verify returns `invalid_signature` / rejects every otherwise-valid signature.

### 3. Correct server-side verification of an incoming X-PAYMENT / PAYMENT-SIGNATURE header
The buyer sends a base64-encoded JSON payload in either `X-PAYMENT` or `PAYMENT-SIGNATURE`:
```json
{
  "x402Version": 2,
  "resource": { "url": "/api/v1/pay/mock-merchant/resource", "mimeType": "application/json" },
  "accepted": {
    "scheme": "exact",
    "network": "eip155:1952",
    "asset": "0x9e29b3aada05bf2d2c827af80bd28dc0b9b4fb0c",
    "amount": "10000",
    "payTo": "0x3509655ad99effc7f3f74205482b1cb337ca08f7",
    "maxTimeoutSeconds": 60,
    "extra": { "name": "USD₮0", "version": "1" }
  },
  "payload": {
    "signature": "0x...",
    "authorization": {
      "from": "0x...",
      "nonce": "0x...",
      "to": "0x3509655ad99effc7f3f74205482b1cb337ca08f7",
      "validAfter": "0",
      "validBefore": "...",
      "value": "10000"
    }
  }
}
```
Server steps (what `verifyPayment()` / POST `/api/v6/pay/x402/verify` does):
1. Read the header, base64-decode to JSON → `paymentPayload`.
2. Build `paymentRequirements` from the route's expected `accepts` (scheme/network/asset/amount/payTo/extra) — must match what was in the 402.
3. POST `{ x402Version: 2, paymentPayload, paymentRequirements }` to `/api/v6/pay/x402/verify` (or call `resourceServer.verifyPayment()`).
4. If `data.isValid === true` → proceed to settle; else return the 402/error. If the header is missing entirely the response is an empty/null validation → return 402 (this is the ONLY case where re-returning 402 is correct).

### 4. Correct settle call after verification
POST `/api/v6/pay/x402/settle` with `{ x402Version: 2, paymentPayload, paymentRequirements, syncSettle }` (or `resourceServer.settlePayment()`). `syncSettle: true` waits for confirmation. Success → `data.status === "success"` with `data.transaction` = tx hash. Then deliver the resource with HTTP 200. Poll GET `/api/v6/pay/x402/settle/status?txHash=…` for async.

### 5. Node.js SDK for the payment server
Use `@okxweb3/x402-express` + `@okxweb3/x402-core` + `@okxweb3/x402-evm`. The `paymentMiddleware(routes, resourceServer)` performs the full verify→settle→deliver loop automatically; you do not hand-roll header parsing. `OKXFacilitatorClient({ apiKey, secretKey, passphrase })` is the client to OKX's verify/settle broker. See the verbatim Node.js seller code in [SDK Usage](#sdk-usage).

### Recommended fix for the two reviewer defects

**Defect A — "version mismatch" (verifier rejects all valid signatures).**
The reviewer is conflating two independent fields. Do NOT set `extra.version` equal to `x402Version`. Instead:
- Keep `x402Version = 2` everywhere.
- Set `extra.version` to the **token contract's real EIP-712 domain version**. Query it on-chain (`eip712Domain()` returns the version, or read `version()` / the DOMAIN_SEPARATOR) rather than hard-coding. For the OKX-listed tokens on X Layer: **USD₮0 → `"1"`, USDG → `"2"`.**
- Also set `extra.name` to the token's EIP-712 domain `name` (`"USD₮0"` or `"USDG"`), and ensure the same `{ name, version, chainId, verifyingContract=asset }` domain is used to build the challenge, is echoed in the 402 `accepts.extra`, and is what the server rebuilds at verify time. The buyer signs against this domain; any drift → wrong recovered signer → universal rejection.
- Best practice per docs error table: sign/verify with `OKXEvmSigner` / the SDK schemes; "avoid manual EIP-712 construction," which is the common cause of `invalid_signature`.

Net: the mismatch is fixed not by forcing `extra.version` to `2`, but by making `extra.version` match the token's true domain version and using the identical domain on both signing and verification sides. If your proxy is currently overriding `extra.version` with the x402 protocol number, remove that override.

**Defect B — endpoint re-returns 402 instead of verifying/delivering when X-PAYMENT is present.**
Per the error table, an empty/null verification result means "request did not include PAYMENT-SIGNATURE or X-PAYMENT header." Your proxy is likely not reading the header the buyer actually sent, or is regenerating a fresh challenge instead of running the verify→settle path. Fix:
- Accept BOTH header names (`X-PAYMENT` and `PAYMENT-SIGNATURE`); OKX buyers/mock-merchant use `PAYMENT-SIGNATURE`.
- Base64-decode the header to `paymentPayload` and, when present, run `verifyPayment()` → on `isValid` run `settlePayment()` → deliver 200. Only emit 402 when the header is absent/invalid.
- Confirm the facilitator/settlement leg is actually wired: `OKXFacilitatorClient` must have valid `apiKey/secretKey/passphrase`, target base URL `https://web3.okx.com`, and reach `/api/v6/pay/x402/verify` and `/settle`. A silent facilitator failure surfaces as a repeated 402.
- Preserve nonce idempotency: a re-sent proof for an already-settled nonce should return the cached success/deliver, not a new challenge (avoids `nonce_used`).

**Settlement working checklist:** valid OKX API creds (key/secret/passphrase, HMAC-SHA256 signed with `OK-ACCESS-*` headers) → network `eip155:196` → supported token (USDG/USD₮0) with correct `asset` address and matching `extra` domain → `syncSettle:true` for the reviewer's test so `status:"success"` + `transaction` hash returns before you deliver.
