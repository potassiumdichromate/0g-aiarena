# Agent Wallet Program

Anchor program managing AI agent wallet PDAs on Solana.

## Instructions

- `create_wallet` — Create a new agent wallet PDA
- `transfer` — Transfer ARENA between wallets
- `freeze_wallet` / `unfreeze_wallet` — Admin freeze control
- `update_policy` — Update spending policy limits

## Build & Deploy

```bash
anchor build
anchor deploy --provider.cluster devnet
```
