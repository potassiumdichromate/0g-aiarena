# Creator Studio Subscription — Node.js Backend Integration

Everything needed to integrate `CreatorStudioSubscription` (0G Chain mainnet, chainId **16661**) into a Node.js backend. Contract source: [`contracts/evm/contracts/creator/CreatorStudioSubscription.sol`](../contracts/evm/contracts/creator/CreatorStudioSubscription.sol).

## 0. Live deployment

| | |
|---|---|
| **Contract** | `0x9A37E7c93747bA987D75Af9Ff7864fe59b56019E` |
| **Network** | 0G Chain mainnet, chainId 16661 |
| **Explorer** | https://chainscan.0g.ai/address/0x9A37E7c93747bA987D75Af9Ff7864fe59b56019E |
| **Deploy tx** | `0xf29c6967c1f242d10e418db0e2c3ad30dd3eae89a2fff4a86748f32f2618cf7d` (block 39966698) |
| **Treasury** | `0x043091b10bBcD3F8C5158C27AD291CC56B4F46db` |
| **Admin / Relayer** | `0x043091b10bBcD3F8C5158C27AD291CC56B4F46db` (same wallet — see §3) |
| **Prices on chain** | Free 0 / Plus 10 0G / Pro 25 0G per 30 days |
| **EIP-712 domain** | `AIArena Creator Studio` v`1`, chainId `16661` |

Source is **not yet verified** on chainscan — run the `hardhat verify` command in §3 to publish it.

---

## 1. What the contract does

Tiered subscription billing paid in **native 0G**.

| Tier | Enum value | Price | Duration |
|------|-----------|-------|----------|
| Free Creator | `0` | 0 0G | never expires |
| Creator Plus | `1` | 10 0G | 30 days |
| Creator Pro | `2` | 25 0G | 30 days |

- A subscription is keyed to the **wallet address**. There is no user id on-chain — your backend joins wallet → user.
- Every 0G collected is forwarded to the treasury **in the same transaction** that collects it. The contract is not a vault; the only balance it holds is unspent user credit, tracked in `totalCredit()`.
- Treasury: `0x043091b10bBcD3F8C5158C27AD291CC56B4F46db`
- "Per month" is a fixed **30 days** (`PERIOD`), never a calendar month.

### Tier changes never destroy value

Upgrading or downgrading converts unused time on the old tier to its 0G value at the old rate, then back into seconds at the new rate. 15 days of Plus (5 0G of value) becomes 6 days of Pro on top of whatever is purchased. No refund ever has to leave the treasury. Use `previewExpiry()` to show the exact resulting date before the user signs.

---

## 2. Read this before building the "gasless" flow

**0G is the native gas token of 0G Chain, not an ERC-20.** There is no `permit` / `transferFrom` for native value: a native transfer can only originate from the account that owns the funds, and originating a transaction means paying its gas. So "the relayer pays the gas *and* the fee leaves the user's wallet in the same step" is **not expressible on this chain** by any contract. Don't burn time looking for a contract trick — there isn't one, short of ERC-4337 / EIP-7702 account abstraction.

What the contract does instead is compress the user's gas cost into **exactly one transaction**, after which everything is signature-only:

| Flow | User pays gas? | Wallet popup | When to use |
|------|---------------|--------------|-------------|
| **A — Direct** `subscribe()` | Yes (once, ~negligible on 0G) | Transaction confirm | Default. One click, instant. |
| **B — Gasless** `depositCredit()` → `subscribeWithSignature()` | Only on the one top-up | Signature request (free) | Recurring subscribers. Top up 6–12 months, then never send a tx again. |
| **C — Sponsored** `depositCreditFor()` → `subscribeWithSignature()` | Never | Signature request (free) | Promos, free trials, fiat/card purchases settled off-chain. Deployer pays fee *and* gas. |

In flows B and C the relayer (your deployer wallet) submits the transaction and pays its gas. The user only ever signs an EIP-712 message — MetaMask shows a readable "Signature request", costs nothing, and cannot be broadcast by anyone but your relayer.

**Recommended default:** offer flow A as the primary button, and flow B as "Enable auto-renew — never pay gas again" during checkout.

---

## 3. Deployment

```bash
cd contracts/evm
pnpm compile
pnpm deploy:creator:mainnet
```

Script: [`scripts/deploy-creator-studio.ts`](../contracts/evm/scripts/deploy-creator-studio.ts). It prints the address, reads the deployed state back as proof, and prints the exact `hardhat verify` command.

To publish the source for the live deployment:

