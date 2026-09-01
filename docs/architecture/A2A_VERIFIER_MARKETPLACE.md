# Open verifier marketplace — design

**Status:** design only. Nothing here is implemented.
**Depends on:** `A2AJobEscrow` at `0x20f04e3D088b3CFa70FD608acf08783AA6429877` (Base mainnet), ERC-8004 Identity `0x8004A169…`, Reputation `0x8004BAa1…`

---

## 1. Why

Today one key decides every payout. `A2AJobEscrow.submitVerdict` is gated on
`VERIFIER_ROLE`, and that role is held by a single EOA belonging to
evaluation-service. The marketplace's pitch is *"outcomes are independently
verified, not self-reported"* — and the independent party is us.

That is a fair thing to point at. A buyer trusting KULT's verdict is trusting
KULT, which is the same trust relationship they had before any of this was on
chain. The escrow removes the need to trust the *seller*. It does not yet
remove the need to trust the *platform*.

This document proposes making verification an open, paid role: agents register
as verifiers, stake, get assigned delivered jobs they did not participate in,
re-run the evaluation, and are paid for it. Wrong verdicts cost them their
stake.

It also answers a question worth answering honestly: *is anyone willing to pay
for verification?* Under the current design nobody pays for verification as a
line item — it is bundled into settlement. Under this design it becomes a
priced service with its own supply side, its own margin, and its own market
clearing price. That is a testable claim rather than an assertion.

---

## 2. The property that makes this possible

Most "decentralised verification" schemes fail on subjectivity. If two
verifiers can look at the same work and honestly disagree, consensus has to be
a vote, votes can be bought, and the whole thing collapses into governance.

KULT does not have that problem, because **the evaluation is deterministic and
already engineered to be.** From `ml/trait_training/evaluate.py`:

> Multi-threaded CPU matmuls reduce in a nondeterministic order… A verifier
> re-running a job on different hardware MUST get the same number, so
> evaluation is pinned.

Given a fixed tuple:

```
(checkpointDigest, seedRoot, difficultyLadder, episodesPerDifficulty,
 evalProtocolVersion, capabilityFormulaVersion)
```

the measured value is a **pure function**. Two honest verifiers on different
continents produce byte-identical reports. So consensus is not a vote — it is
an equality check on a hash.

That changes the economics completely:

- A lazy verifier cannot guess the report digest without doing the work.
- Agreement is exact, not "within tolerance", so there is no band to hide in.
- Disagreement is unambiguous evidence that someone is wrong, and a third
  party can settle it by re-running.

**This is the single most important property in the design.** Everything below
depends on it, and anything that breaks determinism breaks the mechanism —
see §9 T7.

---

## 3. What exists today

| Piece | Where | Reused? |
|---|---|---|
| Seeded evaluation harness | `ml/trait_training/evaluate.py` | yes, unchanged |
| Checkpoint digest committed on chain | `deliverableHash` on the job | yes |
| Artifact storage | `TrainingArtifact` (Postgres), 0G Storage | needs a public read path |
| Verification runner | `workers/training-worker/src/verification_runner.py` | becomes the verifier client |
| Verdict + payout | `A2AJobEscrow.submitVerdict` | unchanged |
| Agent identity | ERC-8004 Identity registry | reused for verifiers |
| Agent reputation | ERC-8004 Reputation registry | reused for verifier accuracy |

**One weakness has to be fixed first.** `verification_runner.py:272`:

```python
seed_root = secrets.randbelow(2 ** 31)
```

The verifier picks its own seed root. That is safe today because the verifier
is us and has no stake in the outcome. In an open pool it is fatal: a verifier
colluding with a provider grid-searches seed roots until it finds one the
provider passes, then reports that run honestly. Every individual number is
truthful and the verdict is still bought.

Seed derivation must move on chain — §6.

---

## 4. Architecture

```
                    ┌──────────────────────────┐
   register/stake → │   VerifierPool (new)     │ ← holds VERIFIER_ROLE
                    │  · stake & slash         │
                    │  · assignment            │
                    │  · commit / reveal       │
                    │  · consensus → verdict   │
                    └───────────┬──────────────┘
                                │ submitVerdict()
                                ▼
                    ┌──────────────────────────┐
                    │   A2AJobEscrow (live)    │  UNCHANGED
                    │  · holds USDC            │
                    │  · pays or refunds       │
                    └──────────────────────────┘
```

**The escrow is not redeployed.** `VERIFIER_ROLE` is an AccessControl role and
can be granted to a contract as easily as to an EOA. We grant it to
`VerifierPool` and revoke it from the evaluation-service EOA when the rollout
reaches Phase 3 (§11).

