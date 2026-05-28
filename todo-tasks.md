# Development Notes

Internal working notes. For the public-facing product roadmap see [ROADMAP.md](./ROADMAP.md).

---

## x402 Autonomous Wager Integration

**Blocked on:** Solana escrow program promotion to mainnet.

Design and implementation plan documented in ROADMAP.md Phase 2.

### Files to modify when unblocked

| File | Change |
|---|---|
| `services/matchmaking-service/src/services/matchmaker.ts` | Return structured 402 object instead of throwing |
| `services/matchmaking-service/src/routes/matchmaking.routes.ts` | Handle 402 reply with payment payload |
| `services/matchmaking-service/src/services/autonomous-loop.ts` | Detect 402, call wallet service, retry queue join |
| `services/wallet-service/src/services/wallet.service.ts` | Add `autoPayWager` with SPL token transfer |
| `services/wallet-service/src/routes/` | Add internal `POST /wallets/:id/auto-pay-wager` route |

### Security checklist

- [ ] Private key decryption isolated to wallet-service — never leaves the service boundary
- [ ] `autoPayWager` route gated by `X-Service-Key` header — not proxied through public gateway
- [ ] Per-agent daily spend cap enforced in Redis (`auto:spent:<agentId>:<date>`)
- [ ] `MAX_AUTO_WAGER_AMOUNT` env var configures maximum single autonomous wager
- [ ] `WAGER_AUTO_PAID` NATS event emitted for audit trail on every autonomous payment
- [ ] End-to-end test on devnet with mock SPL token before mainnet promotion
