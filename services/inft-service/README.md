# inft-service

**Port: 8032**

Manages ERC-7857 Living NFT (INFT) operations on **0G Chain mainnet** (Chain ID: 16661).

## What is ERC-7857?

ERC-7857 extends ERC-721 with AI-agent-specific capabilities:

| Feature | Description |
|---------|-------------|
| `transfer(from, to, tokenId, sealedKey, proof)` | Oracle TEE re-encrypts agent metadata for the new owner's public key before transfer |
| `clone(to, tokenId, sealedKey, proof)` | Spawn a child INFT (max 3 per parent) |
| `authorizeUsage(tokenId, executor, permissions)` | Grant inference rights to a backend service address |
| `revokeUsage(tokenId, executor)` | Revoke inference rights |
| `hasValidUsage(tokenId, executor)` | Check if executor has valid (non-expired) rights |

## On-Chain Storage References

All large data lives on **0G Storage**. The INFT stores only the content hashes:

| INFT field | Type | Points to |
|-----------|------|-----------|
| `encryptedMetadataHash` | string | Keccak256 of encrypted metadata blob on 0G Storage |
| `memoryRootHash` | bytes32 | 0G Storage Merkle root hash of agent memory snapshot |
| `modelRootHash` | string | 0G Storage root hash of LoRA adapter weights |

These are updated by:
- `updateMemoryRoot()` — called by memory-service after `compactMemory()`
- `updateModelRoot()` — called by training-service after `completeJob()`
- `recordBattleResult()` — called by battle-service after each battle

## 0G Chain Details

| Field | Value |
|-------|-------|
| Network | 0G Chain Mainnet |
| Chain ID | 16661 |
| RPC | `https://evmrpc.0g.ai` |
| Explorer | `https://chainscan.0g.ai` |
| Contract | Set via `ZEROG_INFT_CONTRACT_ADDRESS` |

## API Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | — | Health + contract address |
| `GET` | `/inft/:tokenId` | JWT | Token metadata, traits, evolution stage, rootHashes |
| `POST` | `/inft/mint` | JWT | Mint INFT — requires metadata/memory/model rootHashes |
| `POST` | `/inft/:tokenId/authorize` | JWT | Grant inference usage rights |
| `DELETE` | `/inft/:tokenId/authorize/:executor` | JWT | Revoke inference rights |
| `GET` | `/inft/:tokenId/usage/:executor` | JWT | Check usage validity |
| `POST` | `/inft/:tokenId/update-memory` | JWT | Anchor new memoryRootHash on-chain |
| `POST` | `/inft/:tokenId/update-model` | JWT | Anchor new modelRootHash on-chain |
| `POST` | `/inft/:tokenId/evolve` | JWT | Evolve to next stage (1=Genesis → 5=Legend) |
| `POST` | `/inft/:tokenId/battle-result` | JWT | Record battle win/loss + ELO change |

## Mint Request

```json
{
  "to": "0x_owner_wallet_address",
  "traits": {
    "aggression": 70, "intelligence": 65, "adaptability": 55,
    "resilience": 60, "creativity": 80, "loyalty": 50, "deception": 45, "patience": 40
  },
  "encryptedMetadataHash": "0xabc...",
  "memoryRootHash": "0x0000...initial",
  "modelRootHash": "0xdef...",
  "initialSealedKey": "0x..."
}
```

## Mint Response

```json
{
  "txHash": "0x...",
  "tokenId": "42",
  "owner": "0x..."
}
```

## NATS Events Consumed

| Subject | Action |
|---------|--------|
| `agent.created` | Mint new INFT with metadata/memory rootHashes |
| `battle.ended` | `recordBattleResult()` + `updateMemoryRoot()` |
| `training.completed` | `updateModelRoot()` with new LoRA rootHash |

## Environment Variables

```bash
ZEROG_NETWORK=mainnet
ZEROG_EVM_RPC=https://evmrpc.0g.ai
ZEROG_INFT_CONTRACT_ADDRESS=0x...
ZEROG_INFT_ORACLE_ADDRESS=0x...
ZEROG_STORAGE_PRIVATE_KEY=0x...   # used as admin signer
JWT_SECRET=...
PORT=8032
```
