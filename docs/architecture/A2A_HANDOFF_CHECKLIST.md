# A2A Marketplace — Deployment Runbook

Operational guide for deploying the A2A marketplace to Base mainnet. Each step
requires an operator action — a key, a funded wallet, a database migration, or
a configuration decision. Follow in order; later steps depend on earlier
outputs.

`render.yaml` is kept accurate as documentation, but since you are deploying
manually it is a **reference for settings**, not something Render will read.
Every value you need is reproduced below.

Last updated: 2026-08-17.

---

## Step 0 — Rotate the legacy 0G operator key (prerequisite)

`EVM_DEPLOYER_PRIVATE_KEY` / `ZEROG_STORAGE_PRIVATE_KEY` = `0x309b…9150`
→ address `0x63F63DC442299cCFe470657a769fdC6591d65eCa`.

This key is present in `.env.example` in the repository history and retains
oracle and owner authority on `AIArenaINFT`, as well as signing 0G Storage
uploads.

**Nothing that touches USDC may reuse it.** `hardhat.config.ts` already
enforces this structurally — the `base` network reads `BASE_DEPLOYER_PRIVATE_KEY`,
a deliberately different variable, so a Base deploy cannot accidentally pick up
the 0G key.

Rotate it and everything downstream (JWT secrets, custodial encryption key, OKX
API credentials) before going further.

---

## Step 1 — Generate five secrets

Four are wallets, one is a symmetric encryption key.

```bash
node -e "const {Wallet}=require('ethers');for(const n of ['DEPLOYER','RELAYER','VERIFIER','ARBITER']){const w=Wallet.createRandom();console.log(n.padEnd(9),w.address,w.privateKey)}"
```

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

| Secret | Env var | Purpose | Must differ from |
|---|---|---|---|
| Deployer | `BASE_DEPLOYER_PRIVATE_KEY` | Deploys the escrow, keeps `DEFAULT_ADMIN_ROLE` (pause/config) | the 0G deployer |
| Relayer | `BASE_RELAYER_PRIVATE_KEY` | `RELAYER_ROLE` — drives job state, pays all gas | verifier |
| Verifier | `A2A_VERIFIER_PRIVATE_KEY` | `VERIFIER_ROLE` — judges outcomes | relayer |
| Arbiter | address → `A2A_ARBITER_ADDRESS` | `ARBITER_ROLE` — splits disputed escrow | both |
| Agent key encryption | `AGENT_WALLET_ENCRYPTION_KEY` | AES-256-GCM for stored agent signing keys | — |

**The deploy script refuses to run if relayer and verifier are the same
address.** That is threat T3 (one key that both drives a job and judges it),
and it is a hard failure, not a warning.

⚠️ **`AGENT_WALLET_ENCRYPTION_KEY` is not rotatable in place.** Changing it
without re-encrypting existing rows permanently orphans every stored agent
signing key. Set it once, back it up.

### Fund these wallets with ETH on Base

| Wallet | Amount | Why |
|---|---|---|
| Deployer | ~0.003 ETH | One deploy + three `grantRole` transactions |
| Relayer | ongoing | Pays gas for **every** job: post, fund, executing, deliver |
| Verifier | ongoing | Pays gas per verdict |
| Each creator agent EOA | ~0.0005 ETH each | ERC-8004 records `msg.sender` as the reviewer, so an agent must sign its own feedback |

Agents need **no** ETH to fund escrow — that path is EIP-3009, where the agent
signs and the relayer pays. The agent-EOA gas is only for publishing reputation.

---

## Step 2 — Database migration

Migrations are committed and verified: all 16 apply cleanly from an empty
database with zero drift against the schema.

**On Render, run `migrate deploy` — never `migrate dev`.**

```bash
cd ~/project/src/packages/db-client
npx prisma migrate deploy
```

`migrate dev` is a development command. Against a production database it can
detect drift and offer to **reset it**, wiping agents, battles and league data.
It also needs a shadow database, and it writes migration files to the instance
disk on Render, where they are lost on the next deploy. `migrate deploy` only
applies migration files that already exist in the repo, which is what you want.

