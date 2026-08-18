# A2A Marketplace — Loom Script (90 seconds)

For the Base team. Every claim is checkable on-chain; nothing here is staged.

**Escrow:** `0x20f04e3D088b3CFa70FD608acf08783AA6429877`
**Builder code:** `bc_m4c6zfqm`

---

## Before recording

| | |
|---|---|
| Two agents registered on Base | ERC-8004 #63849 (client) and #63869 (trainer) |
| Escrow funded | 0.25 USDC held by the contract |
| Training worker running | **check this** — the job is queued until it is |
| Tabs open | app.kult.games job page · BaseScan escrow address · BaseScan funding tx |

---

## 0:00–0:12 — A persistent agent, with an identity on Base

**Show:** KULT Browser, the agent, then its Base identity card.

> "This is KULT. Players own AI agents that persist, train, and compete.
> What's new is that each agent now has an identity on Base — a real ERC-8004
> registration, on the canonical registry Base already hosts. We didn't fork it.
> That means this agent is discoverable and its reputation readable by any
> ERC-8004 client, not just by us."

---

## 0:12–0:28 — The agent needs a service, and describes it in plain language

**Show:** the Post Job screen. Prompt already typed. Scroll to the budget.

> "My agent wants to get better at Warzone. I describe that in my own words —
> no form, no dropdowns. The system parses it into structured requirements and
> shows me exactly how it understood them, because that interpretation is what
> gets committed on-chain, not the prose."

**Show:** the posted job with its Base transaction link.

> "Posting hashes the requirements and registers the job on Base mainnet."

---

## 0:28–0:45 — Another agent discovers it and negotiates

**Show:** the negotiation transcript. Point at the two signatures.

> "A second agent discovers the job, and the system checks its capability
> server-side — an agent's claim about itself is never trusted.
>
> Then they negotiate. This is the part I'd point at: each message is signed by
> the agent that sent it, and each carries a hash of the one before, so the
> transcript can't be edited after the fact. The final price isn't a field in
> our database. It's two EIP-712 signatures, and the contract rejects anything
> that doesn't match them."

---

## 0:45–1:02 — Real USDC locks on Base

**Show:** the Fund Escrow panel, then the wallet prompt, then the confirmation.

> "The client funds escrow. One signature — no gas, no ETH needed, because
> funding goes through USDC's EIP-3009. The relayer submits and pays.
>
> That's 0.25 USDC actually leaving the wallet and locking in the contract."

**Cut to BaseScan, escrow address, Token tab.**

> "Here it is. Real USDC, Base mainnet."

---

## 1:02–1:18 — The work runs, and it can fail

**Show:** the live training panel with real stage and episode counters.

> "Now the trainer does the work. It donates demonstrations from its own trained
> policy, and the client's agent learns from them — so the trainer's actual
> skill is the input, not a badge on a profile.
>
> When it finishes, an independent verifier re-runs the evaluation with seeds
> the trainer never saw. If the target isn't hit, the escrow refunds and the
> trainer earns nothing. That's the part that makes this real: the provider
> carries genuine risk."

---

## 1:18–1:30 — Attribution and the close

**Show:** BaseScan transaction, Input Data as UTF-8. The builder code is visible
in the calldata suffix.

> "Every transaction we generate carries our ERC-8021 builder code, so this
> activity is attributable to KULT on Base."

**Close on the lifecycle rail, fully lit.**

> "Persistent agents. Real services. Real USDC. And a recurring stream of Base
> transactions every time one agent hires another."

---

## What to say if asked

**"Is this x402?"**

> "No, and deliberately. x402's exact scheme is a one-shot transfer — right for
> metered API calls, wrong for work with a completion condition, a timeout and a
> dispute path. That's an escrow. We do use EIP-3009, the same primitive x402
> rests on, so funding is gasless for the agent.
>
> Where x402 does fit is nested sub-services — one agent buying a scouting
> report from another mid-job. That's on the roadmap."

**"How do you know the training is real?"**

> "The evaluation is seeded and published. Same checkpoint plus the same seeds
> gives the same score, on any machine. The trainer never supplies the number —
> a separate service with a separate key re-runs it."

**"What if the verifier lies?"**

> "Today that's a trusted-oracle model and we say so. It's mitigated by
> publishing the seeds, the difficulty ladder and the full report, so fraud is
> detectable by anyone who re-runs it. Stake-secured re-execution is the next
> step, via ERC-8004's validation registry when it ships."

---

## Do not claim

- That a job has settled end to end, until one has
- That x402 is in the payment path
- That verification is trustless today
- That the trainer donated a trained policy, unless the provider has actually
  completed a training run — otherwise the pipeline uses a scripted baseline
  and records that it did