```bash
cd contracts/evm && npx hardhat verify --network zerog-mainnet 0x9A37E7c93747bA987D75Af9Ff7864fe59b56019E 0x043091b10bBcD3F8C5158C27AD291CC56B4F46db 0x043091b10bBcD3F8C5158C27AD291CC56B4F46db 0x043091b10bBcD3F8C5158C27AD291CC56B4F46db 10000000000000000000 25000000000000000000
```

> **Live deployment caveat.** `EVM_DEPLOYER_PRIVATE_KEY` is defined twice in the root `.env` (lines 157 and 278) with two *different* wallets; dotenv takes the last, so Hardhat used `0x043091b1…4F46db` — the treasury wallet. Deployer, admin, relayer and treasury are therefore all one address. That address's key must **not** be placed in a running backend as `CREATOR_RELAYER_PRIVATE_KEY`; rotate `RELAYER_ROLE` to a dedicated hot wallet first (§3, `grantRole`), then `revokeRole` from the treasury.

Deploy-time env (root `.env`):

```bash
EVM_DEPLOYER_PRIVATE_KEY=0x...        # already present — pays deploy gas
CREATOR_TREASURY_ADDRESS=0x043091b10bBcD3F8C5158C27AD291CC56B4F46db
CREATOR_ADMIN_ADDRESS=                # optional; multisig recommended on mainnet
CREATOR_RELAYER_ADDRESS=              # optional; defaults to deployer
CREATOR_PLUS_PRICE_0G=10
CREATOR_PRO_PRICE_0G=25
```

Runtime env for the backend service:

```bash
ZEROG_EVM_RPC_MAINNET=https://evmrpc.0g.ai
ZEROG_CHAIN_ID_MAINNET=16661
CREATOR_SUBSCRIPTION_ADDRESS=0x...    # printed by the deploy script
CREATOR_RELAYER_PRIVATE_KEY=0x...     # the wallet holding RELAYER_ROLE
```

> Use a **dedicated relayer key** in production, not the deployer key. Grant it `RELAYER_ROLE` and keep the deployer/admin key cold:
> ```bash
> cast send $CREATOR_SUBSCRIPTION_ADDRESS "grantRole(bytes32,address)" \
>   $(cast keccak "RELAYER_ROLE") $NEW_RELAYER --rpc-url https://evmrpc.0g.ai
> ```

Export the ABI into your service:

```bash
node -e "const a=require('./contracts/evm/artifacts/contracts/creator/CreatorStudioSubscription.sol/CreatorStudioSubscription.json');require('fs').writeFileSync('services/creator-service/src/abi/CreatorStudioSubscription.json',JSON.stringify(a.abi,null,2))"
```

---

## 4. Contract wiring (`src/contracts.ts`)

Follows the same shape as `services/arena-chain-service/src/contracts.ts`.

```ts
import { ethers } from 'ethers';
import CreatorStudioSubscriptionAbi from './abi/CreatorStudioSubscription.json';

export const TIER = { FREE: 0, PLUS: 1, PRO: 2 } as const;
export type TierValue = (typeof TIER)[keyof typeof TIER];
export const TIER_NAME: Record<number, string> = {
  0: 'Free Creator',
  1: 'Creator Plus',
  2: 'Creator Pro',
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} not configured`);
  return value;
}

let _provider: ethers.JsonRpcProvider | null = null;
export function getProvider(): ethers.JsonRpcProvider {
  if (!_provider) {
    _provider = new ethers.JsonRpcProvider(requireEnv('ZEROG_EVM_RPC_MAINNET'), {
      chainId: Number(process.env.ZEROG_CHAIN_ID_MAINNET ?? 16661),
      name: '0g-mainnet',
    });
  }
  return _provider;
}

let _relayer: ethers.Wallet | null = null;
export function getRelayerSigner(): ethers.Wallet {
  if (!_relayer) {
    _relayer = new ethers.Wallet(requireEnv('CREATOR_RELAYER_PRIVATE_KEY'), getProvider());
  }
  return _relayer;
}

/** Read-only handle — never needs the relayer key. */
export function subscriptionRead(): ethers.Contract {
  return new ethers.Contract(
    requireEnv('CREATOR_SUBSCRIPTION_ADDRESS'),
    CreatorStudioSubscriptionAbi,
    getProvider(),
  );
}