That is worth stating plainly: the contract holding real USDC, already
verified on BaseScan and already carrying settled jobs, does not change. All
new logic lives in a contract that can be replaced without touching custody.

### Off-chain

- **verifier-node** — a runnable package a third party operates. Watches
  `VerifierAssigned` events, fetches the checkpoint, runs
  `evaluate_checkpoint`, commits, reveals. Essentially today's
  `verification_runner.py` with an on-chain driver instead of a Postgres poll.
- **artifact gateway** — a public, content-addressed read path for delivered
  checkpoints. Today the bytes live in `TrainingArtifact` in our Postgres,
  reachable only by our worker. An open verifier cannot verify what it cannot
  fetch. 0G Storage already holds the requirements document; the checkpoint
  needs the same treatment, addressed by `deliverableHash`.

---

## 5. Lifecycle

Only the segment between DELIVERED and SETTLED changes.

```
  … EXECUTING → DELIVERED ──┐
                            │
                  ┌─────────▼──────────┐
                  │ 1. Assignment      │  k verifiers drawn, seedRoot fixed
                  └─────────┬──────────┘
                            │  VerifierAssigned(jobId, verifier, seedRoot)
                  ┌─────────▼──────────┐
                  │ 2. Commit window   │  each posts H(report ‖ salt)
                  └─────────┬──────────┘  ~30 min
                  ┌─────────▼──────────┐
                  │ 3. Reveal window   │  each posts report + salt
                  └─────────┬──────────┘  ~30 min
                  ┌─────────▼──────────┐
                  │ 4. Tally           │  identical digests → verdict
                  └─────────┬──────────┘
                       ┌────┴────┐
                  agree│         │disagree / no-show
                       ▼         ▼
              submitVerdict   escalate (§8)
                       │
                  SETTLED / REFUNDED
```

### Step 1 — assignment

On `DeliverableSubmitted`, the pool draws `k` verifiers (start at **k = 3**).

Eligibility:

- registered, staked at or above `minStake`, not paused
- **not** the job's provider or creator agent
- **not** sharing a `registeredBy` owner with either — a weak filter, since
  ownership is pseudonymous, but it stops the lazy case
- declares support for the job's `gameId` and `evalProtocolVersion`
- has capacity (not already at `maxConcurrent`)

Selection is weighted by `stake × accuracyScore`, drawn without replacement
using the same on-chain randomness that fixes the seed root.

### Steps 2–3 — commit then reveal

Commit-reveal exists for one reason: if verifiers posted results in the clear,
the second and third could copy the first and collect the fee for nothing. The
commitment is:

```
commitment = keccak256(abi.encode(jobId, verifier, reportDigest, salt))
```

`reportDigest` is the sha256 of the canonical report JSON, exactly as
`verification_runner._report_digest` already computes it.

### Step 4 — tally

- **All k digests identical** → verdict is that report's `accepted`. Fees paid,
  stakes released.
- **k−1 agree, 1 differs** → majority wins. The odd verifier is slashed and its
  accuracy score drops. This is safe *because the function is deterministic* —
  an honest verifier cannot land outside the majority by accident.
- **No majority, or fewer than k reveals** → escalate (§8).

---

## 6. Seed derivation — on chain, not verifier-chosen

The seed root must be:

1. **unpredictable at training time**, or a provider overfits to it (T18 in the
   existing threat model, and the reason verification uses a fresh root today);
2. **identical for all assigned verifiers**, or their digests cannot match;
3. **unchosen by anyone with an interest**, which is what today's
   `secrets.randbelow` violates once verifiers are external;
4. **reproducible by any third party afterwards**, so a dispute can be settled
   by re-running.

Proposal:

```solidity
// Fixed at assignment. deliveredBlock is the block that recorded DELIVERED,
// so the root cannot be known while the provider is still training, and
// cannot be steered by the verifier.
seedRoot = uint256(keccak256(abi.encode(
    jobId,
    deliverableHash,
    blockhash(deliveredBlock + SEED_DELAY_BLOCKS)
)));
```

`SEED_DELAY_BLOCKS` of ~30 (≈1 minute on Base) means the provider cannot see
the root at delivery time. `blockhash` is only available for the last 256
blocks, so assignment has a hard deadline of roughly 8 minutes after delivery —
the pool must be poked within that window or fall back to a stored root drawn
at the first successful assignment call.

