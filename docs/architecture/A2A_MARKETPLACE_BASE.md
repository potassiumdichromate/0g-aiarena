# KULT A2A Agent Commerce Marketplace on Base Mainnet

**Status:** Proposed plan, awaiting approval. No implementation started.
**Deliverable metric:** agent **traits** — trained for real, measured from behaviour, never written by hand.
**Settlement:** USDC on Base mainnet.
**Explicitly out of scope:** `services/okx-payment-proxy` is OKX.AI infrastructure and will not be touched, read from, or modified by any part of this work.

---

## 0. The plan in one page

Agent B trains Agent A's traits by **donating its own learned policy as demonstrations**, then running a curriculum it designs. Traits are then **measured** from behaviour in a seeded evaluation — never assigned. Agent B can fail. If the measured trait target isn't hit, escrow refunds.

That single design choice is what makes this real A2A commerce rather than a payment wrapper around a database update:

- Agent B's capability is a **real economic input** — a trainer with combat 94 has a better policy, so its demonstrations produce a better student than a trainer at 70.
- The outcome is **not predetermined** — bad curriculum, bad hyperparameters, or too small an episode budget means the target is missed and the trainer earns nothing.
- The result is **independently reproducible** — same model hash + same seeds → same measured traits.

Everything economically important lives on Base: agent identity and reputation on the canonical ERC-8004 registries (already deployed at deterministic addresses), job commitments and USDC escrow in one new contract, funding via USDC's EIP-3009 so neither agent needs ETH, and spending authority bounded by Base Account Spend Permissions.

**Compute:** CPU only. The environment is 32-dim observations over 7 actions; a demo-sized budget trains in single-digit minutes. No GPU procurement, no 0G fine-tuning CLI dependency, no scheduling risk.

---

# PART 1 — Audit findings that shape the design

Verified against code, not docs.

### F1. Training does not currently execute

Gateway maps `/v1/training` → `AGENT_SERVICE_URL` ([api-gateway/src/main.ts:185](../../services/api-gateway/src/main.ts)). `agent-service.queueTraining()` is a single `prisma.trainingJob.create()` — no event, no worker ([agent.service.ts:405](../../services/agent-service/src/services/agent.service.ts)). The service that does the real thing (`training-service`: 0G dataset upload, `TRAINING_QUEUED` publish, full `completeJob`) is **absent from `render.yaml` and unreachable through the gateway**. `workers/training-worker` is also undeployed and hardcodes `meta-llama/Llama-2-7b-chat-hf`, ignoring the event payload.

**Every training job ever created is still `QUEUED`.** The UI's `progressFromStatus()` returns 18/64/100 by status string.

### F2. `AIArenaBattleEnv` is a genuine training substrate

[ml/reinforcement_learning/environment.py](../../ml/reinforcement_learning/environment.py) is a real `gym.Env`: 32-float observation, 7 discrete actions, scripted enemy with a `difficulty` parameter (0=easy → 1=hard), **seedable via `reset(seed=)`**. `battle-service` has no tick loop at all — it is an orchestrator; battles are played client-side in Unity.

So this env is the only server-side substrate — and it is the right one. Seedability is exactly what verification needs, and its telemetry vocabulary (attack attempts, hits, damage taken, episode length) maps 1:1 onto the Unity telemetry `evolveTraits()` already consumes.

### F3. Agents have no economic identity

`AgentWallet` is Solana-only and that stack is archived. Agents have no EVM address, no key, no signing capability. Users have an EVM address via Privy — an embedded wallet, so **the same address already works on Base**.

### F4. No capability metric exists

"Combat" appears only as a radar label with hardcoded `[78, 72, ...]`. Must be derived, published, versioned.

### F5. Reputation substrate is manipulable

`autonomous-loop.ts` **simulates** battles with `rand()` stats; `agent-bot-service` mints agents on throwaway wallets hourly. Marketplace reputation must therefore count **only settled marketplace jobs**, never raw wins.

### F6. Base is half-present but archived

`.env` has `BASE_RPC_URL` and the correct canonical `BASE_USDC_ADDRESS` (`0x8335…2913`). But `ArenaDepositVault.sol` lives only under `archive/`, and **`hardhat.config.ts` has no Base network** — only 0G mainnet/testnet and localhost.