/** Relayer-signed writes: subscribeWithSignature, renewFromCredit, depositCreditFor. */
export function subscriptionWrite(): ethers.Contract {
  return new ethers.Contract(
    requireEnv('CREATOR_SUBSCRIPTION_ADDRESS'),
    CreatorStudioSubscriptionAbi,
    getRelayerSigner(),
  );
}
```

---

## 5. Reading subscription state

`subscriptionOf(address)` returns everything in one call — use it rather than several round trips.

```ts
export interface SubscriptionState {
  wallet: string;
  tier: number;              // stored tier — may be a LAPSED paid tier
  tierName: string;
  effectiveTier: number;     // what the user is entitled to RIGHT NOW
  active: boolean;
  startedAt: Date | null;
  expiresAt: Date | null;    // null for Free (never expires)
  renewals: number;
  autoRenew: boolean;
  creditWei: bigint;
  credit0G: string;
}

const NO_EXPIRY = 2n ** 64n - 1n;

export async function getSubscription(wallet: string): Promise<SubscriptionState> {
  const c = subscriptionRead();
  const s = await c.subscriptionOf(wallet);

  const tier = Number(s.tier);
  const effectiveTier = s.active ? tier : TIER.FREE;

  return {
    wallet: ethers.getAddress(wallet),
    tier,
    tierName: TIER_NAME[effectiveTier],
    effectiveTier,
    active: s.active,
    startedAt: s.startedAt === 0n ? null : new Date(Number(s.startedAt) * 1000),
    expiresAt: s.expiresAt === NO_EXPIRY ? null : new Date(Number(s.expiresAt) * 1000),
    renewals: Number(s.renewals),
    autoRenew: s.autoRenew,
    creditWei: s.creditBalance,
    credit0G: ethers.formatEther(s.creditBalance),
  };
}
```

> **Critical:** `tier` is the *stored* tier and stays set after expiry. Always gate features on `active === true`, or on `effectiveTier` / the `currentTier(address)` view, which already returns `Free` for a lapsed subscription.

### Quoting a purchase

```ts
export async function quote(wallet: string, tier: TierValue, periods: number) {
  const c = subscriptionRead();
  const [q, expiresAt] = await Promise.all([
    c.quote(wallet, tier, periods),
    c.previewExpiry(wallet, tier, periods),
  ]);

  return {
    costWei: q.cost.toString(),
    cost0G: ethers.formatEther(q.cost),
    creditWei: q.creditBalance.toString(),
    /** 0 means credit covers it — the gasless path is available. */
    dueNowWei: q.dueNow.toString(),
    dueNow0G: ethers.formatEther(q.dueNow),
    gaslessAvailable: q.dueNow === 0n,
    newExpiresAt: expiresAt === NO_EXPIRY ? null : new Date(Number(expiresAt) * 1000),
  };
}
```

`previewExpiry` includes tier-change carry-over, so the date it returns is exactly what the user will get. Show it in the confirm dialog.

---

## 6. Flow A — direct payment (frontend only, no backend)

The backend does not participate. Give the frontend the address, ABI and the cost from `quote()`.

```ts
// Frontend — ethers v6 + injected wallet
const contract = new ethers.Contract(CREATOR_SUBSCRIPTION_ADDRESS, abi, signer);

const { cost } = await contract.quote(await signer.getAddress(), 2 /* Pro */, 1);
const tx = await contract.subscribe(2, 1, { value: cost });
const receipt = await tx.wait();
```

MetaMask shows one confirm dialog with the 0G amount and gas. On success the fee is already in the treasury.

Notes:
- Sending **more** than `cost` is safe — the excess becomes withdrawable credit and pre-funds later gasless renewals. It is never lost.
- Sending **less** reverts with `InsufficientPayment(required, supplied)`.
- Buy multiple months by raising `periods` (max 24): `subscribe(1, 12, { value: cost })` for a year of Plus.
- Activate the free plan with `subscribe(0, 0)` and no value.

After `tx.wait()`, have the frontend POST the tx hash so the backend can confirm and refresh its cache immediately rather than waiting for the indexer:

```ts
// POST /v1/creator/confirm  { txHash }
const receipt = await getProvider().getTransactionReceipt(txHash);
if (!receipt || receipt.status !== 1) throw new Error('Transaction not confirmed');

const iface = new ethers.Interface(CreatorStudioSubscriptionAbi);
const contractAddress = requireEnv('CREATOR_SUBSCRIPTION_ADDRESS').toLowerCase();

for (const log of receipt.logs) {
  if (log.address.toLowerCase() !== contractAddress) continue;   // ignore foreign logs
  const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
  if (parsed?.name === 'Subscribed') {
    await upsertSubscriptionFromChain(parsed.args.account);      // re-read subscriptionOf
  }
}
```

Never trust a client-supplied tier or amount — always re-read `subscriptionOf()` from chain.

---

## 7. Flow B/C — gasless (EIP-712 + relayer)

### 7.1 The typed data

The domain and types must match the contract byte for byte:

```ts
export const EIP712_DOMAIN = {
  name: 'AIArena Creator Studio',
  version: '1',
  chainId: 16661,
  verifyingContract: process.env.CREATOR_SUBSCRIPTION_ADDRESS!,
};

