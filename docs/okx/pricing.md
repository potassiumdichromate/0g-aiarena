# OKX `create-agent` Pricing — Cost Sample

> Real measurements, not estimates, taken against the funded production 0G Compute account on
> 2026-06-24. This unblocks the pricing gap flagged in
> [`../architecture/KULT_CORE_INTELLIGENCE_LAYER.md`](../architecture/KULT_CORE_INTELLIGENCE_LAYER.md#pricing--the-open-item-that-actually-blocks-registering-the-agent-card).

## What was measured

Three real `chat/completions` calls against `router-api.0g.ai/v1`, model
`deepseek/deepseek-chat-v3-0324`, using the same prompt shape as
`ZeroGComputeClient.generatePersonality()` (`packages/zerog-client/src/compute.client.ts`). This
covers the **personality-generation** step of agent creation — the only step that runs
synchronously in the fast-path OKX endpoint (avatar generation is deferred async, metadata/avatar
0G Storage uploads and the 0G Chain INFT mint are separate cost lines not measured here).

| Sample | Total tokens | `total_cost` (neuron) | `total_cost` (0G token, 1e18 neuron = 1) |
|---|---|---|---|
| 1 | 366 | 541,860,000,000,000 | 0.00054186 |
| 2 | 370 | 549,180,000,000,000 | 0.00054918 |
| 3 | 232 | 332,000,000,000,000 | 0.00033200 |

**Average: ~474,346,666,666,666 neuron ≈ 0.000474 0G token per personality-generation call.**

Cost scales with `completion_tokens` (the model's `max_tokens` is capped at 1024 in
`generatePersonality()`), so this average should hold steady — large variance would only show up
if response length varies a lot across different agent seeds.

## INFT mint gas — measured 2026-06-24

Ran a real, read-only `contract.mintAgent.estimateGas(...)` against the live `AIArenaINFT`
contract on 0G Chain mainnet (`ZEROG_INFT_CONTRACT_ADDRESS`), using the operator address derived
from `ZEROG_STORAGE_PRIVATE_KEY` as both `from` and dummy `to`, with placeholder trait/hash/string
values. This is a **simulation only** — `estimateGas` never broadcasts a transaction, so it cost
nothing and changed no state.

| Metric | Value |
|---|---|
| Estimated gas units | 520,923 |
| Gas price (at time of check) | 4,000,000,007 wei (~4 gwei) |
| **Estimated mint cost** | **0.0020837 0G token** |

This will vary slightly run-to-run with network gas price, and real calldata (longer `agentId`,
real `genesisRootHash`, a non-trivial `sealedKey`) will push actual gas slightly above this
estimate — treat this as a reasonable floor, not a hard ceiling.

## What's still missing (flagged, not guessed)

1. **0G Storage upload cost** for the metadata JSON blob (avatar upload is skipped in the OKX
   fast path, so only one upload applies here). Unlike the gas estimate above, there's no
   dry-run equivalent for `indexer.upload()` in the `@0gfoundation/0g-storage-ts-sdk` — it submits
   a real on-chain transaction to the Flow contract every time
   (`packages/zerog-client/src/storage.client.ts:51`). Getting a real number means either:
   (a) running one real ~2KB upload and reading the actual fee from the tx receipt — a small,
   real, irreversible spend that needs explicit go-ahead before doing it, or
   (b) finding 0G's published per-byte storage fee schedule instead of measuring it directly.
2. **0G token → USD conversion** — needed to quote a USDG/USD₮0 price on X Layer (per
   [`okx_context.md`](okx_context.md)). Use the live rate at the time of pricing, not a fixed
   assumption baked into docs.

## Suggested pricing approach

```
price_per_call (USD) = (0.000474 0G token × 0G/USD rate)   // personality generation, measured
                      + (0.0020837 0G token × 0G/USD rate) // INFT mint gas, measured
                      + (storage upload cost in USD)        // still open, see above
                      + margin (suggest 30-50% given OKX's pay-per-call,
                        no-arbitration model — a single underpriced call
                        can't be renegotiated after the fact)
```

Two of three cost components are now real numbers (~0.0026 0G token combined, before storage and
FX). Round up to a clean USDG/USD₮0 figure (A2MCP wants one fixed, declared price — see
[`okx_context.md`](okx_context.md#a2mcp--standard-api)) once the storage cost and FX rate are
filled in.