### F7. Patterns worth reusing

- **`arena-chain-service`** — one service holds the only signing key; others call it over HTTP. Indexer via `contract.on()` → `OnChainEvent` unique on `(txHash, logIndex)`. Template for the Base service. Its own comment admits a dropped connection silently stops indexing — we add `queryFilter` reconciliation rather than inherit that.
- **`ArenaEscrow.sol`** — `AccessControl` + `RELAYER_ROLE`, `Pausable`, `ReentrancyGuard`, `SafeERC20`, commission locked at creation.
- **ERC-7857 `authorizeUsage()`/`revokeUsage()`** on `AIArenaINFT` — already implemented, exactly the primitive for granting Agent B scoped rights to train Agent A's agent.
- **`ml/behaviour_cloning/`** — real Transformer policy + dataset loader. This is what makes trainer-donated demonstrations work.

---

# PART 2 — The training design (the core of the product)

## 2.1 Traits are measured, never written

Eight existing traits: aggression, patience, adaptability, resilience, creativity, loyalty, deception, precision.

After training, the evaluator runs **K seeded episodes across a fixed difficulty ladder** and measures behaviour:

| Measured from the env | Drives |
|---|---|
| `attackHits / attackAttempts` | **precision** |
| `(ATTACK + ABILITY_1) / steps` | **aggression** |
| HP retained, damage taken per episode | **resilience** |
| Episode length before terminate | **patience** |
| Action-distribution entropy | **creativity** |
| Correct `FLEE` timing (hp<0.3), correct `ABILITY_2` heal timing | **adaptability** |
| Win rate across the difficulty ladder | **combat skill** composite |

`combatSkill` (v1, `formulaVersion: "cap-v1"`, tuned against real runs before locking):

```
combatSkill = clamp(0,100,
    0.35 * precisionScore      // measured hit rate
  + 0.30 * winRateScore        // across the fixed difficulty ladder
  + 0.20 * survivabilityScore  // HP retained
  + 0.15 * efficiencyScore     // damage dealt per step
)
```

Three properties that make this defensible: **reproducible** (same checkpoint + same seeds → same number), **provenance-carrying** (seeds, ladder, episode IDs, checkpoint hash all stored), and **not self-reported** (the trainer never supplies the score).

## 2.2 What Agent B actually does

1. **Donates demonstrations.** Agent B rolls out its own trained policy for N episodes, producing state-action trajectories. *This is Agent B's real asset.* A trainer with a weak policy produces weak demonstrations and a weak student.
2. **Behaviour cloning.** Agent A's policy learns from B's trajectories — `ml/behaviour_cloning/train.py`, already real.
3. **PPO fine-tune on B's curriculum.** B chooses the difficulty schedule, episode budget, entropy coefficient, and reward-shaping weights — `ml/reinforcement_learning/train_ppo.py`, already real.
4. **Checkpoint → 0G Storage**, root hash recorded.

Agent B is exercising genuine skill and genuinely risking failure. That is the economic activity.

## 2.3 Why the trainer can fail

Escrow only releases if the evaluator's measured `combatSkill ≥ target`. Under-budgeting episodes, picking a difficulty ladder that's too steep, or donating demonstrations from a weak policy all produce a miss → refund. There is no path where Agent B gets paid for work that didn't move the number.

---

# PART 3 — Base architecture

## 3.1 Reuse vs deploy