export const EIP712_TYPES = {
  SubscribeRequest: [
    { name: 'account',   type: 'address' },
    { name: 'tier',      type: 'uint8'   },
    { name: 'periods',   type: 'uint8'   },
    { name: 'autoRenew', type: 'bool'    },
    { name: 'maxCost',   type: 'uint256' },
    { name: 'nonce',     type: 'uint256' },
    { name: 'deadline',  type: 'uint256' },
  ],
};
```

Field meanings:

| Field | Notes |
|-------|-------|
| `account` | Subscriber. Credit is drawn from this account. Must equal the signer. |
| `tier` | 0 / 1 / 2 |
| `periods` | 0 for Free, 1–24 otherwise |
| `autoRenew` | Consent for the relayer to auto-renew from credit near expiry |
| `maxCost` | **Slippage guard.** Max wei the user authorizes. Set it to `cost` (or `cost * 105 / 100`). If an admin raises the price before the signature is relayed, the tx reverts instead of overcharging. |
| `nonce` | Must equal `nonces(account)`. Consumed on success — each signature is single-use. |
| `deadline` | Unix seconds. Use 15–60 min. |

### 7.2 Backend: build the request to sign

```ts
// POST /v1/creator/subscribe/prepare  { wallet, tier, periods, autoRenew }
export async function prepareSubscribeRequest(
  wallet: string,
  tier: TierValue,
  periods: number,
  autoRenew: boolean,
) {
  const c = subscriptionRead();
  const [q, nonce] = await Promise.all([c.quote(wallet, tier, periods), c.nonces(wallet)]);

  if (q.dueNow > 0n) {
    // Not enough credit — the user must top up first (flow B) or you sponsor
    // them with depositCreditFor (flow C). Fall back to flow A otherwise.
    return {
      ready: false,
      reason: 'INSUFFICIENT_CREDIT',
      topUpWei: q.dueNow.toString(),
      topUp0G: ethers.formatEther(q.dueNow),
    };
  }

  const request = {
    account: ethers.getAddress(wallet),
    tier,
    periods,
    autoRenew,
    maxCost: q.cost.toString(),
    nonce: nonce.toString(),
    deadline: Math.floor(Date.now() / 1000) + 30 * 60,
  };

  return { ready: true, domain: EIP712_DOMAIN, types: EIP712_TYPES, request };
}
```

### 7.3 Frontend: sign (no gas, no transaction)

```ts
const { domain, types, request } = await api.post('/v1/creator/subscribe/prepare', {
  wallet, tier: 2, periods: 1, autoRenew: true,
});

// Wallet shows a free "Signature request" — no gas, nothing broadcast.
const signature = await signer.signTypedData(domain, types, request);

await api.post('/v1/creator/subscribe/relay', { request, signature });
```

wagmi equivalent:

```ts
const signature = await signTypedDataAsync({
  domain, types, primaryType: 'SubscribeRequest', message: request,
});
```

### 7.4 Backend: relay it

```ts
export async function relaySubscribe(request: SubscribeRequestDto, signature: string) {
  // 1. Verify the signature locally BEFORE spending gas on a doomed tx.
  const recovered = ethers.verifyTypedData(EIP712_DOMAIN, EIP712_TYPES, request, signature);
  if (recovered.toLowerCase() !== request.account.toLowerCase()) {
    throw new BadRequest('Signature does not match account');
  }

  // 2. Re-validate against live chain state — the client controls these fields.
  const c = subscriptionRead();
  const [nonce, q] = await Promise.all([
    c.nonces(request.account),
    c.quote(request.account, request.tier, request.periods),
  ]);
  if (nonce !== BigInt(request.nonce)) throw new Conflict('Stale nonce — re-sign');
  if (BigInt(request.deadline) <= BigInt(Math.floor(Date.now() / 1000))) throw new BadRequest('Expired');
  if (q.cost > BigInt(request.maxCost)) throw new Conflict('Price moved — re-sign');
  if (q.dueNow > 0n) throw new BadRequest('Insufficient credit');

  // 3. Simulate, so a revert costs nothing and yields a decoded reason.
  const contract = subscriptionWrite();
  await contract.subscribeWithSignature.staticCall(request, signature);

  // 4. Send under the relayer nonce lock (§7.5).
  const tx = await withRelayerNonce((overrides) =>
    contract.subscribeWithSignature(request, signature, overrides),
  );
  const receipt = await tx.wait();

  await upsertSubscriptionFromChain(request.account);
  return { txHash: receipt.hash, blockNumber: receipt.blockNumber };
}
```

> `subscribeWithSignature` is gated on `RELAYER_ROLE`. A leaked signature is therefore useless to anyone else — only your relayer can execute it.

### 7.5 Relayer nonce management (do not skip)

One key, concurrent requests, and ethers' default `pending` nonce fetch will hand the same nonce to two transactions — the second is dropped with `replacement transaction underpriced`. Serialize sends:

```ts
let noncePromise: Promise<number> | null = null;
let queue: Promise<unknown> = Promise.resolve();