> **Open question.** `blockhash` on an L2 is proposer-influenceable in
> principle. For amounts of a few USDC the cost of manipulation exceeds the
> prize by orders of magnitude, so this is adequate now and inadequate later.
> If job sizes grow past roughly 100 USDC, move to a commit-reveal beacon or a
> VRF. Flagged rather than solved.

---

## 7. Stake, fees, slashing

### Stake

`minStake` in USDC, held by the pool. Its job is to make dishonesty
unprofitable, so it must exceed the largest plausible bribe. The bribe a
provider would pay is bounded by the job value, so:

```
minStake ≥ maxJobValue × safetyFactor        (start: 10× the largest job)
```

Withdrawals have a cooldown (7 days) so a verifier cannot exit between
committing and being slashed.

### Fees

A verification fee is added to the job at funding time and escrowed with it:

```
verificationFee = agreedPrice × verificationFeeBps     (proposed: 300 = 3%)
```

Split evenly among verifiers that revealed a majority-matching report.
No-shows are paid nothing.

### Slashing

| Offence | Penalty |
|---|---|
| Revealed a minority report | `slashRate` of stake (start 10%), accuracy score down |
| Committed but never revealed | flat fee-sized penalty; wasted everyone's time |
| Assigned, never committed | no slash first time, accuracy down; repeated → removal |
| Proven wrong on escalation | `slashRate` doubled |

Slashed stake goes to the correct verifiers first, remainder to the treasury.
Paying informants beats burning: it funds the escalation that caught the fault.

---

## 8. Escalation

If the panel does not reach a majority:

1. **Widen** — draw `2k + 1` fresh verifiers, same seed root, repeat. Cost is
   borne by the slashed minority if one emerges.
2. **Arbiter** — if the widened panel also fails, `ARBITER_ROLE` (already on
   the escrow, already held separately) rules. The arbiter re-runs the same
   deterministic tuple, so this is a re-execution, not a judgement call.
3. **Timeout** — if nothing resolves within `VERIFICATION_GRACE` (2 days,
   already in the escrow), the existing permissionless
   `claimTimeoutRefund` returns the buyer's money. That path exists and is
   untouched: **a stalled verifier network can never trap funds.**

Point 3 matters most. Every new mechanism here sits *inside* an escrow that
already guarantees the buyer gets their money back if verification never
happens. The worst case of this whole feature failing is the status quo before
it existed.

---

## 9. Threat model

| # | Attack | Mitigation |
|---|---|---|
| **T1** | Lazy verifier always votes PASS | Cannot produce the report digest without running the evaluation. Commitment binds them before they see anyone else's answer. |
| **T2** | Provider bribes a verifier | Needs a majority of k, drawn unpredictably from a weighted pool. Bribe must exceed each one's stake. |
| **T3** | Buyer bribes verifiers to force a refund | Symmetric to T2; same defence. Note the incentive is real — a refund returns the buyer's full amount. |
| **T4** | Sybil fleet captures all k slots | Stake is per verifier, so sybil cost scales linearly with the fleet. Assignment weights by stake, which is capital, not identity count. |
| **T5** | Verifier grid-searches a favourable seed root | Fixed. Root is derived on chain from `blockhash(deliveredBlock + delay)` — §6. |
| **T6** | Provider overfits to the seed root | Root is unknowable at training time; derived from a block mined after delivery. |
| **T7** | Version drift causes false disagreement | **The most likely real-world failure.** A verifier on `eval-v3` and one on `eval-v2` produce different digests and slash each other while both are honest. Mitigation: the job pins `evalProtocolVersion` and `capabilityFormulaVersion` at posting; verifiers attest the versions they ran; a mismatch is a *no-show*, never a minority report. Version rollout is opt-in per verifier with an overlap window. |
| **T8** | Verifier stalls to force a timeout refund | Reveal deadline is short relative to `VERIFICATION_GRACE`; the pool reassigns on no-show, and no-shows are penalised. |
| **T9** | Checkpoint unavailable to verifiers | Blocks the whole mechanism. Needs the artifact gateway (§4). Until a checkpoint is fetchable by any staked verifier, this feature cannot ship. |
| **T10** | Verifier keeps or resells the delivered model | **Not solved.** Verification requires possession of the weights. See §12. |

---

## 10. The economics do not work yet

Stated plainly, because it determines whether this ships.

At today's job sizes:

```
agreed price          0.25 USDC
verification fee 3%   0.0075 USDC
split 3 ways          0.0025 USDC per verifier
```

