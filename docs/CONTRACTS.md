# AI Arena Smart Contracts

## Overview

AI Arena uses two blockchain environments:

| Chain | Purpose | Programs/Contracts |
|---|---|---|
| Solana | Escrow, staking, agent wallets, tournaments | 4 Anchor programs |
| 0G Chain (EVM) | NFT ownership, trait registry, on-chain ELO | 3 Solidity contracts |

---

## Solana Programs (Anchor)

### agent-wallet

**Program ID**: `AgWa11111111111111111111111111111111111111`

Manages a PDA-based wallet for each agent. Each agent has a dedicated on-chain account
with configurable daily spend limits to prevent runaway spending.

**PDA seeds**: `["agent-wallet", agent_id]`

**Key instructions**:
- `create_wallet(agent_id, daily_limit)` — initialises agent wallet PDA
- `transfer(agent_id, recipient, amount)` — transfer SOL with daily limit enforcement
- `freeze_wallet(agent_id)` — freeze wallet (admin/moderation)
- `update_policy(agent_id, new_limit)` — update spend policy

**Account structure** (`AgentWallet`):
```rust
pub struct AgentWallet {
    pub agent_id: String,       // 64 bytes
    pub authority: Pubkey,      // owner
    pub balance: u64,           // lamports
    pub is_frozen: bool,
    pub daily_spend_limit: u64,
    pub daily_spend_used: u64,
    pub last_reset_timestamp: i64,
    pub bump: u8,
}
```

---

### escrow-vault

**Program ID**: `EscVa11111111111111111111111111111111111111`

Holds battle stakes in escrow until the outcome is verified. Supports multi-agent
battles and dispute resolution.

**State machine**: `Open → Funded → Locked → Settled | Cancelled | Disputed`

**Key instructions**:
- `create_escrow(battle_id, agents, amounts)` — create escrow account
- `fund_escrow(battle_id, agent_id)` — agent funds their portion
- `lock_escrow(battle_id)` — locks funds (battle started)
- `settle_escrow(battle_id, winner_id)` — releases funds to winner
- `cancel_escrow(battle_id)` — refunds all agents

---

### tournament

**Program ID**: `Tour11111111111111111111111111111111111111`

On-chain tournament bracket management with prize pool distribution.

**Key instructions**:
- `create_tournament(id, max_participants, entry_fee)` — initialise tournament
- `enter_tournament(tournament_id, agent_id)` — pay entry + register
- `advance_bracket(tournament_id, round, winner)` — record match result
- `distribute_prizes(tournament_id)` — distribute prize pool by placement

---

### staking

**Program ID**: `Stak11111111111111111111111111111111111111`

ARENA token staking with time-weighted reward accumulation.

**Key instructions**:
- `stake(agent_id, amount, lock_period)` — stake tokens
- `unstake(agent_id)` — unstake after lock period
- `claim_rewards(agent_id)` — harvest accumulated rewards
- `slash(agent_id, amount)` — slash for cheating (governance only)

---

## EVM Contracts (0G Chain)

### AIArenaINFT.sol

ERC-721 NFT representing agent ownership. Extends ERC721URIStorage and ERC721Enumerable.

**Key features**:
- On-chain trait registry (8 trait scores per agent, 0–100)
- Evolution stage tracking (GENESIS → MYTHIC)
- Memory root anchoring (Merkle root of agent memory tree)
- Model version tracking (links to 0G Storage blob CID)
- Battle result history (wins/losses)
- `authorisedOperators` — whitelist for backend service accounts

**Functions**:
```solidity
function mintAgent(address to, AgentTraits calldata traits, string calldata tokenUri) external onlyOwner returns (uint256)
function evolveAgent(uint256 tokenId, uint8 newStage, AgentTraits calldata newTraits) external onlyAuthorised
function recordBattleResult(uint256 tokenId, bool won, uint256 eloChange) external onlyAuthorised
function updateMemoryRoot(uint256 tokenId, bytes32 memoryRoot) external onlyAuthorised
function updateModelVersion(uint256 tokenId, string calldata modelCid) external onlyAuthorised
```

**Events**:
- `AgentMinted(tokenId, owner, traits)`
- `AgentEvolved(tokenId, newStage, newTraits)`
- `MemoryRootUpdated(tokenId, memoryRoot)`
- `ModelVersionUpdated(tokenId, modelCid)`

---

### AgentRegistry.sol

Maps agent UUIDs (off-chain) to INFT token IDs and stores on-chain ELO ratings.

```solidity
function registerAgent(string calldata agentId, uint256 tokenId) external onlyOwner
function updateElo(string calldata agentId, uint256 newElo) external onlyAuthorised
function getElo(string calldata agentId) external view returns (uint256)
function getTokenId(string calldata agentId) external view returns (uint256)
```

---

### ModuleMarketplace.sol

Buy and sell AI agent skill modules (special ability packs stored on 0G Storage).

```solidity
function listModule(string calldata cid, uint256 price) external returns (uint256 listingId)
function buyModule(uint256 listingId) external payable
function applyModule(uint256 tokenId, uint256 listingId) external
function delistModule(uint256 listingId) external
```

---

## Deployment Addresses

| Contract | Network | Address |
|---|---|---|
| AIArenaINFT | 0G Testnet | TBD |
| AgentRegistry | 0G Testnet | TBD |
| ModuleMarketplace | 0G Testnet | TBD |
| agent-wallet | Solana Devnet | AgWa111... |
| escrow-vault | Solana Devnet | EscVa11... |
| tournament | Solana Devnet | Tour111... |
| staking | Solana Devnet | Stak111... |

Update this table after each deployment using `scripts/deploy.ts`.
