# AI Systems — Technical Reference

This document describes the AI architecture behind AI Arena agents: how they make decisions during combat, how they learn from battle telemetry, how their personalities and memories evolve over time, and how all of this integrates with 0G and Solana infrastructure.

---

## Agent Autonomy

AI Arena agents are genuinely autonomous during combat. Every few ticks of a live battle, an agent calls the 0G Compute Router — a decentralised inference network — to determine its next action. The call receives the current battle state, the agent's personality trait vector, opponent intelligence retrieved from memory, and the strategic plan drafted at match start. The output is a structured decision: action type, aggression level, target, and confidence score.

The backend does not override combat decisions. The agent executes its own trained policy.

Autonomy boundaries:

- **Inference timeout:** If a 0G Compute call exceeds the 5-second cap, the agent falls back to a conservative defensive action so the battle loop does not stall.
- **Financial guardrails:** Wagering and $ARENA spending are governed by on-chain policy limits enforced in the agent wallet program — daily spend caps and maximum single wager amounts. An agent cannot drain its wallet arbitrarily.
- **Moderation:** Platform administrators can freeze wallets if the anti-cheat system flags anomalous behaviour.

The combat decision layer is fully autonomous. The economic behaviour is autonomous within defined on-chain guardrails.

---

## AI Models and Behavioural Systems

Three separate systems drive agent behaviour.

### 1. Transformer Policy Network

Each agent has a trained behaviour model specific to it. The architecture is a transformer with 4 attention layers and 128 hidden dimensions. It takes a flattened observation of the battle state and outputs action logits — probability distributions over the possible actions.

Training runs in two modes:

**Behaviour Cloning (BC):** The system ingests battle telemetry and trains the agent to reproduce successful patterns from historical state-action pairs. The model is a LoRA adapter on top of a base LLM (Phi-3-Mini or Mistral-7B), keeping inference latency low.

**Reinforcement Learning (PPO):** Agents also train by self-play against a population of opponents. The reward structure:

| Event | Reward |
|-------|--------|
| Kill opponent | +5 |
| Win match | +20 |
| Die | -10 |
| Take 10 HP damage | -0.5 |
| Survive each 10-tick window | +0.1 |
| Win efficiently (low personal damage) | +2 bonus |

This reward function penalises pyrrhic wins — an agent that wins but sustains heavy damage in every fight will underperform one that wins cleanly.

### 2. Warzone TensorFlow.js Network

In the Warzone game, agents run a lighter model: a 4-layer dense network (17 → 64 → 64 → 32 → 5) that runs in-process using TensorFlow.js. Input is a 17-float state vector — position, velocity, facing direction, HP, and relative positions of up to 5 nearby enemies. Output is 5 continuous values: horizontal movement, vertical movement, jump, shoot, grenade.

Inference time is approximately 1ms per frame, enabling real-time control of a shooter agent. The model is behaviour-cloned from real player gameplay and retrained when sufficient new samples accumulate (minimum 500 samples).

### 3. LLM Fallback via 0G Compute

When no trained local model exists (cold start, new agent), the system falls back to the 0G Compute Router using `zai-org/GLM-5.1-FP8`. A system prompt encodes game strategy rules; the model returns a structured JSON action with a reasoning field. This path runs at 100–400ms and is used for strategic-level decisions and as a cold-start bridge until a trained model is available.

---

## Decision Pipeline During Combat

**In AIArena,** each combat tick follows this sequence:

1. Read current battle state from Redis (both agents: HP, position, resources, visible information)
2. Retrieve the agent's active model version from the database
3. Build inference context: opponent archetype, recent opponent actions, relevant past encounters retrieved from Qdrant via vector similarity search
4. Call 0G Compute Router with full context (5-second timeout)
5. Execute the returned action
6. Broadcast result to both clients via WebSocket
7. Log the action as telemetry for the next training cycle

All inference calls use `tool_choice: "required"` with a structured response schema — the model must return a valid action object. Free-text responses are rejected, preventing malformed outputs from disrupting the battle loop.

**In Warzone,** since it is a real-time shooter, decisions happen every frame through the local TF.js model. The state vector is encoded fresh each frame, passed through the network, and the output applied immediately. The LLM path is only consulted when the local model is absent.

---

## Training Data Sources

**AIArena agents** learn from:
- Live battle telemetry: per-tick action logs, damage dealt and received, positioning
- Feature extraction pipeline converting raw telemetry into 11 behavioural metrics: actions per second, kill/death ratio, ability usage rate, reaction latency, action entropy (unpredictability score), movement entropy (spatial coverage), aggression index, headshot rate, economy efficiency, burst frequency
- Past battle memories stored as BGE-M3 embeddings in Qdrant, retrieved via vector similarity for RAG-augmented inference context

**Warzone agents** learn from:
- Gameplay samples collected during live play — each sample is a state-action pair capturing what the player did in a given game state
- Optionally, synthetic samples generated by 0G Compute to match the player's observed playstyle (shoot rate, jump frequency, average HP thresholds, grenade usage)

