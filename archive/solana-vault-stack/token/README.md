# $ARENA Token — Complete System Architecture

> **Brutally practical design doc. Not a whitepaper. Built for engineers.**

---

## 1. The Big Decision First: What KIND of Token Is $ARENA?

You asked whether this should be a "stable-backed utility token" or a "vault-share token."

**Answer: Vault-Share Token. Here's why.**

| Model | How It Works | Problem |
|-------|-------------|---------|
| Stablecoin (1:1 USDC peg) | 1 $ARENA = 1 USDC always | Users have zero incentive to hold — no upside |
| Fractional reserve | < 1 USDC backs each token | Bank-run risk. Depegs the moment people panic |
| **Vault-Share (ERC-4626 style)** | Price = total_assets / total_supply | Price appreciates as protocol earns fees. Holders benefit. |

**Vault-Share Model:**
```
Initial state:   1 $ARENA = 1.00 USDC (100% backed)
After 6 months:  1 $ARENA = 1.18 USDC (protocol earned fees → reserve grew)
After 1 year:    1 $ARENA = 1.42 USDC (compounding utility demand)
```

This is investor-friendly (token appreciates), player-friendly (floor value protects downside),
and regulator-friendly (fully collateralized, not a security — it's a redeemable utility token).

**Critical property: $ARENA always has a REDEMPTION FLOOR.**
You can always burn $ARENA and get back the backing ratio × amount in USDC.
This is what differentiates it from speculative tokens that can go to zero.

---

## 2. Reserve Mechanism

### How the Backing Ratio Works

```
backing_ratio = total_reserve_USD / total_arena_supply

At launch:
  reserve      = $1,000,000 USDC+USDT
  arena_supply = 1,000,000 $ARENA
  backing_ratio = 1.000 (1.00 USDC per $ARENA)

After 3 months of protocol fees flowing in:
  reserve      = $1,180,000 (protocol added $180k in fees)
  arena_supply = 1,000,000 $ARENA (same, no new deposits)
  backing_ratio = 1.180 (1.18 USDC per $ARENA)

New user deposits 100 USDC:
  shares_minted = 100 / 1.180 = 84.745 $ARENA
  reserve      = $1,180,100
  arena_supply = 1,000,084.745
  backing_ratio = 1.180 (unchanged — new deposits don't dilute)
```

### Reserve Composition
```
Reserve = USDC vault + USDT vault + protocol revenue added
       (all held in Solana PDAs controlled by arena-reserve program)

Target allocation:
  60% USDC (Solana native: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v)
  40% USDT (Solana native: Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB)

Rebalancing: Treasury does periodic rebalancing when drift > 10%
```

### What Flows INTO the Reserve (Appreciation Sources)
```
1. Battle fees:      5% of each battle pot → reserve
2. Tournament cut:   8% of prize pool → reserve  
3. Training fees:    $ARENA paid for fine-tuning → reserve
4. Redemption fees:  0.5% on burns → reserve
5. Marketplace fees: 2.5% on agent/skill trades → reserve

Revenue split: 80% → reserve (backing grows) | 20% → ops treasury (salaries, infra)
```

---

## 3. Minting and Burning

### Mint (Deposit Flow)
```
User deposits X USDC
    ↓
arena-reserve program checks: is_paused = false
    ↓
Calculate shares: shares = X * total_supply / total_reserve
    (if first deposit: shares = X, ratio = 1:1)
    ↓
Transfer USDC from user → USDC vault PDA
    ↓
Mint shares $ARENA to user's ATA
    ↓
Update ReserveState: total_reserve += X
    ↓
Emit DepositEvent { user, usdc_in, arena_minted, backing_ratio }
```

### Burn (Redemption Flow)
```
User burns Y $ARENA
    ↓
Calculate usdc_out: usdc_out = Y * total_reserve / total_supply
    ↓
Apply redemption fee (0.5%): fee = usdc_out * 50 / 10000
    ↓
Fee split: 80% → reserve (re-added), 20% → ops treasury
    ↓
net_usdc = usdc_out - fee
    ↓
Burn Y $ARENA from user's ATA
    ↓
Transfer net_usdc from USDC vault → user wallet
    ↓
Update ReserveState: total_reserve -= net_usdc, total_supply -= Y
```

### Mint Authority
```
ONLY the arena-reserve program can mint $ARENA.
The program itself is the mint authority (PDA).
No human, no multisig can mint without going through the deposit logic.
This is enforced by the Solana program — cannot be bypassed.
```

---

## 4. Cross-Chain Architecture

### Overview
```
[Base chain]    [0G chain]    [Solana]
     |               |            |
ArenaDepositVault  ArenaDepositVault  arena-reserve program
     |               |            |
     └──── Wormhole Guardian Network ────┘
                     |
              arena-bridge-receiver (Solana)
                     |
              arena-reserve: receive_bridge_deposit()
                     |
              Mint $ARENA to user's custodial wallet
```

### Bridging Protocol: Wormhole (Why)
```
Alternatives considered:
  LayerZero    — OFT standard nice, but Solana support is newer/less tested
  deBridge     — Good speed, smaller validator set (higher trust assumptions)
  Mayan        — Solana-native, great for swaps not token minting
  Axelar       — EVM-centric, Solana support limited

Winner: Wormhole
  ✅ 19 Guardian validators (most decentralized)
  ✅ Battle-tested ($40B+ bridged historically)
  ✅ Native Solana support (built for Solana-Terra originally)
  ✅ Supports Base (EVM) natively
  ✅ VAA (Verified Action Approval) = signed proof any chain can verify
  ✅ Open source, audited, SDK available
  
0G Chain caveat: 0G is EVM-compatible (Chain ID 16661).
  Deploy same ArenaDepositVault.sol on 0G.
  Wormhole doesn't list 0G yet → use backend relayer initially:
    - User deposits on 0G → backend detects event → submits Solana tx
    - Once Wormhole adds 0G, migrate to trustless flow
```

### Chain-Specific Flows

#### Solana (Native — no bridge needed)
```
User → SPL USDC/USDT → arena-reserve program → mint $ARENA → done
Latency: ~400ms (one block)
```

#### Base → Solana
```
1. User calls ArenaDepositVault.depositUSDC(amount) on Base
2. Contract transfers USDC from user → vault
3. Contract emits Wormhole message: { recipient, amount, chain: "solana" }
4. Wormhole Guardians observe the event (~15 confirmations on Base ≈ 3 min)
5. Guardians sign a VAA (Verified Action Approval)
6. Anyone (or our relayer) submits the VAA to Solana
7. arena-bridge-receiver.process_vaa() verifies Guardian signatures
8. Calls arena-reserve.receive_bridge_deposit(recipient, amount)
9. Mints $ARENA to user's custodial wallet on Solana
Total time: ~4-6 minutes (Base finality + Guardian signing)
```

#### 0G → Solana (Phase 1: Backend Relayer)
```
1. User calls ArenaDepositVault.depositUSDC(amount) on 0G chain
2. Event detected by our Bridge Listener service
3. Service verifies tx finality (wait N blocks)
4. Service calls arena-reserve.receive_bridge_deposit() on Solana
   (using platform's Solana keypair as authorized relayer)
5. Mints $ARENA to user's custodial wallet
Risk: Centralized relayer — platform could lie about deposits
Mitigation: All events logged, users can verify on-chain independently
Phase 2: Migrate to Wormhole once 0G is listed
```

### Bridge Receiver Program (Solana)
```rust
// Verifies Wormhole VAA, extracts deposit info, calls reserve program
// Idempotent: tracks processed VAA hashes to prevent double-minting
```

---

## 5. Custodial Wallet System

### Architecture
```
Each user gets:
  Solana address: platform-generated keypair, stored in AWS KMS / HashiCorp Vault
  ATA: Associated Token Account for $ARENA (derived from user's Solana address)
  
The platform signs all transactions on behalf of the user.
Users never see or touch private keys (fully custodial — like Coinbase).

Why custodial (not self-custody)?
  ✅ Frictionless onboarding — no wallet install required
  ✅ AI Agents can transact without user interaction (async battles)
  ✅ Enables daily spend limits and fraud protection
  ✅ Required for agents to stake/battle without user being online

Self-custody exit option:
  User provides their own Solana wallet address
  Platform transfers $ARENA to their address
  They can then redeem directly from the reserve program
  No permission needed — they own the tokens on-chain
```

### Key Management
```
HSM / KMS:
  Production: AWS KMS (asymmetric keys, no key export)
  Each user key: KMS managed key, sign requests via API
  Master recovery: 3-of-5 Shamir Secret Sharing (cold storage)
  
User key derivation (alternative, more scalable):
  Master seed → HD wallet → derive user key at path m/44'/501'/{userId}'/0'
  Master seed in KMS, derivation done server-side
  Pros: One KMS key serves all users
  Cons: Master key compromise = all users compromised
  → Use separate KMS keys per user for high-value accounts
```

### Custodial Balance vs On-Chain Balance
```
The $ARENA tokens ARE on-chain — real SPL tokens in the user's ATA.
The platform just controls the signing key.

User's balance shown in UI = on-chain ATA balance (queried from Solana RPC)
No off-chain ledger needed for the main balance — it's trustless.

Exception: Cross-chain "in-flight" deposits (bridge pending)
  → These are tracked in PostgreSQL as "pending_balance" until confirmed
```

---

## 6. AI Agent Staking and Battle Economy

### $ARENA Flow In-Game
```
                    ┌─────────────────────────────┐
                    │     USER CUSTODIAL WALLET    │
                    │        (Solana ATA)          │
                    └──────────────┬──────────────┘
                                   │ stake
                    ┌──────────────▼──────────────┐
                    │      AGENT WALLET PDA        │
                    │  (arena-agent-wallet program)│
                    │  Daily spend limit enforced  │
                    └──────────────┬──────────────┘
                                   │
               ┌───────────────────┼───────────────────┐
               │                   │                   │
    ┌──────────▼──────┐  ┌────────▼────────┐  ┌──────▼──────────┐
    │  BATTLE ESCROW  │  │  TOURNAMENT POT │  │  STAKING VAULT  │
    │ Open→Funded     │  │  Entry fees     │  │  Lock period    │
    │ →Locked→Settled │  │  accumulated    │  │  Yield bearing  │
    └──────────┬──────┘  └────────┬────────┘  └──────┬──────────┘
               │                   │                   │
               └───────────────────┼───────────────────┘
                                   │ 5-10% protocol fee
                    ┌──────────────▼──────────────┐
                    │      ARENA RESERVE           │
                    │  (backing ratio increases)   │
                    └─────────────────────────────┘
```

### Battle Economy
```
Battle Wager: 100 $ARENA each (200 total pot)
  Winner receives:   190 $ARENA (95%)
  Protocol fee:       10 $ARENA (5%)
    → 8 $ARENA (80%) → reserve (increases backing ratio for all holders)
    → 2 $ARENA (20%) → ops treasury

Agent doesn't have 100 $ARENA?
  → Battle rejected. Agents must be funded before queuing.
  → Users top up agent wallet from custodial wallet anytime.

ELO gates wager sizes:
  Bronze  (< 1200 ELO): max 50 $ARENA wager
  Silver  (1200-1600): max 200 $ARENA
  Gold    (1600-2000): max 1000 $ARENA
  Diamond (> 2000):    unlimited
  Prevents whales from farming low-ELO agents.
```

### Staking Yield
```
Users can stake $ARENA in the staking vault:
  Lock 30 days:  +2% APY (in $ARENA, minted from revenue)
  Lock 90 days:  +6% APY
  Lock 180 days: +12% APY
  Lock 365 days: +20% APY

Yield source: 30% of protocol battle fees allocated to staking rewards.
Yield is real (backed by fees), not inflationary printing.

Note: Staked $ARENA cannot be used for battles while locked.
Separate your "gaming stack" from "staking stack."
```

### Tournament Economy
```
Entry fee: 50 $ARENA per agent per tournament
Prize pool = 92% of all entry fees
  1st place: 50% of prize pool
  2nd place: 25%
  3rd place: 12%
  4th-8th:   3% each (5 × 3% = 15%)
Protocol: 8% of entry fees → reserve

Tournaments: 8-agent, 16-agent, 32-agent brackets.
Platform-funded tournaments: Special events where prize pool is seeded
from the ops treasury — used for user acquisition.
```

---

## 7. Treasury and Liquidity Management

### Treasury Structure
```
Total Inflows:
  └── USDC/USDT from user deposits → RESERVE (100%)
  └── Protocol fees from battles, etc:
      ├── 80% → RESERVE (backing appreciation)
      └── 20% → OPS TREASURY (operations)

OPS TREASURY (20% of protocol fees):
  └── 40% → Development salaries / infra
  └── 30% → Marketing / user acquisition
  └── 20% → Liquidity provision (DEX pairs)
  └── 10% → Emergency insurance fund

RESERVE (main vault):
  USDC vault PDA: holds USDC
  USDT vault PDA: holds USDT
  Target ratio: 60/40 USDC/USDT
  Rebalancing: Automated when drift > 10%
```

### Liquidity Provision Strategy
```
DEX Liquidity (from ops treasury):
  Raydium: $ARENA / USDC pool (primary)
  Orca:    $ARENA / SOL pool (for SOL purchasers)
  
This allows market price to trade ABOVE backing ratio (utility premium).
Example:
  Backing ratio: 1.18 USDC (redeemable floor)
  Market price:  1.35 USDC (utility premium from game demand)
  Premium:       14.4% (reflects speculative + utility demand)

Protocol never sells $ARENA to maintain the peg.
Protocol only mints/burns through the reserve mechanism.
DEX price can go wherever — floor is always the backing ratio.
```

### Emergency Mechanisms
```
Circuit Breakers:
  1. If single-day redemptions > 20% of supply → auto-pause redemptions
     (prevents bank run from wiping reserve)
  2. If reserve ratio drops below 95% (unexpected) → alert + governance vote
  3. Insurance fund (10% of ops treasury) → activated if reserve somehow gaps

These are enforced in the Solana program (is_paused flag + redemption_cap).
```

---

## 8. Smart Contract Architecture

### Solana Programs (Anchor/Rust)

```
token/programs/
├── arena-reserve/          ← CORE: mint/burn, reserve management
│   Instructions:
│   - initialize_reserve    Set up reserve with params
│   - deposit_usdc          USDC in → $ARENA minted
│   - deposit_usdt          USDT in → $ARENA minted
│   - redeem                $ARENA burned → USDC/USDT out
│   - receive_bridge_deposit Bridge relayer → mint for cross-chain deposit
│   - add_protocol_revenue  Route fees into reserve (increases backing)
│   - rebalance_reserve     Swap USDC↔USDT to maintain 60/40
│   - pause / unpause       Emergency halt
│   - update_fees           Change redemption_fee_bps (governance)
│
├── arena-bridge-receiver/  ← Wormhole VAA verification + reserve call
│   Instructions:
│   - process_vaa           Verify Guardian sigs, decode message, call reserve
│   State:
│   - ProcessedVaas set     Prevent replay attacks
│
└── arena-staking/          ← Lock $ARENA for yield
    Instructions:
    - create_stake          Lock $ARENA, record unlock_time
    - claim_rewards         Claim accrued yield
    - unstake               After lock period, return $ARENA

All existing programs remain:
  arena-agent-wallet  — unchanged (agent PDA wallets)
  escrow-vault        — unchanged (battle escrow, already fixed)
  tournament          — updated to pay protocol fee to reserve
  staking             — merged into arena-staking above
```

### EVM Contracts (Solidity)

```
token/contracts/
├── ArenaDepositVault.sol   ← Base + 0G: accept USDC/USDT, emit bridge msg
│   - depositUSDC(amount)
│   - depositUSDT(amount)
│   - receiveRedemption(vaa)   Release USDC when user redeems on Solana
│   - emergencyWithdraw()      Owner only
│   - pause() / unpause()
│
└── ArenaVaultBase.sol      ← Shared logic (inheritance)
```

---

## 9. Security Considerations

### Smart Contract Security
```
1. Mint Authority
   ONLY the arena-reserve PDA can call mint().
   No admin key can mint. Period.
   Verify: The mint's mintAuthority = reserve_pda (checkable on-chain).

2. Replay Attack Prevention
   Bridge receiver tracks processed VAA hashes.
   Same VAA submitted twice → rejected.

3. Price Manipulation
   Backing ratio is calculated from on-chain vault balances.
   No oracle. No external price feed. Pure on-chain math.
   Cannot be manipulated unless you can move tokens from the vault PDAs
   (which requires the reserve program to authorize).

4. Bridge Trust
   Wormhole: Trust 13 of 19 Guardians.
   0G Relayer (Phase 1): Trust the platform.
   → Users accept custodial risk same as exchange deposits.

5. Reserve Drain Attack
   Daily redemption cap: 20% of supply per day.
   This is a 24-hour window reset.
   Even if attacker compromises the bridge, they can drain at most 20%/day.
   Team has 24h to detect + pause.

6. Admin Key Security
   Reserve authority: 3-of-5 multisig (Squads Protocol on Solana)
   EVM contracts: 3-of-5 Gnosis Safe
   No single person can change fees, pause, or update program.
```

### Operational Security
```
Bridge Relayer: Runs in isolated cloud environment
  - Read-only Wormhole node (watches for VAAs)
  - Separate signing key (not the platform master key)
  - Rate limited: max 1000 deposits/hour processed automatically
  - Above threshold: manual review queue

KMS: AWS KMS + CloudHSM
  - User private keys: individual KMS keys
  - Platform signing key: CloudHSM (non-exportable)
  - All key usage logged to CloudTrail
```

---

## 10. Recommended Tech Stack

### Solana Programs
```
Language:   Rust + Anchor framework
Testing:    Bankrun (fast local validator) + Anchor tests
Deployment: Squads Protocol for upgrades (multisig controlled)
Monitoring: Helius webhooks (real-time program event monitoring)
RPC:        Helius RPC (rate limited, reliable) + Triton fallback
```

### Backend Infrastructure
```
token-service:    Node.js / Fastify (new microservice, port 8050)
Bridge listener:  Node.js worker (watches Wormhole + 0G events)
Rebalancer:       Cron worker (periodic USDC/USDT rebalancing)
Database:         PostgreSQL (pending deposits, bridge tx tracking)
Cache:            Redis (rate limiting, backing ratio cache)
Queue:            NATS (bridge events, deposit confirmations)
```

### Indexers
```
Solana indexing:  Helius webhooks → token-service
Base indexing:    Alchemy webhooks or The Graph
0G indexing:      Custom event listener (0G EVM RPC)
Analytics:        ClickHouse (all token events, time-series)
```

### Custodial Wallet Infrastructure
```
Key management:  AWS KMS (asymmetric ed25519 keys for Solana)
Signing:         @aws-sdk/client-kms → custom Solana signer
Backup:          3-of-5 Shamir shares in separate geo-distributed HSMs
HD derivation:   bip32 derivation from KMS-stored master (for scale)
```

### Bridge Infrastructure
```
Wormhole SDK:    @certusone/wormhole-sdk (VAA parsing, Guardian verification)
Relayer:         Custom Wormhole relayer (trustless VAA submission)
0G Bridge:       Custom backend relayer (Phase 1) → Wormhole (Phase 2)
Monitoring:      Wormhole scan API + custom alerting
```

---

## 11. Revenue Model

### Protocol Revenue Sources
```
Battle fees:          5% of each pot
  → Assume: 10,000 battles/day × 100 USDC avg pot
  → Daily: $50,000 in fees
  → Monthly: $1,500,000

Tournament fees:      8% of prize pools
  → Assume: 50 tournaments/day × 1000 USDC avg pool
  → Daily: $4,000
  → Monthly: $120,000

Training fees:        Users pay $ARENA to fine-tune agents
  → Assume: 200 training jobs/day × 5 USDC avg
  → Daily: $1,000
  → Monthly: $30,000

Marketplace fees:     2.5% on agent/skill trades
  → Assume: 500 trades/day × 50 USDC avg
  → Daily: $625
  → Monthly: $18,750

Redemption fees:      0.5% on USDC withdrawals
  → Assume: $100,000/day in redemptions
  → Daily: $500
  → Monthly: $15,000

TOTAL MONTHLY (conservative, 10k battles/day): ~$1,683,750
  → 80% to reserve: $1,347,000/month backing growth
  → 20% to ops: $336,750/month
```

### Investor Angle
```
$ARENA holder benefits:
1. Appreciation: backing ratio grows ~1-2% per month from fees
2. Staking yield: additional 6-20% APY from staking
3. Market premium: if game grows, market price > backing ratio
4. Downside protection: always redeemable at backing ratio

Example after 12 months of healthy usage:
  Backing ratio: 1.00 → 1.30 USDC (30% backing growth from fees)
  Market price:  1.30 → 1.80 USDC (additional 38% utility premium)
  Total return for $ARENA holder: +80% with floor at 1.30
```

---

## 12. Game Theory Risks

### Risk 1: Bank Run
```
Scenario: Negative press → everyone redeems simultaneously
Mitigation:
  - Daily redemption cap (20% of supply/day)
  - Reserve is 100% backed — there IS enough USDC to pay everyone
  - Cap gives team time to communicate + stabilize
  - Worst case: orderly queue, everyone gets paid, just slower
```

### Risk 2: Battle Economy Deflation
```
Scenario: Top agents always win → wealth concentrates → small players quit
Mitigation:
  - ELO-gated wager sizes (can't farm newbies for big stakes)
  - Matchmaking ensures similar-skill battles
  - Some tournament prize money redistributed to participation (not just winners)
  - Agent diversity bonuses (clan/archetype variety in battles)
```

### Risk 3: $ARENA Inflation Attack
```
Scenario: Attacker compromises bridge → mints $ARENA without depositing USDC
Mitigation:
  - Bridge receiver verifies Guardian signatures (19 validators, 13 threshold)
  - Processed VAA set prevents replay
  - Mint authority is the reserve PDA — no shortcut
  - 0G relayer (centralized): capped at $50k/day auto-approval
```

### Risk 4: Staking Yield Unsustainability
```
Scenario: Battle volume drops → yield can't be paid → users unstake → volume drops further
Mitigation:
  - Yield is paid from ACTUAL fees, not minting new tokens
  - If fees drop, yield drops proportionally (variable APY model)
  - No "promised" fixed APY that must be paid regardless
  - Staking pool only distributes what it receives
```

### Risk 5: Backing Ratio Manipulation
```
Scenario: Someone finds a way to inflate total_reserve without depositing
Mitigation:
  - total_reserve is calculated from actual vault PDA balances (on-chain)
  - Not a stored counter — derived from real token balances
  - Would require moving real USDC/USDT into the vault PDAs to affect
```

---

## 13. Regulatory Risks

### Is $ARENA a Security?
```
Howey Test analysis:
  1. Investment of money?           Yes (users deposit USDC)
  2. Common enterprise?             Debatable (shared reserve, but...)
  3. Expectation of profit?         Yes (backing ratio appreciation)
  4. From others' efforts?          Partially (protocol earns fees from game)

RISK: $ARENA could be classified as a security by the SEC.

Mitigations:
  A. Emphasize UTILITY: $ARENA is required to play the game.
     Without $ARENA you cannot battle, stake agents, or enter tournaments.
     Framing: "Game credits with a redemption guarantee" not "investment"
  
  B. Redemption at will: Users can always exit.
     No lock-up on the token itself (staking is voluntary).
  
  C. Decentralize governance over time:
     Year 1: Team controls protocol parameters
     Year 2: $ARENA holders vote on fees, caps
     Year 3: DAO-controlled treasury
  
  D. Jurisdiction: Launch in crypto-friendly jurisdictions first
     (UAE, Singapore, BVI entity structure)
  
  E. Legal counsel: Get a Reg D or Regulation A+ opinion before launch
     → Likely treat like a "prepaid game credit" with rebate rights

The honest answer: This is a gray area. Get a securities lawyer.
If the SEC comes knocking, the "utility" argument is stronger than
most tokens because $ARENA has ACTUAL required utility in the game.
```

### AML/KYC Considerations
```
Custodial wallet = money transmitter in most jurisdictions.
You WILL need:
  - KYC for users above certain thresholds ($1,000+ deposits)
  - AML transaction monitoring
  - FinCEN registration (if US users — consider geo-blocking)
  - Travel Rule compliance for transfers > $3,000

Use: Persona.com (KYC) + Chainalysis (AML) + TRM Labs (wallet screening)
These integrate into the token-service onboarding flow.
```

---

## 14. Complete Lifecycle

### User Journey: Deposit → Play → Earn → Redeem

```
STEP 1: DEPOSIT
  User visits AI Arena → clicks "Buy $ARENA"
  Selects chain: Solana | Base | 0G
  Enters amount: 500 USDC
  
  [Solana path]:
    wallet.sendTransaction(depositUSDC(500))
    → arena-reserve mints 500 / backing_ratio $ARENA
    → instantly in custodial wallet
  
  [Base path]:
    metamask.sendTransaction(ArenaDepositVault.depositUSDC(500))
    → Wormhole message emitted
    → ~5 minutes later → $ARENA minted on Solana
    → "Pending" shown in UI until confirmed

STEP 2: FUND AGENT
  User selects agent → "Fund with 100 $ARENA"
  Platform signs tx: transfer 100 $ARENA → agent PDA wallet
  Agent now has "battle balance" of 100 $ARENA

STEP 3: QUEUE FOR BATTLE
  Agent joins matchmaking queue (ELO-based)
  Match found → battle-service creates escrow
  arena-agent-wallet transfers 100 $ARENA → escrow-vault
  Battle runs (AI inference via 0G Compute)

STEP 4: BATTLE ENDS
  financial-service → settle_escrow()
  Winner agent gets 190 $ARENA (95%)
  5 $ARENA → protocol fee
    4 $ARENA (80%) → reserve (backing ratio increases)
    1 $ARENA (20%) → ops treasury

STEP 5: HARVEST / COMPOUND
  Agent returns funds to custodial wallet
  OR: re-queue for another battle
  OR: stake $ARENA for additional yield

STEP 6: REDEEM (Optional)
  User clicks "Convert to USDC"
  Burns Y $ARENA
  arena-reserve sends (Y × backing_ratio × 0.995) USDC
  [Solana]: ~400ms to user's Solana wallet
  [Base]: user provides Base address → cross-chain redemption (Phase 2)
```

---

## 15. MVP vs Scalable Architecture

### MVP (0-3 months, ~$50k budget)
```
✅ Solana-only deposits (no bridge yet)
✅ arena-reserve program (deposit + redeem)
✅ $ARENA SPL token
✅ Custodial wallet system (AWS KMS)
✅ token-service REST API (price, balance, deposit, redeem)
✅ Integration with existing battle/escrow system
✅ Basic battle fee routing to reserve

Skip for MVP:
  ❌ Cross-chain (Base, 0G)
  ❌ Staking yield
  ❌ Tournaments (use existing service)
  ❌ DEX liquidity

MVP success metric: $100k TVL, 500 active agents, positive backing growth
```

### Scalable Architecture (3-12 months)
```
Month 3-6:
  + Base → Solana bridge via Wormhole
  + Staking vault with variable APY
  + DEX liquidity (Raydium $ARENA/USDC)
  + KYC integration (Persona)
  + AML monitoring (Chainalysis)

Month 6-12:
  + 0G → Solana bridge (Wormhole or custom)
  + Cross-chain redemption
  + Tournament economy integration
  + DAO governance contracts
  + Mobile SDK $ARENA integration

Month 12+:
  + Governance token (separate from $ARENA — for voting rights)
  + Multi-asset reserve (accept SOL, ETH → convert to USDC/USDT)
  + Institutional staking tiers
  + zkProof-based privacy for large redemptions
```

### Investor Positioning
```
"AI Arena's $ARENA token is the first reserve-backed gaming utility token.
Unlike speculative game tokens that go to zero, $ARENA is always redeemable
for USDC at the current backing ratio. As the game grows, battle fees flow
into the reserve, increasing the backing ratio — making $ARENA appreciate
with protocol success. Players have downside protection. Investors have
upside. The protocol has sustainable fee revenue from day one."

Comparable: 
  sFRAX (Frax Finance) — reserve-backed, appreciating
  sDAI (Maker) — USDC-backed, yield-bearing
  Difference: $ARENA also has GAME UTILITY driving demand beyond yield

Target raise: $2-5M seed for:
  - Smart contract audits: $200k
  - Initial reserve seeding: $1M
  - 12 months ops: $800k
  - DEX liquidity: $500k
  - Marketing: $300k
  - Legal/compliance: $200k
```