export function withRelayerNonce<T>(
  send: (overrides: { nonce: number }) => Promise<T>,
): Promise<T> {
  const run = queue.then(async () => {
    const signer = getRelayerSigner();
    if (!noncePromise) noncePromise = signer.getNonce('pending');
    const nonce = await noncePromise;
    noncePromise = Promise.resolve(nonce + 1);

    try {
      return await send({ nonce });
    } catch (err) {
      noncePromise = null;   // resync from chain on the next call
      throw err;
    }
  });

  queue = run.catch(() => undefined);   // one failure must not poison the queue
  return run;
}
```

For higher throughput, run 2–4 relayer keys and round-robin. Each holds `RELAYER_ROLE` and its own nonce lock.

Alert when the relayer balance drops below a threshold — an empty relayer silently breaks every gasless flow:

```ts
const balance = await getProvider().getBalance(getRelayerSigner().address);
if (balance < ethers.parseEther('5')) logger.error({ balance: ethers.formatEther(balance) }, 'Relayer low');
```

### 7.6 Credit top-up (flow B) and sponsoring (flow C)

Top-up is a plain frontend transaction — the one time the user pays gas:

```ts
// Frontend. Fund 6 months of Pro up front.
const tx = await contract.depositCredit({ value: ethers.parseEther('150') });
await tx.wait();
```

A plain 0G transfer to the contract address does the same thing (`receive()` credits the sender), so an exchange withdrawal straight to the contract works as a top-up.

Sponsoring from the backend — the user never sends a transaction at all:

```ts
export async function sponsorCredit(wallet: string, amount0G: string) {
  const contract = subscriptionWrite();
  const tx = await withRelayerNonce((overrides) =>
    contract.depositCreditFor(wallet, { value: ethers.parseEther(amount0G), ...overrides }),
  );
  return (await tx.wait()).hash;
}
```

Use this for free trials, promo credit, or credit bought with a card. Pair it with `subscribeWithSignature` and the user's whole subscription is fee-free and gas-free.

Credit is always the user's own money: `withdrawCredit(uint256)` returns it on demand (pass `ethers.MaxUint256` for the full balance), and it stays callable while the contract is paused. `sweep()` is bounded by `sweepable()` and can only ever remove balance *above* `totalCredit()`, so no admin can touch it.

---

## 8. Auto-renew worker

Users who signed with `autoRenew: true` (or called `setAutoRenew(true)`) can be renewed by the relayer once they are inside `RENEW_WINDOW` (3 days) of expiry and hold enough credit. The window is enforced on-chain, so a compromised relayer cannot drain credit early or in bulk.

```ts
const RENEW_INTERVAL_MS = 60 * 60 * 1000; // hourly is plenty for a 3-day window

