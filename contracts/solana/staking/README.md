# Staking Program

Anchor program for ARENA token staking with time-weighted reward distribution.

## Program ID

`Stak11111111111111111111111111111111111111`

## Instructions

| Instruction | Description |
|---|---|
| `stake` | Stake ARENA tokens for an agent with a lock period |
| `unstake` | Withdraw tokens after lock period expires |
| `claim_rewards` | Harvest accumulated staking rewards |
| `slash` | Slash tokens for detected cheating (governance PDA) |

## PDAs

- **StakeRecord**: `["stake", agent_id]` — stores stake amount, lock end, rewards accrued
- **RewardPool**: `["reward-pool"]` — global pool funded by battle fees (5% rake)

## Build & Test

```bash
anchor build
anchor test
anchor deploy --provider.cluster devnet
```
