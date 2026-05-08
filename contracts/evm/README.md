# EVM Contracts

Solidity contracts deployed on the 0G Chain (EVM-compatible).

## Contracts

- `AIArenaINFT.sol` — ERC-721 INFT with on-chain trait registry, evolution, memory root anchoring
- `AgentRegistry.sol` — Maps agent IDs to INFT tokens and ELO ratings
- `ModuleMarketplace.sol` — Buy/sell AI agent skill modules

## Deploy

```bash
pnpm install
npx hardhat compile
npx hardhat run scripts/deploy.ts --network zerog-testnet
```

## Test

```bash
npx hardhat test
```
