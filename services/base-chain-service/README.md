# base-chain-service

The only relayer/signer for KULT on **Base mainnet** (chainId 8453). Holds
`BASE_RELAYER_PRIVATE_KEY` and is the only thing in the system that submits Base
transactions — every other service asks it over HTTP with `X-Service-Key`, the
same trust boundary `inft-service` and `arena-chain-service` use.

Part of the A2A agent-commerce marketplace. See
[`docs/architecture/A2A_MARKETPLACE_BASE.md`](../../docs/architecture/A2A_MARKETPLACE_BASE.md).

> Unrelated to `services/okx-payment-proxy`, which serves OKX.AI on X Layer.
> Nothing here reads from or modifies it.

## Scope by phase

| Phase | Capability | Status |
|---|---|---|
| 1 | ERC-8004 agent identity on the canonical registries | **implemented** |
| 6 | `A2AJobEscrow` relaying + USDC settlement | not started |
| 8 | ERC-8004 reputation feedback on settlement | not started |

## Contracts (canonical — we deploy none of these)

| | Address |
|---|---|
| ERC-8004 IdentityRegistry | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` |
| ERC-8004 ReputationRegistry | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |

Verified live before every deploy:

```bash
pnpm --filter @ai-arena/contracts-evm exec hardhat run scripts/verify-base-contracts.ts --network base
```

## Two keys per agent, deliberately separated

- **`eoaAddress`** — the agent's own signing key. Signs every A2A protocol
  message and the EIP-712 job agreement; is the USDC payout destination. Holds
  no float and never pays gas. Encrypted at rest with AES-256-GCM + scrypt.
- **`ownerWallet`** — the human's Privy embedded EVM wallet. The address already
  used for 0G login works on Base unchanged. Escrow funding is pulled from here,
  bounded by a Base Account Spend Permission (Phase 6).

Neither ever needs ETH: agents authorize by signature, this service relays and
pays gas.

## Identity ownership — a named centralization point

`register()` makes `msg.sender` the owner, so the **relayer** owns agent NFTs.
The alternative — the agent's EOA or the user's wallet owning it — would require
that party to hold ETH on Base to ever update its own URI.

The agent's operational key is still independently provable by anyone: it is
bound on-chain via `setAgentWallet()` and readable with `getAgentWallet()`.

The exit is `POST /identity/agents/:id/transfer-to-owner`, a relayer-paid
ERC-721 transfer. The `agentWallet` binding survives the transfer.

## Endpoints

Reads are open; writes require `X-Service-Key: $INTERNAL_SERVICE_SECRET`.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/health` | Includes relayer address, ETH balance, `lowBalance` flag |
| `GET` | `/identity/agents/:id/registration.json` | **The ERC-8004 tokenURI target — must stay public** |
| `GET` | `/identity/agents/:id` | Local record + BaseScan links |
| `GET` | `/identity/agents/:id/verify` | Reads Base directly, ignores our DB for the answer |
| `POST` | `/identity/agents/:id/register` | Idempotent and resumable |
| `POST` | `/identity/agents/:id/transfer-to-owner` | Hand NFT custody to the human |
| `POST` | `/identity/agents/:id/sign` | Sign a payload as this agent |

Public via the gateway at `/v1/a2a/*`.

## Registration flow

Three steps, each persisted before the next begins. `ensureIdentity` resumes
from whatever `status` it finds, so retrying is the intended recovery path and a
crash mid-flow can never mint a duplicate identity.

```
PENDING ──▶ publish card to 0G Storage ──▶ register() ──▶ setAgentWallet() ──▶ WALLET_LINKED
             (agentURI + cardRootHash)      REGISTERED
```

The registration file served at `agentURI` is fetched back **from 0G Storage**
rather than regenerated, so the served bytes always match the committed Merkle
root even after the agent's stats change. The root is echoed in the
`X-0G-Storage-Root-Hash` response header so a verifier can check the blob
without trusting this API.

## Configuration

| Env | Required | Notes |
|---|---|---|
| `BASE_RELAYER_PRIVATE_KEY` | yes | Gas-payer. **Must not** reuse `EVM_DEPLOYER_PRIVATE_KEY` — that key is in this repo's public git history |
| `AGENT_WALLET_ENCRYPTION_KEY` | yes | ≥32 chars, 64 hex recommended. Rotating without re-encrypting orphans every agent key — no recovery path |
| `A2A_PUBLIC_BASE_URL` | yes in prod | Becomes the ERC-8004 tokenURI, so it must be publicly resolvable |
| `BASE_RPC_URL` | no | Defaults to `https://mainnet.base.org` |
| `INTERNAL_SERVICE_SECRET` | yes | Guards all writes |
| `ZEROG_STORAGE_PRIVATE_KEY` | yes | Publishes agent cards |

Generate the encryption key with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Tests

```bash
pnpm --filter @ai-arena/base-chain-service test
```

19 tests, no network or database required. The ones that matter most:

- **`eip712.test.ts`** reimplements the contract's `AgentWalletSet` digest from
  `IdentityRegistryUpgradeable.sol` and asserts our typed-data definition
  produces the identical hash. A wrong domain name recovers to a different
  address, and `setAgentWallet` would revert only *after* `register()` gas was
  already spent. It also pins that the EIP-712 domain name
  (`ERC8004IdentityRegistry`) is not the ERC-721 name (`AgentIdentity`).
- **`crypto.test.ts`** covers tamper detection — a flipped ciphertext or auth
  tag must throw, not decrypt to plausible bytes.
- **`agent-card.test.ts`** pins byte-stable serialization, since the card's hash
  is committed on-chain.
