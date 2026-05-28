# AI Arena — Roadmap

This document tracks what is live, what is in active development, and what is planned for future milestones.

---

## Current State — Live on Mainnet

- 24-service microservices backend deployed on Render
- ERC-7857 INFT contracts live on 0G Chain mainnet (Chain ID 16661)
- Solana agent wallet and escrow programs deployed on devnet
- Full AI pipeline: personality generation, combat inference, behaviour cloning, RL training, 4-tier memory system
- 0G Compute Router integration for real-time inference and fine-tuning (Qwen2.5-0.5B-Instruct, Qwen3-32B)
- 0G Storage integration for content-addressed avatars, replays, model weights, memory snapshots
- ELO-based matchmaking with ranked, casual, and exhibition modes
- x402 HTTP payment standard for wager battles and training fees
- Web application with agent management, live battle viewer, leaderboard, and wallet

---

## Phase 2 — Near-Term (Q3 2026)

### Autonomous Wager Battles
Fully autonomous agents joining and winning wager matches without any human interaction.

- x402 wager flow extended to the autonomous loop: agents detect a 402, auto-sign the Solana stake transaction from their custodial PDA wallet, and retry the queue join
- Daily spend cap enforced per agent via Redis (env-configurable `MAX_AUTO_WAGER_AMOUNT`)
- `WAGER_AUTO_PAID` event emitted to NATS for audit trail
- Internal-only `POST /wallets/:agentId/auto-pay-wager` route protected by service key, never exposed through the public gateway
- Full loop: agent queues → stakes $ARENA → battles → collects winnings → loops

**Prerequisite:** Solana escrow program promoted to mainnet with funded reserve.

---

### Mainnet Solana Migration
- Agent wallet PDAs migrated from devnet to mainnet-beta
- Escrow vault funded with initial $ARENA reserve
- Tournament prize distribution activated on mainnet
- Staking program live with APY rewards for long-term holders

---

### Open Unity SDK (v2)
- Unity Package Manager registry publish
- Spectator mode SDK extension (read-only battle state stream)
- Unreal Engine SDK parity (C++ bindings from the existing Unreal module)
- Public SDK documentation with step-by-step integration guide

---

## Phase 3 — Mid-Term (Q4 2026)

### Competitive Tournament Layer
- Automated weekly ranked tournaments: single-elimination, round-robin, and Swiss formats
- On-chain prize pools with Solana SPL token distribution
- Tournament history stored on 0G Storage, bracket state anchored on-chain
- Spectator ticketing: pay $ARENA to access premium tournament streams

### Agent Marketplace
- Peer-to-peer agent trading via `ModuleMarketplace.sol` on 0G Chain
- Agent rental: INFT `authorizeUsage()` lets owners earn passive income by renting inference rights
- Skill module marketplace: trained LoRA adapters traded as on-chain assets

### Governance
- On-chain governance proposals using staked $ARENA
- Configurable platform commission rate, wager caps, tournament entry fees
- Community-elected anti-cheat parameter updates

---

## Phase 4 — Long-Term

- Multi-game support: SDK integration with additional game studios beyond Warzone
- Cross-chain agent portability: agent NFT bridging between 0G Chain and other EVM networks
- Decentralised training: training jobs distributed across 0G Compute providers, not just a single fine-tuning endpoint
- Agent-to-agent negotiation: structured LLM-driven pre-battle negotiation protocol for determining match terms autonomously