All training data is uploaded to 0G Storage and indexed by Merkle root hash. Every sample batch is traceable to its originating gameplay session.

---

## Personality, Memory, and Strategic Evolution

### Personality Traits

Each agent has 8 core traits on a 0–100 scale: aggression, patience, adaptability, risk tolerance, teamwork, creativity, endurance, and precision. These are generated once at agent creation by calling 0G Compute with the agent's name, clan, archetype, and backstory as context.

Traits are functional — they are passed into the inference context for every combat decision. An agent with `aggression: 90` and `patience: 15` generates materially different strategic plans than one with `aggression: 30` and `patience: 80`.

Traits can mutate when an agent evolves (GENESIS → AWAKENED → ASCENDED → LEGENDARY → MYTHIC). Each evolution event is recorded on-chain in the agent's INFT (ERC-7857 token on 0G Chain).

### Memory Architecture

The memory system operates across four tiers:

**Working memory (Redis, TTL = 1h):**
Per-battle real-time state and the last N opponent actions. Sub-millisecond access. Cleared after battle ends.

**Episodic memory (PostgreSQL + Qdrant):**
Structured battle episode records, importance-scored (wins at 0.8, losses at 0.6). BGE-M3 1024-dimensional vectors in Qdrant enable semantic retrieval. Each episode is also uploaded to 0G Storage as a snapshot.

**Semantic memory (Qdrant):**
Abstracted patterns across multiple episodes. Enables cross-battle learning independent of specific opponents.

**Procedural memory (0G Storage):**
Full serialised memory snapshots (up to 500 most important records) written after every battle via `compactMemory()`. The Merkle root hash is anchored on-chain via `INFT.updateMemoryRoot()`. Versioned history stored as `agents/{id}/memory/snapshot-{timestamp}`. Used for cold-start recovery, fine-tuning dataset preparation, and anti-cheat audit.

### Rivalries

A rivalry forms naturally when two agents meet repeatedly. Each encounter adds to episodic memory, and by the third or fourth meeting the inference context includes detailed knowledge of that opponent's tendencies. Agents can develop specialised counter-strategies against rivals encountered frequently.

### Strategic Planning

At the start of each battle, the agent drafts a `StrategicPlan`:

```
primaryObjective:       survive | aggress | defend | control
tacticalPriorities:     ["find cover", "conserve resources", "flank"]
positioningPreference:  defensive | aggressive | flanking
engagementTiming:       reactive | proactive | mixed
retreatThreshold:       0.25  (retreat when HP falls below 25%)
```

This plan is generated from the agent's trait vector and opponent profile. It influences every subsequent inference call during the battle. If the plan specifies "defensive" and HP drops near the retreat threshold, inference prioritises survival actions even when aggressive openings exist.

---

## Agent Divergence Over Time

Several mechanisms cause agents to diverge from one another over time, even when starting from identical trait vectors:

**Different training data:** Each agent fights different opponents in different sequences. Two agents with identical starting traits will diverge after approximately 20 battles simply from having encountered different strategies.

**RL self-play divergence:** During PPO training, agents train against opponent populations. Depending on which opponents they encounter most frequently, they optimise in different directions — one may develop early aggression, another a counter-punching style.

**Memory accumulation:** As episodic memories accumulate, each agent's RAG retrieval surfaces different past experiences for the same tactical situation, nudging inference toward different choices.

**Model version timeline:** An agent trained in month 1 is frozen at that meta. An agent retrained in month 4 has encountered different balance states, different opponents, and different ecosystem strategies. They are literally different models.

**Trait mutation on evolution:** Advancing to the next evolution stage can shift base trait values. Two agents starting as GENESIS with nearly identical traits can diverge significantly if one evolves faster and receives a mutation that shifts aggression by 15 points.

**Non-deterministic data enrichment:** In Warzone, synthetic training samples are generated by an LLM. Even given the same player style summary, two enrichment calls produce different samples, introducing variance at the data level before training begins.

---

## On-Chain vs. Off-Chain

### On-Chain

**0G Chain (EVM, Chain ID 16661):**
- INFT minting — agents are ERC-7857 tokens with living state: metadata updates as the agent evolves
- Trait storage and evolution stage
- Memory root hash — the Merkle root of the agent's current memory state, anchored after each battle. Token holders can verify memory integrity independently.
- Model version hash — trained model content-addressed; hash anchored on-chain
- Usage authorisation — the INFT tracks which addresses hold inference rights, enabling agent rentals

**Solana (Devnet → Mainnet):**
- Agent wallets — PDA-based accounts holding SPL $ARENA balances
- Escrow vault — both agents lock stakes before a wager battle; settlement is automatic on result
- Staking program — agents lock $ARENA for tournament entry or passive yield
- Tournament prize distribution — winner payouts as direct SPL token transfers

