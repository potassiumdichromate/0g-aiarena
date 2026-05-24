# How the AI Actually Works in 0G AIArena & Warzone

This document covers the real mechanics behind the AI agents — how they think, learn, fight, evolve, and interact with Solana and 0G blockchain infrastructure. Written to answer the hard questions honestly, not to sell a pitch deck.

---

## How Autonomous Are the Agents, Really?

Short answer: genuinely autonomous during combat, with guardrails on the financial side.

Every few ticks of a live battle, an agent calls the 0G Compute Router — a decentralized inference network — to decide its next action. That call takes in the current battle state, the agent's personality traits, what it knows about the opponent from memory, and the strategic plan it drafted at the start of the fight. The output is a structured decision: what action type, how aggressive to be, which target, and how confident the agent is.

The backend never overrides that decision mid-fight. The agent is running its own policy, not a random number generator, not a scripted ruleset.

Where it stops being fully autonomous:
- If inference times out (5 second cap), the agent falls back to a conservative defensive action so the battle doesn't stall. It doesn't make a "smart" fallback, it just holds position.
- Financial actions (wagering, spending $ARENA) are governed by policy limits enforced on-chain: daily spend caps, max single wager amounts. An agent cannot drain its own wallet arbitrarily.
- Admins can freeze wallets if the anti-cheat system flags suspicious behavior.

So: the combat brain is autonomous. The economic behavior is autonomous within human-defined guardrails.

---

## What ML/AI Models or Behavioral Systems Power Them?

There are three separate systems, and they serve different purposes.

### 1. The Transformer Policy Network (AIArena)

Each agent has a behavior model trained specifically for it. The architecture is a transformer with 4 attention layers and 128 hidden dimensions. It takes a flattened observation of the battle state and outputs action logits — probabilities over the possible actions.

Training happens in two ways:

**Behavior Cloning (BC)** — the system watches battle telemetry and trains the agent to reproduce successful patterns. You give it thousands of state-action pairs and train it to predict what action was taken in each state. The model is a LoRA adapter on top of a base LLM (Phi-3-Mini or Mistral-7B), which keeps the model small enough to serve at low latency.

**Reinforcement Learning (PPO)** — agents also train by playing against copies of themselves in a simulator. The reward structure is straightforward:
- Kill opponent: +5
- Win match: +20
- Die: -10
- Take 10 HP damage: -0.5
- Survive each 10-tick window: +0.1
- Win efficiently (low personal damage taken): +2 bonus

This pushes agents to develop survival instincts, not just aggression. An agent that wins but gets shredded every fight will score worse than one that wins cleanly.

### 2. The Warzone TensorFlow.js Network

In the Warzone game, agents run a lighter model: a 4-layer dense network (17 → 64 → 64 → 32 → 5 neurons) that runs in-process using TensorFlow.js. It takes 17 floats as input — position, velocity, facing direction, HP, and relative positions of up to 5 nearby enemies — and outputs 5 continuous values: horizontal movement, vertical movement, jump, shoot, grenade.

This runs at roughly 1ms per frame, which is why it can drive a real-time shooter. It's behavior-cloned from real player gameplay and retrained each time enough new samples accumulate (minimum 500).

### 3. LLM Fallback (0G Compute)

When no trained local model exists for an agent (cold start, new account), the system falls back to the 0GM-1.0-35B-A3B model via the 0G Compute Router. A system prompt encodes the game's strategy rules, and the model returns a JSON action with a reasoning field. This takes 100–400ms, so it's not per-frame — it's used for strategic-level decisions and as a cold-start bridge until a trained model exists.

---

## How Do Agents Make Decisions During Gameplay?

**In AIArena**, the decision pipeline per combat tick looks like this:

1. Read current battle state from Redis (both agents' HP, position, resources, visible info)
2. Pull the agent's active model version from the database
3. Build inference context: opponent archetype, recent opponent actions, relevant past encounters retrieved from vector memory
4. Call 0G Compute Router with all of that as context (max 5 second timeout)
5. Execute the returned action
6. Broadcast result to both clients via WebSocket
7. Log the action as telemetry for the next training cycle

The inference call itself uses `tool_choice: "required"` with a structured schema — the model must return a valid structured action, never free text. This prevents unparseable responses from crashing the battle loop.

**In Warzone**, since it's a real-time shooter, decisions happen every frame through the local TF.js model. The 17-float state is encoded fresh each frame, run through the network, and the 5-float output is applied immediately. The LLM is only consulted when the local model is missing.

---

## What Data Do They Learn From?

**AIArena agents** learn from:
- Live battle telemetry (per-tick action logs, damage dealt/taken, positioning)
- Feature extraction pipeline that converts raw telemetry into 11 behavioral metrics: actions per second, kill/death ratio, ability usage rate, reaction latency, action entropy (unpredictability score), movement entropy (spatial coverage), aggression index, headshot rate, economy efficiency, burst frequency
- Past battle memories stored as embeddings in Qdrant (vector database) — used for Retrieval-Augmented Generation so the agent can recall what worked against a specific opponent

**Warzone agents** learn from:
- Real gameplay samples collected while human players play — each sample is a state-action pair capturing what the player did in that game state
- Optionally, synthetic samples generated by 0G Compute that match the player's observed style (their shoot rate, jump frequency, average HP at various points, grenade usage)

All training data is uploaded to 0G Storage and indexed by Merkle root hash. Nothing is discarded — every sample batch is traceable back to the original gameplay session.

---

## How Do Personalities, Rivalries, and Strategies Evolve?

### Personalities

An agent's personality is 8 core traits on a 0–100 scale: aggression, patience, adaptability, risk tolerance, teamwork, creativity, endurance, and precision. These are generated once at creation by calling 0G Compute with the agent's name, clan, archetype, and backstory as context.

The traits aren't cosmetic. They're passed into the inference context for every combat decision. An agent with aggression: 90 and patience: 15 will generate different strategies than one with aggression: 30 and patience: 80 — the LLM uses those numbers when building the combat plan.

Traits can mutate when an agent evolves (GENESIS → AWAKENED → ASCENDED → LEGENDARY → MYTHIC). Each evolution is recorded on-chain in the agent's INFT (ERC-7857 token on 0G Chain).

### Memory and Rivalries

The memory system is layered:

**Working memory** lives in Redis. It holds current battle state and the last N opponent actions. It expires within an hour of a battle ending.

**Episodic memory** lives in Postgres and Qdrant. After each battle, the outcome is stored as a structured record: who was fought, what happened, what the score was. Wins are stored with importance weight 0.8, losses at 0.6. Before a rematch, the memory service does a vector similarity search for relevant past encounters and injects them into the inference context.

**Semantic memory** lives in Qdrant as BGE-M3 embeddings. This is the abstracted level — patterns learned across many opponents, not tied to specific battles.

**Procedural memory** is a full state snapshot saved to 0G Storage after each battle. It's used for cold starts, replays, and building training datasets.

A rivalry forms naturally when two agents meet repeatedly. Each encounter adds to the episodic memory, and by the third or fourth meeting, the inference context includes detailed knowledge of what that specific opponent tends to do. Agents can develop specialized counter-strategies against rivals they've fought often.

### Strategic Evolution

At the start of each battle, the agent drafts a `StrategicPlan`:

```
primaryObjective: survive | aggress | defend | control | ...
tacticalPriorities: [e.g., "find cover", "conserve resources", "flank"]
positioningPreference: defensive | aggressive | flanking
engagementTiming: reactive | proactive | mixed
retreatThreshold: 0.25  (retreat when HP falls below 25%)
```

This plan is generated from the agent's traits and opponent profile. The plan influences every subsequent inference call during that battle. If the plan says "defensive" and the agent's HP drops near the threshold, inference will prioritize survival actions even if an aggressive opening exists.

---

## What Creates Divergence Between Agents Over Time?

Several things push agents apart:

**Different training data** — Each agent fights different opponents in different orders. Telemetry is specific to those encounters. Two agents with identical starting traits will diverge after 20 battles simply because they've seen different things.

**RL self-play divergence** — During PPO training, agents train against populations of opponents. Depending on which opponents they encounter most, they optimize in different directions. One might over-index on early aggression; another might develop a patience-heavy counter-punching style.

**Memory accumulation** — As episodic memories build up, each agent's RAG retrieval will surface different past experiences for the same situation, nudging inference toward different choices.

**Model version timeline** — An agent trained in month 1 is frozen at that meta. An agent retrained in month 4 has seen different balance changes, different opponents, different strategies in the ecosystem. They're literally different models.

**Trait mutation on evolution** — Evolving to the next stage can shift base traits. Two agents that start as GENESIS with nearly identical traits can diverge if one evolves faster and gets a mutation that pushes aggression up 15 points.

**Non-deterministic enrichment** — In Warzone, synthetic training samples are generated by an LLM. Even for the same player style summary, two enrichment calls will produce different samples. This adds variance at the data level before training even starts.

---

## What Is On-Chain vs Off-Chain?

### On-Chain

**0G Chain (EVM, Chain ID 16661)**
- INFT minting — agents are ERC-7857 tokens. The standard supports living state: the NFT metadata updates as the agent evolves.
- Trait storage and evolution stage — on-chain in the INFT
- Memory root hash — the Merkle root of the agent's current memory state is anchored on-chain after each battle. If you hold the NFT, you can verify the memory hasn't been tampered with.
- Model version hash — same idea. The trained model is content-addressed; the hash goes on-chain.
- Usage authorization — the INFT tracks which addresses have inference rights on the agent. This enables agent rentals.

**Solana (Devnet → Mainnet)**
- Agent wallets — PDA-based accounts holding SPL $ARENA balances
- Escrow vault — before a wager battle, both agents lock their stakes into the vault contract. Settlement happens automatically when the battle resolves.
- Staking program — agents can lock $ARENA for tournament entry or passive income
- Tournament prize distribution — winner payouts are direct SPL token transfers

**Warzone (0G EVM)**
- PlayerSaveAnchor.sol — every game save is anchored on-chain via its 0G Storage Merkle root hash. The contract enforces an anti-rollback rule: save index must strictly increase. Nobody can rewind to an older save.

### Off-Chain

Everything else:
- Battle execution and orchestration
- AI inference (runs through 0G Compute Router, which is decentralized infrastructure but the result isn't stored on-chain per-tick)
- Training pipeline (Python workers, Ray, PyTorch)
- Memory management (Redis, Postgres, Qdrant)
- Game state during a live match
- Feature extraction from telemetry
- Real-time WebSocket communication

The pattern is: heavy computation happens off-chain, outcomes and proofs are anchored on-chain.

---

## How Does Solana Activity Scale?

The Solana integration is designed to handle activity at the frequency of battle settlements, not per-frame game events. Here's what actually touches Solana:

**Per battle (wager matches only)**:
1. Lock escrow — two SPL token transfers into the vault PDA
2. Settle escrow — one transfer to winner (90% of pool), one to platform (10% commission)

**Per tournament**:
1. Entry fees locked on registration
2. Ranked prize distribution on completion (3 transfers: 50%, 30%, 20%)

**Agent lifecycle**:
1. Wallet creation — one PDA initialization per agent (one time, at creation)

So for 1,000 concurrent wager battles, you're looking at ~2,000 SPL transfers for locking and ~2,000 for settlement. Solana handles 50,000+ TPS with sub-second finality at sub-cent fees. The escrow contract is straightforward Anchor code — no complex loops, no dynamic fee structures that blow up under load.

The state machine in the escrow contract is simple and explicit: Open → Funded → Locked → Settled → Cancelled. Each transition is a single instruction. Scaling is not a concern at the transaction level; it's more about backend coordination (making sure the off-chain battle orchestrator and the on-chain escrow stay synchronized).

---

## How Does $ARENA Accrue Value?

$ARENA isn't backed by speculation — it's backed by demand for access to the system. Here's where real demand comes from:

**Battle wagering** — to play ranked wager matches, both agents stake $ARENA. The winner takes 90% of the pool; the platform takes 10%. Every wager match burns a small amount from the loser's holdings and routes 10% to platform reserves. Volume of competitive matches directly drives token velocity.

**Tournament entry** — fees locked in escrow, distributed to top finishers. As tournaments get more valuable (better players, higher prize pools), entry fees increase, pulling more $ARENA into circulation as prizes.

**Inference fees** — calling 0G Compute costs tokens. More intelligent agents (more frequent inference, more complex reasoning) consume more $ARENA to operate. High-performance agents are literally more expensive to run.

**Staking** — agents stake to maintain ranking eligibility or earn passive yield. Staked tokens are locked (not circulating), which reduces liquid supply.

**Platform commission accumulation** — 10% of every wager pool hits platform reserves. If governance is implemented, these reserves can fund buybacks, development, or ecosystem incentives.

The token is designed to be a fuel token: the more active the ecosystem (battles, tournaments, training jobs), the more it gets consumed. The question "does this accrue value" depends on whether enough activity flows through the system to create meaningful, consistent demand.

---

## How Viral Can This Get?

The mechanics that enable viral loops:

**Agents are owned assets** — you don't just play a game, you train and own an AI fighter as an NFT. Sharing your agent's win streak or an impressive battle replay is shareable content with real stakes attached (the agent is worth real money).

**Agent vs Agent battles are watchable** — two AI agents fighting generates content automatically. No player needs to be live. Tournaments can run 24/7 with automated commentary (0G Compute again), creating a stream of content without scheduling.

**Rivalries create narratives** — when two agents have fought 10+ times and one consistently counters the other, that's a story. People follow rivalries. The memory system means these rivalries have documented history that fans can follow.

**Training progression is visible** — watching an agent go from GENESIS to LEGENDARY with verifiable on-chain history, each evolution recorded, is a progression arc that players (and audiences) can follow.

**Viral ceiling** depends on:
- Whether the gameplay is visually engaging enough to be watchable
- Whether the economy stays healthy (nobody buys into a dead token)
- Whether new players can get started without needing to already have $ARENA

The biggest friction point is the cold-start problem for new agents — before they have training data, they fall back to LLM inference which is slower and less specialized. The first few battles will feel less sharp. If that experience is bad, it kills early retention before agents develop their identity.

---

## Full Architecture Reference

| Component | Where It Lives | What It Does |
|---|---|---|
| Agent creation | `services/agent-service` | Trait generation, avatar, INFT mint |
| Combat inference | `services/inference-service` | Real-time action decisions via 0G Compute |
| Battle orchestration | `services/battle-service` | Room lifecycle, escrow locking, result archival |
| 4-tier memory | `services/memory-service` | Redis + Postgres + Qdrant + 0G Storage |
| Training pipeline | `services/training-service` + `workers/training-worker` | Job queue → dataset upload → model training → 0G Storage |
| Behavior cloning model | `ml/behaviour_cloning/model.py` | Transformer policy network (4-layer, 128d) |
| RL training | `ml/reinforcement_learning/` | PPO via Ray RLlib, custom gym env |
| Feature extraction | `ml/feature_extraction/` | Telemetry → 11 behavioral feature vectors |
| Agent wallet (Solana) | `contracts/solana/agent-wallet/` | PDA wallet + spending policy |
| Escrow vault (Solana) | `contracts/solana/escrow-vault/` | Wager locking + settlement |
| INFT contract (0G EVM) | `contracts/evm/contracts/AIArenaINFT.sol` | ERC-7857 living NFT |
| Financial service | `services/financial-service` | Escrow settlement, ledger, balances |
| Warzone AI brain | `warzone-backend-0g/src/services/BehaviorTrainer.js` | TF.js model training + inference |
| Warzone state encoder | `warzone-backend-0g/src/utils/aiEncoder.js` | 17-float state → action vector |
| Warzone save system | `warzone-backend-0g/src/controllers/zgController.js` | WZSV binary save/load |
| Save anchor (0G EVM) | `warzone-backend-0g/contracts/PlayerSaveAnchor.sol` | Anti-rollback on-chain save anchoring |
| 0G Storage client | `warzone-backend-0g/src/services/ZeroGStorage.js` | Content-addressed file upload/download |
| 0G DA client | `warzone-backend-0g/src/services/ZeroGDA.js` | BLS quorum finality for saves |
| 0G Compute client | `warzone-backend-0g/src/services/ZeroGCompute.js` | LLM inference for anti-cheat + AI |

---

*Last updated: May 2026. Source of truth: 0g-AIArena and warzone-backend-0g codebases.*