Mind the path: Render puts the checkout at `~/project/src`, and a service shell
opens in that service's own `rootDir`, so a relative `cd packages/db-client`
fails.

Covers: `AgentBaseIdentity`, `AgentCapabilitySnapshot`, `A2AJob`,
`A2ANegotiation`, `A2ANegotiationMessage`, plus the execution, verification
and reputation columns on `A2AJob`.

---

## Step 3 — Verify the reused Base addresses

Before writing a single transaction against them:

```bash
cd contracts/evm && pnpm verify:base:addresses
```

Confirms USDC (`0x8335…2913`), the ERC-8004 IdentityRegistry
(`0x8004A169…`) and ReputationRegistry (`0x8004BAa1…`) are really what we
think they are, on-chain. These are reused, not deployed — they are canonical
and audited.

---

## Step 4 — Deploy the escrow — DONE

```
A2AJobEscrow  0x20f04e3D088b3CFa70FD608acf08783AA6429877
```

Deployed and source-verified on Base mainnet. Confirmed against the chain:

| | |
|---|---|
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Treasury | `0x043091b10bBcD3F8C5158C27AD291CC56B4F46db` |
| Commission | 1000 bps (10%) |
| Paused | false |
| AGREEMENT_TYPEHASH | matches a2a-protocol exactly |

Roles, audited on-chain — every wallet holds exactly one, nothing overlaps:

| wallet | role |
|---|---|
| `0x4304683F…a92a` | DEFAULT_ADMIN only |
| `0xFeF00117…214f` | RELAYER only |
| `0x50f30472…e498` | VERIFIER only |
| `0x7E8a87F7…fA8f` | ARBITER only |

The relayer cannot render verdicts and the verifier cannot drive job state, so
threat T3 holds in practice and not merely by intent.

### Operational scripts

Deployment is split into separate, individually resumable steps so that a
network interruption never leaves the contract in an ambiguous state:

```bash
pnpm check:a2a:deploy    # did it land? is re-running the deploy safe?
pnpm grant:a2a:roles     # idempotent, resumable role grants
pnpm verify:a2a:base     # source verification via Etherscan V2
```

Do not re-run `deploy:a2a:base` to add missing roles — it deploys a new escrow,
and EIP-712 signatures are bound to the contract address. Use
`grant:a2a:roles`, which is idempotent.

### Contract verification uses the Etherscan V2 API

BaseScan’s V1 API has been retired in favour of the Etherscan V2 unified
endpoint. Use `pnpm verify:a2a:base`, which targets V2 directly. An existing
BaseScan API key is valid against V2 without change.

### RPC

The public endpoint rate-limits heavily and drops connections. Set a dedicated
one before Step 5, since the relayer hits it on every job:

```bash
BASE_RPC_URL=https://base-rpc.publicnode.com
```

---

## Step 5 — Deploy services on Render (manual)

Four services. Create them in this order — each depends on the one before.

> **Paste only the value.** Cells written as *(secret)* or *(paste)* describe
> what to supply rather than being literal text. Render validates several
> fields against a restricted character set and rejects anything containing
> parentheses or punctuation, so an explanatory note copied alongside a value
> will fail rather than be ignored.

### Shared settings for all three Node services

- **Repository / Branch**: this repo, your deploy branch
- **Region**: Oregon (match the existing services, or latency and DB egress suffer)
- **Runtime**: Node
- **Instance type**: Starter
- **Auto-Deploy**: your preference

Manual creation does **not** wire `fromDatabase` links. For `DATABASE_URL`,
copy the **Internal Database URL** from `aiarena-db` and paste it.

`INTERNAL_SERVICE_SECRET` must be **byte-identical** across the gateway,
base-chain, marketplace and evaluation services. A mismatch shows up as 401s
between services, not as a config error.

---

### 5a. `aiarena-base-chain` — the Base relayer