**Warzone (0G EVM):**
- `PlayerSaveAnchor.sol` — every game save anchored on-chain via its 0G Storage Merkle root hash. The contract enforces a strict anti-rollback rule: save index must increase monotonically. Prior saves cannot be restored.

### Off-Chain

- Battle execution and orchestration
- AI inference (via 0G Compute Router — decentralised infrastructure, but per-tick results are not stored on-chain)
- Training pipeline (Python workers, Ray, PyTorch)
- Memory management (Redis, PostgreSQL, Qdrant)
- Live game state during a match
- Feature extraction from telemetry
- Real-time WebSocket communication

The general pattern: heavy computation runs off-chain; outcomes and cryptographic proofs are anchored on-chain.

---

## Solana Throughput

The Solana integration is scoped to battle settlement frequency, not per-frame game events.

**Per wager battle:**
1. Lock escrow — two SPL token transfers into the vault PDA
2. Settle escrow — one transfer to winner (90% of pool), one to platform (10% commission)

**Per tournament:**
1. Entry fees locked on registration
2. Ranked prize distribution on completion (3 transfers: 50%, 30%, 20%)

**Agent lifecycle:**
1. Wallet creation — one PDA initialisation per agent (one-time, at creation)

For 1,000 concurrent wager battles, this is approximately 2,000 SPL transfers for locking and 2,000 for settlement. Solana handles 50,000+ TPS with sub-second finality at sub-cent fees. The escrow state machine is explicit and minimal: Open → Funded → Locked → Settled → Cancelled. Each transition is a single Anchor instruction. Scaling at the transaction layer is not a constraint; the primary coordination challenge is keeping the off-chain battle orchestrator and on-chain escrow state synchronised.

---

## $ARENA Token Demand Mechanics

$ARENA token velocity is driven by platform activity, not speculation.

**Battle wagering:** To play ranked wager matches, both agents stake $ARENA. The winner takes 90% of the pool; the platform retains 10%. Every completed wager match creates real on-chain token flow.

**Tournament entry:** Entry fees are locked in escrow and distributed to top finishers. As prize pools increase, entry fee pressure increases, pulling more $ARENA into active circulation.

**Inference fees:** Calling 0G Compute during combat consumes $ARENA. Higher-performance agents using more frequent or more sophisticated inference are literally more expensive to operate.

**Staking:** Agents stake to maintain ranking eligibility or earn passive yield. Staked supply is locked and not circulating, reducing liquid float.

**Platform commission:** 10% of every wager pool accumulates in platform reserves, available for governance-directed allocation (buybacks, development grants, ecosystem incentives).

The token functions as operational fuel: the more active the ecosystem — battles, tournaments, training jobs — the greater the sustained demand.

---

## Viral Growth Mechanics

**Agents are owned assets.** Players train and own AI fighters as NFTs with verifiable on-chain history. Win streaks and impressive battle replays represent real asset value, creating natural sharing incentives.

**Agent vs. agent battles generate content autonomously.** Two AI agents fighting produces watchable content without a human player being present. Tournaments can run 24/7 with automated progression and optional commentary via 0G Compute, creating a continuous content stream without scheduling.

**Rivalries create narratives.** When two agents have met 10+ times and one has developed a consistent counter-strategy against the other, that is a documented story with on-chain provenance. Audiences follow rivalries with stakes attached.

**Training progression is observable.** The path from GENESIS to MYTHIC — with each evolution recorded on-chain and model hashes anchored — is a progression arc both players and audiences can follow and verify independently.

---

## Architecture Reference

| Component | Location | Responsibility |
|---|---|---|
| Agent creation | `services/agent-service` | Trait generation, avatar upload, INFT mint trigger |
| Combat inference | `services/inference-service` | Real-time action decisions via 0G Compute |
| Battle orchestration | `services/battle-service` | Room lifecycle, escrow locking, result archival |
| 4-tier memory | `services/memory-service` | Redis + PostgreSQL + Qdrant + 0G Storage |
| Training pipeline | `services/training-service` + `workers/training-worker` | Job queue → dataset upload → model training → 0G Storage |
| Behaviour cloning model | `ml/behaviour_cloning/model.py` | Transformer policy network (4-layer, 128-dim) |
| RL training | `ml/reinforcement_learning/` | PPO via Ray RLlib, custom gym environment |
| Feature extraction | `ml/feature_extraction/` | Telemetry → 11 behavioural feature vectors |
| Agent wallet (Solana) | `contracts/solana/agent-wallet/` | PDA wallet + daily spend policy |
| Escrow vault (Solana) | `contracts/solana/escrow-vault/` | Wager locking and settlement |
| INFT contract (0G EVM) | `contracts/evm/contracts/AIArenaINFT.sol` | ERC-7857 living NFT |
| Financial service | `services/financial-service` | Escrow settlement, ledger, balances |

---

*Last updated: May 2026.*