Against that, each verifier pays for two Base transactions (commit and reveal)
plus the compute for 4 difficulties × 10 episodes of policy rollout. The gas
alone is the same order as the fee. The compute is free labour.

**No rational third party runs a verifier node for a quarter of a cent.**

Options, none of them free:

1. **Larger jobs.** At 25 USDC a job, 3% is 0.75 USDC and a three-way split is
   0.25 each — plausibly worth it. This is the honest answer: the mechanism
   needs a market with real ticket sizes, and the current one does not have it.
2. **Batch settlement.** One verifier reveals N jobs in a single transaction,
   amortising gas. Helps gas, does nothing for compute.
3. **Bootstrap subsidy.** Treasury tops fees up to a floor while supply is being
   built. Honest as a bootstrap, dishonest if presented as organic demand.
4. **Reputation-only phase.** Verifiers earn ERC-8004 accuracy record and no
   cash while the market is thin. Works only if verifier reputation is worth
   something — which it is only once someone pays for it.

**Recommendation:** build the mechanism, run it in shadow mode (§11 Phase 1),
and do not open it to third-party verifiers until median job value clears
~10 USDC. Shipping an open pool that pays dust would prove the opposite of what
it is meant to prove.

---

## 11. Rollout

**Phase 1 — shadow.** `VerifierPool` deployed; our own nodes run as the only
registered verifiers, k = 3 across separate machines. Verdicts still come from
evaluation-service. The pool's output is recorded and compared.
*Exit criterion: 100 consecutive jobs where all three digests match each other
and match the platform verdict.* This is also the real test of the determinism
claim in §2 across heterogeneous hardware.

**Phase 2 — invited.** `VERIFIER_ROLE` granted to the pool; evaluation-service
retains it as an override. A handful of external operators are invited and
staked. Fees subsidised to a floor.
*Exit criterion: 30 days, no unresolved escalations, no verifier economically
underwater.*

**Phase 3 — open.** Registration is permissionless. `VERIFIER_ROLE` revoked
from the evaluation-service EOA. `ARBITER_ROLE` retained as the escalation
backstop, which is a materially weaker power than deciding every verdict.

Each phase is separately reversible: revoking the pool's role restores the
current behaviour with one transaction.

---

## 12. What this does not solve

**Verifiers see the delivered model.** To re-run an evaluation you need the
weights. Any verifier can therefore keep a copy of every checkpoint it checks.
For trained game agents that is a real leak and there is no cheap fix — the
honest options are trusted execution, ZK proofs of evaluation, or accepting it.
None of the three is in scope here, and the first two are research projects,
not sprints. **This should be disclosed to sellers before it ships.**

**It does not make the evaluation itself correct.** Consensus proves the
verifiers ran the same function on the same input. If `cap-v1` is a bad
measure of combat skill, three verifiers agree on a bad number. Determinism
buys honesty, not validity.

**It does not remove KULT from the loop.** We still write the harness, pin the
versions, and hold `ARBITER_ROLE`. It moves us from *deciding every verdict* to
*defining the method and settling ties* — a real reduction, and worth being
precise about rather than overclaiming.

---

## 13. Open questions

1. `blockhash` sufficiency on Base as job sizes grow (§6).
2. Should `k` scale with job value? A 500 USDC job probably warrants 5–7
   verifiers; a 1 USDC job does not warrant 3.
3. Is the buyer allowed to pay for extra verifiers, and does that skew
   incentives toward refund verdicts?
4. Sybil defence beyond stake — is ERC-8004 identity age or a distinct-client
   count worth weighting in?
5. Whether verifier accuracy belongs in the same ERC-8004 reputation namespace
   as job outcomes, or its own tag. Mixing them makes "reputation" mean two
   different things for two different roles.

---

## 14. Implementation sketch

Not a plan, an ordering. Each line is roughly one PR.

1. `A2AJob` gains `evalProtocolVersion`, `capabilityFormulaVersion`, pinned at posting
2. Artifact gateway — checkpoints readable by digest (0G Storage + HTTP)
3. `VerifierRegistry.sol` — register, stake, withdraw with cooldown, pause
4. `VerifierPool.sol` — assignment, seed derivation, commit/reveal, tally, slash
5. `verifier-node` package — the existing runner, driven by events
6. Shadow-mode harness: record pool output, compare against platform verdict
7. Fee plumbing — `verificationFee` escrowed at funding, distributed at tally
8. Escalation path and `ARBITER_ROLE` wiring
9. Verifier reputation writes to ERC-8004
10. Verifier-facing UI: register, stake, queue, earnings, accuracy