| Field | Value |
|---|---|
| Type | Web Service |
| Root Directory | `services/base-chain-service` |
| Health Check Path | `/health` |

**Build Command**
```
cd ../.. && pnpm install --ignore-scripts && packages/db-client/node_modules/.bin/prisma generate --schema=packages/db-client/prisma/schema.prisma && node_modules/.bin/turbo run build --filter=@ai-arena/base-chain-service...
```

**Start Command**
```
node dist/main.js
```

**Environment**

| Key | Value |
|---|---|
| `PORT` | `8051` |
| `NODE_ENV` | `production` |
| `DATABASE_URL` | *(paste internal DB URL)* |
| `BASE_RPC_URL` | `https://mainnet.base.org` |
| `BASE_RELAYER_PRIVATE_KEY` | *(secret)* |
| `AGENT_WALLET_ENCRYPTION_KEY` | *(secret)* |
| `A2A_PUBLIC_BASE_URL` | `https://aiarena-base-chain.onrender.com` |
| `ERC8004_REPUTATION_REGISTRY_ADDRESS` | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |
| `A2A_JOB_ESCROW_ADDRESS` | *(from Step 4)* |
| `INTERNAL_SERVICE_SECRET` | *(secret, shared)* |
| `ZEROG_NETWORK` | `mainnet` |
| `ZEROG_STORAGE_PRIVATE_KEY` | *(rotated key from Step 0)* |

`A2A_PUBLIC_BASE_URL` becomes the ERC-8004 `tokenURI` host. Changing it after
agents are registered breaks their published registration files.

---

### 5b. `aiarena-a2a-marketplace` — job meaning

| Field | Value |
|---|---|
| Type | Web Service |
| Root Directory | `services/a2a-marketplace-service` |
| Health Check Path | `/health` |

**Build Command**
```
cd ../.. && pnpm install --ignore-scripts && packages/db-client/node_modules/.bin/prisma generate --schema=packages/db-client/prisma/schema.prisma && node_modules/.bin/turbo run build --filter=@ai-arena/a2a-marketplace-service...
```

**Start Command**: `node dist/main.js`

| Key | Value |
|---|---|
| `PORT` | `8080` |
| `NODE_ENV` | `production` |
| `DATABASE_URL` | *(paste)* |
| `BASE_CHAIN_SERVICE_URL` | `https://aiarena-base-chain.onrender.com` |
| `A2A_JOB_ESCROW_ADDRESS` | *(from Step 4)* |
| `BASE_CHAIN_ID` | `8453` |
| `INTERNAL_SERVICE_SECRET` | *(shared)* |
| `ZEROG_NETWORK` | `mainnet` |
| `ZEROG_COMPUTE_API_KEY` | *(secret)* |
| `ZEROG_STORAGE_PRIVATE_KEY` | *(secret)* |

Without `A2A_JOB_ESCROW_ADDRESS` this service **refuses to sign anything**
rather than guessing a domain — negotiation will error clearly.

---

### 5c. `aiarena-evaluation` — the verifier

| Field | Value |
|---|---|
| Type | Web Service |
| Root Directory | `services/evaluation-service` |
| Health Check Path | `/health` |

**Build Command**
```
cd ../.. && pnpm install --ignore-scripts && packages/db-client/node_modules/.bin/prisma generate --schema=packages/db-client/prisma/schema.prisma && node_modules/.bin/turbo run build --filter=@ai-arena/evaluation-service...
```

**Start Command**: `node dist/main.js`

| Key | Value |
|---|---|
| `PORT` | `8081` |
| `NODE_ENV` | `production` |
| `DATABASE_URL` | *(paste)* |
| `BASE_RPC_URL` | `https://mainnet.base.org` |
| `A2A_JOB_ESCROW_ADDRESS` | *(from Step 4)* |
| `A2A_VERIFIER_PRIVATE_KEY` | *(secret — NOT the relayer key)* |
| `INTERNAL_SERVICE_SECRET` | *(shared)* |
| `ZEROG_NETWORK` | `mainnet` |
| `ZEROG_STORAGE_PRIVATE_KEY` | *(secret)* |

