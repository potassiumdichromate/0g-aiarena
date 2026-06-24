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

## What's still missing (flagged, not guessed)

These need a real number before the Agent Card's fixed price can be finalized — none of them are
in the codebase's metering today:

1. **0G Storage upload cost** for the metadata JSON blob (avatar upload is skipped in the OKX
   fast path, so only one upload applies here). Check 0G Storage's own published pricing — not
   something this codebase tracks per-call.
2. **0G Chain gas** for the INFT mint transaction (`AIArenaINFT.sol`, Chain ID 16661). No gas
   estimation/logging exists in `inft-service` today — check a 0G Chain gas tracker or run one
   real mint and read the tx receipt.
3. **0G token → USD conversion** — needed to quote a USDG/USD₮0 price on X Layer (per
   [`okx_context.md`](okx_context.md)). Use the live rate at the time of pricing, not a fixed
   assumption baked into docs.

## Suggested pricing approach

```
price_per_call (USD) = (0.000474 0G token × 0G/USD rate)
                      + (storage upload cost in USD)
                      + (INFT mint gas in USD)
                      + margin (suggest 30-50% given OKX's pay-per-call,
                        no-arbitration model — a single underpriced call
                        can't be renegotiated after the fact)
```

Round up to a clean USDG/USD₮0 figure (A2MCP wants one fixed, declared price — see
[`okx_context.md`](okx_context.md#a2mcp--standard-api)) once items 1–3 are filled in.