export async function runAutoRenewSweep() {
  const c = subscriptionRead();
  const contract = subscriptionWrite();

  // Candidates from your own DB — cheaper than scanning the chain.
  const candidates = await prisma.creatorSubscription.findMany({
    where: {
      autoRenew: true,
      tier: { gt: 0 },
      expiresAt: { lte: new Date(Date.now() + 3 * 24 * 3600 * 1000) },
    },
    select: { wallet: true },
  });

  for (const { wallet } of candidates) {
    try {
      // The contract's own predicate: window + consent + sufficient credit.
      if (!(await c.isDueForRenewal(wallet))) continue;

      await contract.renewFromCredit.staticCall(wallet);
      const tx = await withRelayerNonce((o) => contract.renewFromCredit(wallet, o));
      await tx.wait();

      await upsertSubscriptionFromChain(wallet);
      logger.info({ wallet, txHash: tx.hash }, 'auto-renewed');
    } catch (err) {
      // Most common: InsufficientCredit. Notify the user to top up; do not retry hard.
      logger.warn({ wallet, err: decodeContractError(err) }, 'auto-renew skipped');
    }
  }
}
```

Send a "top up to keep Creator Pro" notification when `isDueForRenewal` is false *because* of credit — check `credit(wallet) < tierPrice(tier)` — ideally 5–7 days before expiry, before the renew window even opens.

---

## 9. Event indexer

Mirror on-chain events into Postgres. Follows the `contract.on` approach used in `services/arena-chain-service/src/indexer.ts` (0G's RPC has no websocket endpoint in this deployment, so ethers polls under the hood).

```ts
export function startCreatorIndexer() {
  const c = subscriptionRead();

  c.on('Subscribed', async (account, tier, payer, periods, cost, expiresAt, gasless, event) => {
    await prisma.creatorSubscriptionEvent.create({
      data: {
        wallet: account.toLowerCase(),
        eventName: 'Subscribed',
        tier: Number(tier),
        periods: Number(periods),
        amount0G: ethers.formatEther(cost),
        expiresAt: new Date(Number(expiresAt) * 1000),
        gasless,
        payer: payer.toLowerCase(),
        txHash: event.log.transactionHash,
        blockNumber: event.log.blockNumber,
        logIndex: event.log.index,
      },
    });
    await upsertSubscriptionFromChain(account);
  });

  c.on('AutoRenewed', async (account) => upsertSubscriptionFromChain(account));
  c.on('CreditDeposited', async (account) => upsertSubscriptionFromChain(account));
  c.on('CreditWithdrawn', async (account) => upsertSubscriptionFromChain(account));
  c.on('CreditSpent', async (account) => upsertSubscriptionFromChain(account));
}
```

Full event list:

| Event | Signature |
|-------|-----------|
| `Subscribed` | `(address indexed account, uint8 indexed tier, address indexed payer, uint8 periods, uint256 cost, uint64 expiresAt, bool gasless)` |
| `AutoRenewed` | `(address indexed account, uint8 indexed tier, uint256 cost, uint64 expiresAt)` |
| `AutoRenewSet` | `(address indexed account, bool enabled)` |
| `CreditDeposited` | `(address indexed account, address indexed from, uint256 amount, uint256 balance)` |
| `CreditWithdrawn` | `(address indexed account, address indexed to, uint256 amount, uint256 balance)` |
| `CreditSpent` | `(address indexed account, uint256 amount, uint256 balance)` |
| `PaymentForwarded` | `(address indexed to, uint256 amount)` |
| `TierPriceUpdated` | `(uint8 indexed tier, uint256 oldPrice, uint256 newPrice)` |
| `TreasuryUpdated` | `(address indexed oldTreasury, address indexed newTreasury)` |
| `Swept` | `(address indexed to, uint256 amount)` |

A dropped provider connection silently stops events until restart. Add a backfill on boot, and keep it idempotent with a unique index on `(txHash, logIndex)`:

```ts
const last = await prisma.creatorSubscriptionEvent.aggregate({ _max: { blockNumber: true } });
const fromBlock = (last._max.blockNumber ?? DEPLOY_BLOCK) + 1;
const current = await getProvider().getBlockNumber();

for (let start = fromBlock; start <= current; start += 2000) {   // RPCs cap log ranges
  const logs = await c.queryFilter('Subscribed', start, Math.min(start + 1999, current));
  for (const log of logs) await persistSubscribedLog(log);
}
```

Because the DB is only ever a **mirror**, the chain stays the source of truth: on any doubt, re-read `subscriptionOf()`.

---

## 10. Prisma schema

```prisma
model CreatorSubscription {
  wallet     String   @id                 // lowercase checksum-normalised
  userId     String?  @unique
  tier       Int      @default(0)         // 0 Free, 1 Plus, 2 Pro
  active     Boolean  @default(false)
  startedAt  DateTime?
  expiresAt  DateTime?                    // null = Free / never expires
  renewals   Int      @default(0)
  autoRenew  Boolean  @default(false)
  creditWei  String   @default("0")       // bigint as decimal string
  syncedAt   DateTime @updatedAt

  @@index([expiresAt])
  @@index([autoRenew, expiresAt])
}