Its `/health` reports whether the key actually holds `VERIFIER_ROLE` on-chain.
Check it after deploy — a misconfigured verifier looks healthy right up until
the first verdict reverts.

---

### 5d. `aiarena-training-worker` — real trait training

Not a web service. No HTTP surface.

| Field | Value |
|---|---|
| Type | **Background Worker** |
| Runtime | **Docker** |
| Dockerfile Path | `./workers/training-worker/Dockerfile` |
| Docker Build Context | `.` |

| Key | Value |
|---|---|
| `DATABASE_URL` | *(paste)* |
| `TRAINING_POLL_INTERVAL_S` | `5` |
| `TRAINING_STALE_AFTER_S` | `300` |
| `TRAINING_CHECKPOINT_DIR` | `/tmp` |

The build context is a single dot: the repo root. It has to be the root rather
than `workers/training-worker`, because the worker imports `ml/trait_training`,
which imports `ml/reinforcement_learning` and `ml/behaviour_cloning`.


CPU only — the environment is 32 features over 7 actions, no GPU plan needed.
Jobs are claimed with `FOR UPDATE SKIP LOCKED`, so scaling to more than one
replica is safe and each claims a distinct row.

⚠️ A Starter instance will be **noticeably slower** than the ~4.5 min/job
measured on 16 cores. Size this against your demo timing.

---

## Step 6 — Update the existing gateway

Add to `aiarena-gateway`'s environment, then redeploy it:

| Key | Value |
|---|---|
| `BASE_CHAIN_SERVICE_URL` | `https://aiarena-base-chain.onrender.com` |
| `A2A_MARKETPLACE_SERVICE_URL` | `https://aiarena-a2a-marketplace.onrender.com` |

**This is not optional.** The gateway's routing table falls back to
`http://localhost:8080`, so without it every `/v1/marketplace/*` call 500s in
production. (I found this missing while writing this doc and fixed
`render.yaml`; the dashboard still needs it set by hand.)

**Frontend needs no new env var.** The marketplace client goes through the
existing `VITE_AI_ARENA_GATEWAY_URL`.

---

## Step 7 — Smoke test, in order

```bash
curl https://aiarena-base-chain.onrender.com/health
curl https://aiarena-a2a-marketplace.onrender.com/health
curl https://aiarena-evaluation.onrender.com/health    # check role.hasVerifierRole === true
curl https://aiarena-gateway.onrender.com/v1/marketplace/jobs
```

Then, with two agents registered:

1. Post a job in the UI → confirm → a real Base tx appears
2. Fetch `/v1/marketplace/jobs/:id/requirements.json` and check the hash
   reproduces against the chain
3. Open a negotiation, converge, sign the agreement
4. Fund escrow — watch USDC move on BaseScan

---

## Verifier key — reviewed, retained

**Decision: retain the existing verifier key.** Recorded for traceability.

What happened: `A2A_VERIFIER_PRIVATE_KEY` was pasted into Render with 30 stray
characters after a newline. ethers rejected the whole string, and
evaluation-service returned that raw error on its public `/health`, so the
first 64 hex characters — the real key — were served in plaintext. The key was
confirmed to derive to `0x50f30472EB90FEe62927471847Bb2A4947FDe498`, the
address holding `VERIFIER_ROLE`.

Fixed in 736dc00: both evaluation-service and base-chain-service now classify
health errors instead of echoing them, so this cannot recur.

The exposure window was short and the URL was not published. The owner judged
the risk acceptable and chose not to rotate.

**What the key can do if it ever is compromised:** `VERIFIER_ROLE` accepts or
rejects a delivered job, and an accepted verdict releases escrowed USDC to the
provider in the same transaction. It cannot choose the payee — that is fixed at
funding from a signature both agents produced — so the worst case is paying a
real provider for work that did not meet its target, not redirecting funds to
an arbitrary address.

**If you change your mind**, it is one command plus a re-paste:

```bash
cd contracts/evm
ROLE=VERIFIER NEW_ADDRESS=0x<new> OLD_ADDRESS=0x50f30472EB90FEe62927471847Bb2A4947FDe498 pnpm rotate:a2a:role
```

Grant, revoke and verification in one run, about $0.001 in gas.

---

## Decisions only you can make

1. **Commission** — currently 10% (`commissionBps = 1000`), hard-capped at 20%,
   locked per job at funding.
2. **Treasury address** — `A2A_TREASURY_ADDRESS` defaults to the deployer.
3. **Arbiter** — until `A2A_ARBITER_ADDRESS` is granted, disputed jobs cannot
   be resolved and will sit until a timeout refund.
4. **Provider floors** — `decideProviderResponse` needs a `floorBaseUnits` per
   provider agent. No UI for it yet; set via the API.
5. **Security review of `A2AJobEscrow` before real money.** 42 tests pass
   including the full failure matrix, but tests are not an audit.

---

## Current scope and roadmap

### Planned next
- **The Python worker never sets `A2AJob.verificationSnapshotId`.** The
  evaluation service reads that field and refuses to settle without it. The
  chain is: worker runs verification → sets the field → verifier settles. The
  middle link is missing. It fails loudly rather than settling on a wrong
  number, but a job will not reach SETTLE unaided today.
- **`publishJobFeedback` is never called automatically.** The endpoint works
  (`POST /v1/a2a/reputation/jobs/:jobId/publish`) but nothing invokes it after
  settlement.

### Interface roadmap
- **Negotiation is read-only.** The API client has `sendOffer`,
  `providerRespond` and `signAgreement`; no controls are rendered. Drive
  negotiation through the API for now.

### Pre-existing repository items
- `contracts/evm/test/AIArenaINFT.test.ts` — fails since the first commit
  (`incorrect number of arguments to constructor`). `pnpm test` in
  `contracts/evm` will show 1 failing; the A2A suites pass.
- `src/types/aiArenaGateway.ts` — 12 TypeScript errors (duplicate declarations
  with mismatched modifiers). Confirmed pre-existing by stashing local changes.
  The production build succeeds regardless.

### Documented design boundaries
- **Verification is a trusted oracle.** The verifier key can accept bad work.
  Mitigated by publishing seeds, difficulty ladder and the full report so fraud
  is *detectable*. Say this plainly to Base; do not claim trustlessness.
- **Concurrent negotiations can all reach AGREED.** The on-chain
  `fundWithAuthorization` resolves the race (second funder gets `not fundable`),
  but nothing off-chain tells the loser, and the UI will show a stale AGREED.
- **Eligibility is checked at negotiation open, not at funding.**

---

## What is built

| Phase | State |
|---|---|
| 1 Foundations, agent identity | Built — ERC-8004 registration, agent EOAs (AES-256-GCM), cards on 0G Storage |
| 2 Real trait training | Built — CPU-only, seeded, reproducible. Traits measured, never written |
| 3 Capability + discovery | Built — ladder chosen from measurement, not intuition |
| 4 Job creation + registration | Built — canonical hashing, NL parsing with deterministic fallback |
| 5 Negotiation + agreement | Built — hash-chained signed transcript, contract/TS digest cross-check |
| 6 Escrow + settlement | Built — EIP-3009 funding, verdict payout, permissionless timeout refund |
| 7 Verification | Service built; worker link missing (see above) |
| 8 Reputation | Built — ERC-8004 feedback + settled-jobs-only aggregate; auto-publish not wired |
| 9 Frontend | Board, post flow, job detail, lifecycle rail, live training progress built; negotiation controls not |

```
a2a-protocol       60 pass
capability         24 pass
A2AJobEscrow       42 pass   (9 agreement + 33 money path)
trait_training     45 pass
```

Typechecks clean across `base-chain-service`, `a2a-marketplace-service`,
`evaluation-service`, `api-gateway`, `a2a-protocol`, `capability`. Frontend
builds.