| Contract | Address | Action |
|---|---|---|
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | Reuse (canonical) |
| ERC-8004 IdentityRegistry | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | **Reuse — live on Base** |
| ERC-8004 ReputationRegistry | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` | **Reuse — live on Base** |
| ERC-8004 ValidationRegistry | not deployed (spec under revision) | Verifier attestation lives in our contract; migrate later |
| SpendPermissionManager | Coinbase-deployed | Reuse |
| **`A2AJobEscrow`** | new | Deploy |

All reused addresses get verified on-chain before any code is written against them.

**Job registry and escrow are one contract.** Two contracts sharing job state creates a window where a job is `AGREED` in one and unknown in the other. Atomicity beats modularity here.

## 3.2 Agent identity and money — the split that matters

- **Identity = a custodial agent EOA**, AES-encrypted using the existing `custodialSolanaKeyEnc` pattern. Registered as the agent's ERC-8004 wallet. Signs every A2A message and the EIP-712 agreement. **Holds no float.** It is the payout destination.
- **Money = the owner's Base Account, bounded by a Spend Permission.** The owner signs one EIP-712 permission (token USDC, allowance, period, spender). The agent then funds escrow autonomously within that cap, without a human prompt per job — and **cannot exceed it even if its own logic tries**.

This is the honest answer to "the agent participates in economic activity": real autonomy, bounded blast radius, enforced by a Coinbase-audited contract rather than by our backend's good intentions.

## 3.3 On-chain vs off-chain

On-chain holds money, authority, and commitments. Off-chain holds prose, telemetry, and evidence — each content-hashed, hash committed on-chain, blob on 0G Storage (already Merkle-root addressed) so anyone can fetch and recompute.

| On Base | Off-chain |
|---|---|
| `jobId`, creator/provider agent IDs, timestamps | Natural-language prompt |
| `requirementsHash` | Parsed requirement JSON |
| Budget min/max, agreed price | Negotiation transcript (each message signed) |
| `agreementHash` + both signatures | Training telemetry stream |
| Escrowed USDC | Model checkpoint |
| `deliverableHash`, verdict | Evaluation report body |
| Settlement transfer | |

## 3.4 `A2AJobEscrow` — key decisions

```solidity
enum JobStatus { NONE, POSTED, ESCROWED, EXECUTING, DELIVERED, SETTLED, REFUNDED, CANCELLED, DISPUTED }

/// Commits the agreement AND pulls USDC in one transaction.
/// Both EIP-712 signatures verified (ECDSA, ERC-1271 fallback for smart wallets).
/// USDC pulled via receiveWithAuthorization — msg.sender must equal `to`, which is this contract.
function fundWithAuthorization(
    bytes32 jobId, uint256 providerAgentId, address providerWallet,
    uint128 agreedPrice, bytes32 agreementHash,
    bytes calldata creatorSig, bytes calldata providerSig,
    ReceiveAuthorization calldata auth
) external onlyRole(RELAYER_ROLE);

function submitVerdict(bytes32 jobId, bool accepted, bytes32 reportHash)
    external onlyRole(VERIFIER_ROLE);           // pays provider in this same tx

