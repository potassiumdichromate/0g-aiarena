# @ai-arena/solana-client

Solana and Anchor client library for AI Arena on-chain programs.

## Programs

- `AgentWalletClient` — Manage agent wallet PDAs (create, freeze, transfer)
- `EscrowClient` — Battle escrow lifecycle (create, fund, lock, settle, cancel)
- `TokenClient` — $ARENA SPL token balance queries

## Setup

Set environment variables:
```
SOLANA_RPC_URL=https://api.devnet.solana.com
SOLANA_PRIVATE_KEY=<base58-encoded-private-key>
AGENT_WALLET_PROGRAM_ID=<deployed-program-id>
ESCROW_VAULT_PROGRAM_ID=<deployed-program-id>
ARENA_TOKEN_MINT=<token-mint-address>
```

## Usage

```typescript
import { AgentWalletClient, EscrowClient } from '@ai-arena/solana-client';

const walletClient = new AgentWalletClient();
const { address, bump } = await walletClient.createAgentWallet('agent-uuid');

const escrowClient = new EscrowClient();
const escrow = await escrowClient.createEscrowPDA({
  battleId: 'battle-uuid',
  agentIds: ['agent-1', 'agent-2'],
  amounts: { 'agent-1': 100, 'agent-2': 100 },
});
```