model CreatorSubscriptionEvent {
  id          String   @id @default(cuid())
  wallet      String
  eventName   String
  tier        Int?
  periods     Int?
  amount0G    String?
  expiresAt   DateTime?
  gasless     Boolean  @default(false)
  payer       String?
  txHash      String
  blockNumber Int
  logIndex    Int
  createdAt   DateTime @default(now())

  @@unique([txHash, logIndex])            // makes replay/backfill idempotent
  @@index([wallet, createdAt])
}
```

Sync helper:

```ts
export async function upsertSubscriptionFromChain(wallet: string) {
  const s = await getSubscription(wallet);
  const key = s.wallet.toLowerCase();
  const data = {
    tier: s.tier,
    active: s.active,
    startedAt: s.startedAt,
    expiresAt: s.expiresAt,
    renewals: s.renewals,
    autoRenew: s.autoRenew,
    creditWei: s.creditWei.toString(),
  };
  await prisma.creatorSubscription.upsert({
    where: { wallet: key },
    create: { wallet: key, ...data },
    update: data,
  });
  await cache.del(`creator:sub:${key}`);
  return s;
}
```

---

## 11. Entitlement gate

```ts
const CACHE_TTL_S = 60;

export async function requireTier(wallet: string, minTier: TierValue) {
  const key = `creator:sub:${wallet.toLowerCase()}`;
  let state = await cache.getJson<SubscriptionState>(key);

  if (!state) {
    state = await getSubscription(wallet);          // chain is the source of truth
    await cache.setJson(key, state, CACHE_TTL_S);
  }

  if (state.effectiveTier < minTier) {
    throw new PaymentRequired({
      required: TIER_NAME[minTier],
      current: TIER_NAME[state.effectiveTier],
      upgradeUrl: '/studio/billing',
    });
  }
  return state;
}
```

Cache TTL must be short (≤60s) or a user who just paid will be told to pay again. Always bust the key on `POST /confirm` and in `upsertSubscriptionFromChain`.

Gate on `effectiveTier`, never on the raw stored `tier` — the stored value survives expiry.

---

## 12. Suggested API surface

| Method | Route | Purpose |
|--------|-------|---------|
| `GET` | `/v1/creator/tiers` | Prices from `allTierPrices()` + contract address, for the pricing page |
| `GET` | `/v1/creator/subscription/:wallet` | Current state via `subscriptionOf()` |
| `POST` | `/v1/creator/quote` | `{ wallet, tier, periods }` → cost, credit, dueNow, previewed expiry |
| `POST` | `/v1/creator/confirm` | `{ txHash }` → verify a flow-A receipt and refresh the cache |
| `POST` | `/v1/creator/subscribe/prepare` | Build the EIP-712 payload to sign |
| `POST` | `/v1/creator/subscribe/relay` | Verify + relay the signature (gasless) |
| `POST` | `/v1/creator/credit/sponsor` | Admin-only `depositCreditFor` |
| `GET` | `/v1/creator/history/:wallet` | Indexed events for a billing page |

Auth: every route that names a wallet must prove wallet ownership — session JWT bound to a SIWE login, not a wallet address in the request body. Otherwise anyone can read or trigger against any address.

---

## 13. Decoding contract errors

The contract uses custom errors. Map them to useful API responses:

```ts
export function decodeContractError(err: unknown): { name: string; args: unknown[] } | null {
  const data = (err as any)?.data ?? (err as any)?.info?.error?.data ?? (err as any)?.error?.data;
  if (!data || typeof data !== 'string') return null;
  try {
    const parsed = new ethers.Interface(CreatorStudioSubscriptionAbi).parseError(data);
    return parsed ? { name: parsed.name, args: [...parsed.args] } : null;
  } catch {
    return null;
  }
}
```

| Error | Meaning | Response |
|-------|---------|----------|
| `InsufficientPayment(required, supplied)` | Flow A `msg.value` too low | 400 — re-quote |
| `InsufficientCredit(required, available)` | Credit short for a gasless call | 402 — prompt top-up of `required - available` |
| `PriceExceedsAuthorized(cost, maxCost)` | Price rose after signing | 409 — re-prepare and re-sign |
| `SignatureExpired(deadline)` | Past `deadline` | 409 — re-sign |
| `InvalidSignature` | Wrong signer, or a mutated request | 400 — never retry, treat as tampering |
| `InvalidAccountNonce(account, currentNonce)` | Nonce already consumed (from OZ `Nonces`) | 409 — re-prepare with `currentNonce` and re-sign |
| `InvalidTier(tier)` | Tier > 2 | 400 |
| `InvalidPeriods(periods)` | > 24 | 400 |
| `FreeTierTakesNoPeriods` | `periods != 0` with tier 0 | 400 |
| `PaidTierRequiresPeriods` | `periods == 0` on a paid tier | 400 |
| `NotDueForRenewal(expiresAt)` | Auto-renew ran outside the 3-day window | skip, retry later |
| `AutoRenewNotEnabled` | No consent recorded | skip |
| `EnforcedPause` | Contract paused | 503 |
| `AccessControlUnauthorizedAccount` | Relayer lacks `RELAYER_ROLE` | 500 — ops issue, alert |

Always `staticCall` before a real send. The simulation reverts with the same error at zero gas cost, so you can return a precise message without paying for a failed transaction.

---

## 14. Full ABI reference

**User writes (payable):**
- `subscribe(uint8 tier, uint8 periods) payable`
- `subscribeFor(address account, uint8 tier, uint8 periods) payable`
- `depositCredit() payable`
- `depositCreditFor(address account) payable`
- `withdrawCredit(uint256 amount)` — `MaxUint256` withdraws everything
- `setAutoRenew(bool enabled)`
- `receive()` — a plain transfer credits the sender

**Relayer-only writes:**
- `subscribeWithSignature((address,uint8,uint8,bool,uint256,uint256,uint256) req, bytes signature)`
- `renewFromCredit(address account)`

**Admin writes:**
- `setTreasury(address payable)` — `DEFAULT_ADMIN_ROLE`
- `setTierPrice(uint8 tier, uint256 newPrice)` — `PRICE_ADMIN_ROLE`
- `pause()` / `unpause()` — `PAUSER_ROLE`
- `sweep(address payable to)` — `DEFAULT_ADMIN_ROLE`, bounded by `sweepable()`

**Views:**
- `subscriptionOf(address) → (uint8 tier, uint64 startedAt, uint64 expiresAt, uint64 renewals, bool autoRenew, bool active, uint256 creditBalance)`
- `quote(address, uint8 tier, uint8 periods) → (uint256 cost, uint256 creditBalance, uint256 dueNow)`
- `previewExpiry(address, uint8 tier, uint8 periods) → uint64`
- `isActive(address) → bool`, `currentTier(address) → uint8`
- `isDueForRenewal(address) → bool`
- `credit(address) → uint256`, `nonces(address) → uint256`
- `tierPrice(uint8) → uint256`, `allTierPrices() → uint256[3]`
- `treasury()`, `totalCredit()`, `totalCollected()`, `totalSubscriptions()`, `sweepable()`
- `PERIOD()` (2592000), `MAX_PERIODS()` (24), `RENEW_WINDOW()` (259200), `NO_EXPIRY()`
- `domainSeparator()`, `hashSubscribeRequest(req)`, `eip712Domain()`

---

## 15. Go-live checklist

**Contract**
- [ ] Deployed to 0G mainnet (16661); verified on `chainscan.0g.ai`
- [ ] `treasury()` reads back `0x043091b10bBcD3F8C5158C27AD291CC56B4F46db`
- [ ] `allTierPrices()` reads back `[0, 10e18, 25e18]`
- [ ] `DEFAULT_ADMIN_ROLE` transferred to a multisig; deployer's admin role renounced
- [ ] `RELAYER_ROLE` on a dedicated hot wallet, not the deployer
- [ ] One end-to-end mainnet test per flow (A, B, C) with 1 0G test prices, then repriced

**Backend**
- [ ] Relayer key in a secret manager, never in the repo
- [ ] Relayer balance alert (< 5 0G)
- [ ] Nonce lock in place; verified under concurrent load
- [ ] `staticCall` before every relayed send
- [ ] EIP-712 signature verified server-side *and* re-validated against chain state before relaying
- [ ] All wallet-scoped routes behind SIWE-bound auth
- [ ] Entitlements gated on `active` / `effectiveTier`, never the raw stored tier
- [ ] Indexer backfill on boot; `(txHash, logIndex)` unique index
- [ ] Cache TTL ≤ 60s and busted on confirm/relay
- [ ] Auto-renew worker running hourly; "top up" notification 5–7 days before expiry

**Frontend**
- [ ] `previewExpiry()` shown before signing, including tier-change carry-over
- [ ] Overpayment explained as credit, not a loss
- [ ] Credit balance + withdraw button on the billing page
- [ ] Chain-mismatch guard — prompt to switch to 16661 before any call

---

## 16. Tests

49 tests covering all three flows, tier-change carry-over, credit accounting, signature replay/tamper/expiry, `maxCost` slippage, role gating, pause behaviour and sweep bounds:

```bash
cd contracts/evm && npx hardhat test test/CreatorStudioSubscription.test.ts
```

[`test/CreatorStudioSubscription.test.ts`](../contracts/evm/test/CreatorStudioSubscription.test.ts) doubles as executable documentation — the EIP-712 signing setup there is the exact shape the frontend needs.