function claimTimeoutRefund(bytes32 jobId) external;   // PERMISSIONLESS
```

- **`agreedPrice` bounds enforced on-chain** — `require(agreedPrice >= budgetMin && <= budgetMax)`, and both signatures cover the price. The frontend cannot "just change a price field."
- **Neither agent needs ETH on Base.** EIP-3009 authorization is a signature; the relayer pays gas.
- **`claimTimeoutRefund` is permissionless and works while paused.** If our relayer disappears, the creator's money is not trapped. Most important liveness property in the system.
- **Roles are separated and none can move funds arbitrarily:** `RELAYER_ROLE` (transitions only), `VERIFIER_ROLE` (verdicts only), `ARBITER_ROLE` (disputes only), `DEFAULT_ADMIN_ROLE` (pause/config only). Payout destination is fixed at funding time.
- **Commission locked at funding**, following `ArenaEscrow`'s pattern.

## 3.5 Threat model

| # | Threat | Mitigation |
|---|---|---|
| T1 | Unauthorized settlement | Payout only inside `submitVerdict`, gated on role + `status == DELIVERED`, to the wallet fixed at funding |
| T2 | Relayer compromise | Relayer cannot move funds, only trigger transitions; griefing bounded by permissionless refund |
| T3 | Verifier compromise | v1 accepts this risk; mitigated by publishing seeds + ladder + report so fraud is *detectable*. Stated honestly, not papered over |
| T4 | Agent impersonation | ERC-8004 identity; only `setAgentWallet`-proven wallets sign; every message EIP-712 verified against the registry |
| T5 | Negotiation manipulation | On-chain bounds, both signatures over one struct, hash-chained transcript |
| T6 | Replay | EIP-712 domain binds chainId + contract + jobId; EIP-3009 nonce single-use; events unique on `(txHash, logIndex)` |
| T7 | Duplicate job / double payment | `jobId = keccak256(creatorAgentId, requirementsHash, nonce)`; `status != NONE` rejects re-post |
| T8 | Training result manipulation | Trainer never reports the score; evaluator recomputes from a fresh seeded run against the submitted checkpoint hash |
| T9 | False completion | `deliverableHash` must match the evaluator's independently derived hash |
| T10 | Non-delivery / agent failure | `executionDeadline` → permissionless refund |
| T11 | Verifier no-show | `verificationDeadline`; creator refunds, provider may dispute |
| T12 | Partial completion | `resolveDispute(toProvider, toCreator)`, sum must equal escrow |
| T13 | Sybil reputation | Only settled jobs count; distinct-counterparty requirement; bot agents excluded |
| T14 | Self-dealing | Reject jobs where creator and provider share an owner wallet |
| T15 | Reentrancy | `ReentrancyGuard`, checks-effects-interactions, status set before transfer |
| T16 | Admin abuse / frozen funds | `Pausable` blocks new jobs but **must not** block refunds |
| T17 | Runaway agent spend | Spend Permission caps per-period spend at the contract level |
| T18 | Evaluation gaming | Seeds withheld until after checkpoint submission, then published |

## 3.6 x402 — my recommendation

**Ship v1 without it.** Escrow funding already uses EIP-3009, which gives the identical gasless UX; adding a 402 handshake on top would be ceremony, not function. And x402's `exact` scheme is a one-shot transfer — structurally wrong for something with a completion condition, a timeout, and a dispute path.

The genuine fit is **nested sub-services**: mid-job, Agent B buys extra eval episodes or a scouting report from Agent C for 0.02 USDC. That is real nested agent commerce and worth building — as a **later phase, in a new Base-targeted service**. `okx-payment-proxy` stays untouched; it serves OKX.AI on X Layer and has nothing to do with this.

---

# PART 4 — Phases

Each phase: implement → run checks → inspect → explain → flag risks → confirm before continuing.

### Phase 1 — Foundations: Base wiring + agent identity — **CODE COMPLETE, NOT YET DEPLOYED**

Built:
- `base` (8453) + `base-fork` networks in `hardhat.config.ts`, BaseScan verification, separate `BASE_DEPLOYER_PRIVATE_KEY`.
- `scripts/verify-base-contracts.ts` — pre-flight asserting the canonical addresses and the EIP-712 domain. **Run against live Base: all checks pass.**
- `services/base-chain-service` (`:8051`) — sole Base relayer/signer. Identity registration, card publishing, on-chain verification, agent signing.
- `AgentBaseIdentity` model + migration (**not yet applied to any database**).
- Gateway `/v1/a2a/*` → `BASE_CHAIN_SERVICE_URL` (OPTIONAL table → clean 503 until deployed).
- `aiarena-base-chain` service in `render.yaml`.

Verified: 19 tests pass, service and gateway typecheck clean, Prisma schema valid, all three canonical Base contracts confirmed live.

Deferred to Phase 6 (nothing to index yet): `queryFilter` reconciliation, which lands with the escrow indexer.

**Remaining before this phase is truly done:** apply the migration, generate and fund the relayer key, deploy, then register two real agents on Base mainnet.

### Phase 2 — Real trait training on CPU — **CODE COMPLETE, NOT YET DEPLOYED**

Built `ml/trait_training/`: instrumented rollout, pure `traits.measure()` (`cap-v1`), `ArenaActorCritic` (reuses `BCPolicyNetwork` verbatim), trainer-donated demonstrations, behaviour cloning, compact vectorized PPO, seeded evaluation, end-to-end pipeline. Worker rewritten to claim jobs from Postgres with `FOR UPDATE SKIP LOCKED` and requeue dead workers. Worker image moved from `nvidia/cuda` to CPU-only. `AgentCapabilitySnapshot` + `Battle.isSimulated` + real progress columns on `TrainingJob`. Frontend `progressFromStatus()` deleted, replaced with worker-reported progress and stage labels.

**Measured, cold start, 16-core CPU, no GPU:** combatSkill **0 → 76** in **~4.5 minutes**. 38 tests pass.

Worse than the audit said: the worker's trainers were not merely unwired, they **fabricated metrics** — `rl_trainer.py` trained CartPole-v1 and returned a hardcoded `250.3`; `behaviour_cloning.py` had every real line commented out and returned a hardcoded loss/accuracy. Both are left untouched for the separate `LORA_FINETUNE` path; nothing in trait training calls them.

Routing conflict **C2 dissolved**: the frontend uses `/v1/agents/*` for training, and the worker claims from the DB queue, so `POST /v1/agents/:id/train` became real with no gateway change.

**Known limitations** (detail in [`ml/trait_training/README.md`](../../ml/trait_training/README.md)): the difficulty ladder does not discriminate at the top (trained policies win 40/40 even at 0.9), so Phase 3 needs a harder rung or capability profiles will bunch up. `loyalty`/`deception` are not measurable in this environment, return `None`, and cannot be job targets.

**Remaining:** apply the migration, deploy the worker, run one job end-to-end through the product UI.

> The eval-v1 ladder limitation noted here was **fixed in Phase 3** (eval-v2). The 0 → 76 figure above was measured under eval-v1; re-measure under eval-v2 before quoting it.

### Phase 3 — Capability profiles and discovery — **CODE COMPLETE, NOT YET DEPLOYED**

Built `packages/capability/`: `computeProfile(prisma, agentId, gameId)` with a four-tier evidence hierarchy and full provenance, plus a pure matching engine (predicates, conjunction, game scoping, normalized ranking margin, target-sanity check). Exposed via agent-service under `/v1/agents`: `/:id/capabilities`, `/:id/eligibility-check`, `/discover`, `/:id/target-check`. No gateway change needed.

**Fixed the eval-v1 ladder problem found in Phase 2.** `scripts/difficulty_sweep.py` measured policies of three quality tiers at ten difficulties:

| difficulty | weak | scripted | trained | verdict |
|---|---|---|---|---|
| 0.3 / 0.5 | 1.00 | 1.00 | 1.00 | everyone wins — no information |
| 0.7 | 0.62 | 1.00 | 1.00 | separates weak from competent |
| 0.9 | 0.00 | 1.00 | 1.00 | separates weak from competent |
| 1.5 | 0.00 | 1.00 | 1.00 | headroom |
| 2.0 | 0.00 | 0.50 | 0.38 | separates competent from excellent |
| 2.5 | 0.00 | 0.25 | 0.00 | too hard, seed-dependent — dropped |
| 3.0+ | 0.00 | 0.00 | 0.00 | nobody wins — no information |

eval-v1 `[0.3, 0.5, 0.7, 0.9]` spent half its rungs where every competent agent wins and had no rung above 0.9 — so every trained agent scored winRate 1.0 and profiles bunched. **eval-v2 is `[0.7, 0.9, 1.5, 2.0]`.** Scores drop in absolute terms, which is the point: headroom for genuinely better agents. `EVAL_PROTOCOL_VERSION` bumped; `CAPABILITY_FORMULA_VERSION` unchanged at `cap-v1` (the ladder is protocol, not formula — which is why they were split).

**Closed the simulator loophole.** `Battle.isSimulated` existed but nothing set it. `autonomous-loop.ts` now marks its fabricated battles, and profiles filter on it — otherwise a provider manufactures "100+ Warzone wins" by leaving autonomous mode on overnight (T13).

Verified: 46 Python tests, 24 capability tests, all services typecheck. Definition-of-Done scenario encoded verbatim — 94/187 qualifies, 80/187 and 94/42 are each rejected with the specific failing predicate named.

**Deferred to Phase 4** (needs jobs to exist): `GET /v1/a2a/jobs/matching` and webhook push to ERC-8004-declared endpoints. `/agents/discover` is the same engine in the meantime.

### Phase 4 — Job creation and on-chain registration — **CODE COMPLETE, NOT YET DEPLOYED**

Built `packages/a2a-protocol/` (canonical hashing, requirement documents, NL parser, jobId derivation), `contracts/base/A2AJobEscrow.sol` + deploy script, `services/a2a-marketplace-service` (`:8080`), job relay routes in base-chain-service, the `A2AJob` model, and `extractJobRequirements()` on `ZeroGComputeClient`.

**Two-step creation on purpose.** `POST /jobs/draft` parses and stages; `POST /jobs/:id/confirm` publishes to Base. The parsed document — not the prose — is what the escrow settles against, so the author confirms the interpretation before it becomes a commitment. A one-shot "post this prompt" endpoint would let a misread threshold silently become the contract.

**Parser is deterministic-first.** Pattern matching always runs and cannot hallucinate; the 0G Compute pass is an enhancement reconciled against it by `mergeExtractions`, which **drops any LLM number that does not literally appear in the prompt** and flags disagreements rather than silently picking a winner. If 0G is down, posting still works.

**Canonical hashing** has golden-vector tests pinning the exact byte string and hash. Floats are rejected outright (`0.1+0.2` makes hashes machine-dependent); USDC is parsed string-wise into 6dp base units, never `Math.round(x * 1e6)`.

Verified: 34 a2a-protocol tests (both spec prompts parse verbatim), 19 contract tests, 24 capability, 19 base-chain, all services typecheck, gateway boots with the new route registered.

**Gateway prefix note:** marketplace jobs live at `/v1/marketplace`, **not** `/v1/a2a/jobs` — two overlapping proxy prefixes each register a wildcard, and the nested one either conflicts at boot or shadows unpredictably. `/v1/a2a` stays with base-chain-service because it serves the public ERC-8004 tokenURI.

**Contract scope:** `postJob` / `cancelBeforeFunding` / views are implemented and tested. Funding, delivery and settlement are declared in the contract but have **no relayer path** until Phase 6 — a settlement function never exercised against real USDC should not be reachable over HTTP.

**Deferred:** the job-posting UI (Phase 9 covers marketplace frontend).

### Phase 5 — Negotiation and agreement
**Status: complete.**

New `packages/a2a-protocol`: message schemas, EIP-712 typed data, canonical serializer, ECDSA + ERC-1271 verification. Hash-chained transcript. Provider policy (accept/counter/decline against its own floor).
**Exit:** A→B→A→B converges to one price with four verifiable signatures and a stable `agreementHash`; tampering with any message breaks chain verification.

### Phase 6 — Escrow and settlement
`A2AJobEscrow.sol` full implementation. EIP-3009 authorization signing. Spend Permission integration.
**Testing:** Hardhat **fork of Base mainnet with real USDC** — happy path, timeout refund, verifier no-show, dispute split, double-fund, replayed authorization, wrong-price signature, reentrancy probe.
**Exit:** every failure path returns funds to the correct party on a fork. **No mainnet deploy until Phase 9.**

### Phase 7 — Deliverable verification
New `services/evaluation-service` holding `VERIFIER_ROLE`, **separate key from the relayer**. Seeded evaluation, signed report → 0G Storage → `submitDeliverable` + `submitVerdict`. Verified traits written back to `Agent.traits`.
**Exit:** "Target 70, achieved 73" is reproducible by a third party from published inputs.

### Phase 8 — Reputation and history
ERC-8004 `giveFeedback` on settlement. Metrics from settled jobs only: completed, failed, USDC earned, completion rate, mean delivery time, mean overshoot, distinct counterparties, capabilities demonstrated.
**Exit:** reputation recomputable from on-chain events alone.

### Phase 9 — Frontend, hardening, mainnet
Routes under `/marketplace/a2a` (note: `/marketplace` currently redirects to `/inventory` — leave that alone). Hero component is the lifecycle rail: `POST → DISCOVER → NEGOTIATE → ESCROW → TRAIN → DELIVER → SETTLE`, each stage with its Base tx and BaseScan link. Full T1–T18 matrix. **External review of `A2AJobEscrow` before mainnet.** Then deploy, verify on BaseScan, canary at 0.25 USDC.
**Exit:** one real job settled on Base mainnet, fully reconciled.

### Phase 10 — Demo readiness (+ optional x402 sub-services)
Key management in KMS. **Prerequisite: rotate `EVM_DEPLOYER_PRIVATE_KEY` and everything downstream of `0x63F63DC…` — it is committed in `.env.example` and pushed to GitHub.** No Base key may follow that pattern. Runbooks, monitoring, demo script.

---

## Dependency order

```
1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10
     └── Phase 2 is the risk. It goes first.
```

## Decisions made (flag any you disagree with)

| # | Decision | Rationale |
|---|---|---|
| D1 | Traits measured from seeded behaviour, never written | Only way "52 → 73" is defensible |
| D2 | Agent B's contribution = its own policy's demonstrations | Makes trainer capability economically real |
| D3 | CPU-only training on `AIArenaBattleEnv` | Removes GPU cost and scheduling risk entirely |
| D4 | Identity = custodial agent EOA; money = owner's Spend Permission | Autonomy with a bounded blast radius |
| D5 | Use canonical ERC-8004 on Base, don't fork | Audited, deterministic address, real interop |
| D6 | Job registry + escrow in one contract | Atomicity over modularity |
| D7 | v1 ships without x402; nested sub-services later | Honest fit, not forced |
| D8 | `okx-payment-proxy` untouched | OKX.AI infrastructure, unrelated |
| D9 | Commission 10%, capped, locked at funding | Matches `ArenaEscrow` precedent |

## Sources

- [ERC-8004: Trustless Agents (EIP)](https://eips.ethereum.org/EIPS/eip-8004)
- [erc-8004/erc-8004-contracts — deployments](https://github.com/erc-8004/erc-8004-contracts)
- [Base Account — Spend Permissions](https://docs.base.org/base-account/improve-ux/spend-permissions)
- [Coinbase CDP — x402 network support](https://docs.cdp.coinbase.com/x402/network-support)

---

## Phase 5 delivered — negotiation and agreement

**The EIP-712 agreement is the load-bearing piece.** Both agents sign one
struct; `A2AJobEscrow.verifyAgreement` re-checks both signatures on-chain
before any USDC moves in Phase 6. Nine Hardhat tests assert the contract and
`@ai-arena/a2a-protocol` derive an identical typehash, domain separator and
digest — a drift there would revert every real funding attempt with an opaque
signature error, discovered only on mainnet with real money.

Signed into the agreement, and therefore unalterable afterwards: the price,
the payout wallet, the requirements hash, the execution window, and the
negotiation transcript hash. Tests confirm that changing any of them
invalidates both signatures.

**Transcript integrity.** Every offer is EIP-712 signed by its author and
carries the digest of the message before it. `verifyTranscript` rebuilds the
chain from message contents rather than trusting stored digests, so a row
edited directly in the database fails verification instead of quietly changing
the terms. Tests cover editing, deleting, reordering and inserting a forged
message.

**Bounds enforced off-chain and on.** Prices are clamped to the job's budget
range, turns must alternate, `ACCEPT` must match the price it accepts, and
haggling stops at 20 messages. The contract re-checks the final price
independently — the frontend cannot change a number.

**Autonomy.** `decideProviderResponse` is a deterministic policy: accept at or
above the floor, concede toward the counterparty but never below it, decline
when the job's ceiling sits under the floor. A provider whose floor exceeds the
budget earns nothing, which is what makes the range meaningful. Determinism
means a disputed negotiation can be replayed and the same decision reproduced.

**Key boundary.** `a2a-marketplace-service` composes payloads but holds no key;
it posts domain/types/value to `base-chain-service`, which owns the encrypted
agent EOAs and returns a signature plus the digest it actually signed.

### Known gaps entering Phase 6

- Eligibility is checked when a negotiation OPENS, not when it settles. An
  agent whose capability decays mid-negotiation is not currently re-checked;
  funding should re-verify.
- `A2ANegotiation.state` is stored but always re-derived on read. The column is
  a query convenience and must never be treated as authoritative.
- Concurrent negotiations on one job are permitted by design; the on-chain
  `fundWithAuthorization` is what resolves the race. That path does not exist
  yet, so nothing currently stops two threads from both reaching AGREED.
- Migration SQL for `A2ANegotiation`/`A2ANegotiationMessage` is not generated —
  no database was reachable. `prisma migrate dev` still needs to be run.
