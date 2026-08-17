# Archived: Solana vault-share $ARENA stack

Moved out of the active workspace on 2026-07-05 when the $ARENA economy was
rebuilt on 0G Chain (see `docs/ARENA_TOKEN_0G.md` and `docs/CONTRACTS.md`).

This directory is **not** part of the pnpm workspace (it sits outside the
`services/*` / `packages/*` / `workers/*` / `contracts/evm` globs in
`pnpm-workspace.yaml`), so it no longer builds or installs as part of the
monorepo. It is kept for the future Solana migration described in the ARENA
0G blueprint: once the beta economy is proven out on 0G, balances can be
snapshotted and this stack (or a successor) reactivated as the production
Solana destination.

## What's here

- `token/` — the original ERC-4626-style "vault-share" $ARENA design
  (USDC/USDT-backed, appreciating backing ratio, Wormhole bridging). This
  was a different tokenomics model than the fixed-supply Treasury-distributed
  design now live on 0G Chain — kept for reference only, not reused.
- `contracts-solana/` — the 4 original Anchor programs (`agent-wallet`,
  `escrow-vault`, `tournament`, `staking`). At archive time: `agent-wallet`'s
  `credit`/`debit` instructions had no access control ("any signer can
  credit" — see source comments), `escrow-vault` had no real caller
  (the client was fully stubbed), and `tournament`/`staking` had zero
  callers and incomplete instruction logic (`distribute_prizes` never
  transferred funds, `staking` had no reward accrual). None of this should
  be reactivated as-is — treat it as a reference sketch, not working code.
- `token-service/` — the backend relayer/bridge service that watched Base +
  0G EVM deposit events and minted on Solana via `arena-reserve`.
- `solana-client/` — the `@ai-arena/solana-client` package (`AgentWalletClient`,
  `EscrowClient`, `TokenClient`) that other services called into.
- `settlement-worker/` — worker that executed Solana settlement transactions
  off the `ESCROW_SETTLED` event bus subject.

## Why archived instead of deleted

The user's instruction: keep it around rather than deleting, since if/when
Solana support is added later, $ARENA balances get transferred there. This
directory is the starting reference point for that future work, not a
live dependency of anything in `services/`, `packages/`, or `apps/`.
