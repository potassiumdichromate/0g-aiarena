# TODO Tasks

---

## x402 Autonomous Wager Integration
**Pick this up when Solana program is on mainnet.**

### Context
Right now autonomous agents only join RANKED queue. WAGER mode exists in the codebase
but requires a human-approved payment flow. This task wires x402 so autonomous agents
can pay wager stakes on-chain without any human interaction.

The full loop once done:
```
Autonomous loop ticks (every 60s)
  → tries to join WAGER queue
  → matchmaking returns 402 with payment details
  → agent wallet auto-signs Solana tx
  → retries with X-Payment-Tx-Hash header
  → gets matched → battles → wins $ARENA
  → winnings land back in agent wallet
  → loop ticks again → pays next wager → repeat forever
```

---

### What needs to be built

#### 1. Matchmaking service — return proper 402 instead of throwing
File: `services/matchmaking-service/src/services/matchmaker.ts`

In `joinQueue`, when WAGER mode and balance is insufficient, instead of:
```typescript
throw new Error(`Insufficient $ARENA balance...`);
```

Return a structured 402 payload:
```typescript
return {
  status: 402,
  payment: {
    amount:    WAGER_AMOUNT,
    token:     'ARENA',
    recipient: process.env.WAGER_ESCROW_ADDRESS,
    network:   'solana-mainnet',
    agentId,
  },
};
```

And in the route handler (`matchmaking.routes.ts`), check for `status: 402` and reply:
```typescript
if (result.status === 402) {
  return reply.status(402).send({ error: 'payment_required', payment: result.payment });
}
```

---

#### 2. Agent wallet service — add autoPayWager
File: `services/wallet-service/src/services/wallet.service.ts`
(or `services/financial-service` depending on where wallet signing lives)

```typescript
async autoPayWager(agentId: string, amount: number, recipient: string): Promise<string> {
  // 1. Load AgentWallet from Prisma
  // 2. Decrypt custodial Solana private key using CUSTODIAL_WALLET_ENCRYPTION_KEY
  // 3. Build Solana transaction — transfer `amount` $ARENA SPL tokens to `recipient`
  // 4. Sign with decrypted keypair
  // 5. Submit to Solana RPC
  // 6. Return txHash
}
```

Dependencies needed:
- `@solana/web3.js`
- `@solana/spl-token`
- AES-256 decrypt helper for `custodialSolanaKeyEnc`
- `SOLANA_RPC_URL` env var pointing to mainnet RPC
- `ARENA_TOKEN_MINT_ADDRESS` env var — mainnet SPL mint address for $ARENA

---

#### 3. Autonomous loop — handle 402 and auto-pay
File: `services/matchmaking-service/src/services/autonomous-loop.ts`

In the `tickAutonomousAgents` function, after calling `matchmaker.joinQueue`:

```typescript
// If WAGER mode and 402 returned, auto-pay and retry
if (result?.status === 402 && result.payment) {
  const walletServiceUrl = process.env.WALLET_SERVICE_URL ?? 'http://localhost:8030';
  const payRes = await fetch(`${walletServiceUrl}/wallets/${agent.id}/auto-pay-wager`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'X-Service-Key': process.env.INTERNAL_SERVICE_SECRET ?? '',
    },
    body: JSON.stringify({
      amount:    result.payment.amount,
      recipient: result.payment.recipient,
    }),
  });
  if (payRes.ok) {
    const { txHash } = await payRes.json();
    // Retry queue join with payment proof
    await matchmaker.joinQueue(agent.id, gameId, mode, eloRange, txHash);
    console.info(`[AutonomousLoop] Wager paid (tx: ${txHash}), agent ${agent.id} queued`);
  }
}
```

Also update `joinQueue` signature to accept optional `paymentTxHash`:
```typescript
async joinQueue(agentId, gameId, mode, eloRange, paymentTxHash?: string)
```
And pass it to the financial service escrow lock step.

---

#### 4. Wallet service — expose HTTP route for autoPayWager
File: `services/wallet-service/src/routes/` (add new route)

```
POST /wallets/:agentId/auto-pay-wager
Headers: X-Service-Key
Body: { amount: number, recipient: string }
Response: { txHash: string }
```

Protected by internal service key only — never exposed to public API gateway.

---

#### 5. Env vars to add on Render (mainnet only)
```
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com      # or Helius/QuickNode RPC
ARENA_TOKEN_MINT_ADDRESS=<mainnet SPL mint address>
WAGER_ESCROW_ADDRESS=<escrow wallet that holds staked ARENA during battles>
CUSTODIAL_WALLET_ENCRYPTION_KEY=<already set — AES key for decrypting agent keys>
WALLET_SERVICE_URL=https://aiarena-wallet.<render-url>
```

---

#### 6. Security checklist before mainnet
- [ ] Private key decryption only happens inside wallet-service, never leaves the service
- [ ] `autoPayWager` route gated by `X-Service-Key` — not in public API gateway proxy
- [ ] Cap max wager per autonomous tick (env var `MAX_AUTO_WAGER_AMOUNT`)
- [ ] Add daily spend limit per agent (track in Redis: `auto:spent:<agentId>:<date>`)
- [ ] Emit `WAGER_AUTO_PAID` event to NATS for audit trail
- [ ] Test full loop on devnet with a mock SPL token before mainnet flip

---

### Files touched in total
| File | Change |
|---|---|
| `services/matchmaking-service/src/services/matchmaker.ts` | Return 402 object instead of throw |
| `services/matchmaking-service/src/routes/matchmaking.routes.ts` | Handle 402 reply |
| `services/matchmaking-service/src/services/autonomous-loop.ts` | Detect 402, call wallet service, retry |
| `services/wallet-service/src/services/wallet.service.ts` | Add `autoPayWager` with SPL transfer |
| `services/wallet-service/src/routes/` | Add internal `POST /wallets/:id/auto-pay-wager` route |

---

*Created: 2026-05-26 — pick up when Solana program is on mainnet*
