/**
 * BridgeService
 *
 * Listens for DepositQueued events on:
 *   - Base mainnet (chainId 8453)  — USDC (asset=0) and USDT (asset=1) deposits
 *   - 0G mainnet (chainId 16661)   — native 0G token deposits (asset=2)
 *
 * For each confirmed deposit:
 *   1. Waits for finality (12 confs on Base, 20 on 0G)
 *   2. For native 0G deposits: fetches 0G/USD price from CoinGecko → converts to USDC equivalent
 *   3. Calls arena-reserve.receive_bridge_deposit() on Solana to mint $ARENA
 *   4. Updates BridgeDeposit record in DB
 *
 * Daily auto-approve limit: $50,000 equivalent per day.
 * Amounts above that go to MANUAL_REVIEW queue.
 *
 * Phase 1 (current): Centralized relayer — relayer wallet is the reserve authority.
 * Phase 2: Replace with Wormhole VAA trustless relay.
 */

import { ethers } from 'ethers';
import {
  Connection, PublicKey, Keypair, Transaction,
  TransactionInstruction, SystemProgram, SYSVAR_RENT_PUBKEY,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { getEventBus } from '@ai-arena/event-bus';
import { prisma }      from '@ai-arena/db-client';

const DEPOSIT_VAULT_ABI = [
  'event DepositQueued(uint256 indexed depositId, address indexed depositor, bytes32 indexed solanaRecipient, uint8 asset, uint256 amount, uint256 fee, uint256 chain)',
];

const RESERVE_PROGRAM_ID = new PublicKey(process.env.ARENA_RESERVE_PROGRAM_ID ?? 'ARsv11111111111111111111111111111111111111');
const ARENA_MINT         = new PublicKey(process.env.ARENA_TOKEN_MINT          ?? '');

// Daily auto-approve limit: $50,000 expressed in USDC 6-decimal units
const AUTO_APPROVE_DAILY_LIMIT = 50_000_000_000n;

// ── Chain config ───────────────────────────────────────────────────────────────

const CHAIN_CONFIG = [
  {
    name:      'base',
    chainId:   8453,
    rpc:       process.env.BASE_RPC_URL ?? 'https://mainnet.base.org',
    vault:     process.env.BASE_DEPOSIT_VAULT_ADDRESS ?? '',
    confirms:  12,   // ~24s on Base (2s blocks)
    explorer:  'https://basescan.org/tx/',
  },
  {
    name:      '0g',
    chainId:   16661,
    rpc:       process.env.ZEROG_EVM_RPC ?? 'https://evmrpc.0g.ai',
    vault:     process.env.ZEROG_DEPOSIT_VAULT_ADDRESS ?? '',
    confirms:  20,   // conservative for 0G
    explorer:  'https://chainscan.0g.ai/tx/',
  },
];

// ── BridgeService ─────────────────────────────────────────────────────────────

export class BridgeService {
  private readonly solana: Connection;
  private readonly relayerKeypair: Keypair;
  private dailyRelayed   = 0n;
  private lastResetDate  = new Date().toDateString();

  private readonly providers:      Record<string, ethers.Provider> = {};
  private readonly vaultContracts: Record<string, ethers.Contract> = {};

  constructor() {
    this.solana = new Connection(
      process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com',
      'confirmed',
    );

    const privKey = process.env.RELAYER_SOLANA_PRIVATE_KEY;
    if (!privKey) throw new Error('RELAYER_SOLANA_PRIVATE_KEY not set');
    this.relayerKeypair = Keypair.fromSecretKey(Buffer.from(privKey, 'base64'));

    this.initEVMProviders();
  }

  private initEVMProviders() {
    for (const chain of CHAIN_CONFIG) {
      if (!chain.vault) {
        console.warn(`[Bridge] No vault address configured for ${chain.name} — skipping`);
        continue;
      }
      const provider = new ethers.JsonRpcProvider(chain.rpc);
      const contract = new ethers.Contract(chain.vault, DEPOSIT_VAULT_ABI, provider);
      this.providers[chain.name]      = provider;
      this.vaultContracts[chain.name] = contract;
    }
  }

  // ── Event listening ────────────────────────────────────────────────────────

  startListening() {
    for (const [chainName, contract] of Object.entries(this.vaultContracts)) {
      contract.on('DepositQueued', async (
        depositId: bigint,
        depositor: string,
        solanaRecipient: string,
        asset: number,
        amount: bigint,
        fee: bigint,
        chainId: bigint,
        event: ethers.EventLog,
      ) => {
        const assetName = asset === 0 ? 'USDC' : asset === 1 ? 'USDT' : 'NATIVE';
        console.log(`[Bridge] DepositQueued on ${chainName}: id=${depositId} asset=${assetName} amount=${amount}`);
        await this.handleDepositQueued({
          chainName, depositId, depositor, solanaRecipient,
          asset, amount, fee,
          txHash: event.transactionHash, blockNumber: event.blockNumber,
        });
      });

      console.log(`[Bridge] Listening on ${chainName} (${CHAIN_CONFIG.find(c => c.name === chainName)?.vault})`);
    }

    if (Object.keys(this.vaultContracts).length === 0) {
      console.warn('[Bridge] No vaults configured — bridge is inactive. Set BASE_DEPOSIT_VAULT_ADDRESS and/or ZEROG_DEPOSIT_VAULT_ADDRESS.');
    }
  }

  stopListening() {
    for (const contract of Object.values(this.vaultContracts)) {
      contract.removeAllListeners();
    }
  }

  // ── Deposit processing ──────────────────────────────────────────────────────

  private async handleDepositQueued(params: {
    chainName:       string;
    depositId:       bigint;
    depositor:       string;
    solanaRecipient: string;
    asset:           number;   // 0=USDC  1=USDT  2=NATIVE_0G
    amount:          bigint;
    fee:             bigint;
    txHash:          string;
    blockNumber:     number;
  }) {
    // Idempotency check
    const existing = await prisma.bridgeDeposit.findFirst({
      where: { sourceTxHash: params.txHash, sourceChain: params.chainName },
    });
    if (existing?.status === 'CONFIRMED') return;

    // Decode Solana recipient from bytes32
    const solanaAddress = this.bytes32ToSolanaAddress(params.solanaRecipient);
    if (!solanaAddress) {
      console.error(`[Bridge] Invalid Solana recipient: ${params.solanaRecipient}`);
      return;
    }

    // Upsert pending record
    const record = await prisma.bridgeDeposit.upsert({
      where:  { sourceTxHash_sourceChain: { sourceTxHash: params.txHash, sourceChain: params.chainName } },
      update: { status: 'PENDING' },
      create: {
        sourceChain:   params.chainName,
        sourceTxHash:  params.txHash,
        solanaAddress,
        usdcAmount:    params.amount.toString(),
        depositId:     params.depositId.toString(),
        depositorEvm:  params.depositor,
        status:        'PENDING',
        createdAt:     new Date(),
      },
    });

    // Wait for finality
    await this.waitForFinality(params.chainName, params.blockNumber);

    // Convert native 0G to USDC equivalent (18→6 decimals + USD price)
    let usdcEquivalent: bigint;
    if (params.asset === 2) {
      usdcEquivalent = await this.nativeToUsdcEquivalent(params.chainName, params.amount);
    } else {
      usdcEquivalent = params.amount; // already in 6-decimal USDC/USDT
    }

    // Daily limit check
    const today = new Date().toDateString();
    if (today !== this.lastResetDate) {
      this.dailyRelayed  = 0n;
      this.lastResetDate = today;
    }

    if (this.dailyRelayed + usdcEquivalent > AUTO_APPROVE_DAILY_LIMIT) {
      await prisma.bridgeDeposit.update({
        where: { id: record.id },
        data:  { status: 'MANUAL_REVIEW', flagReason: 'Daily auto-approve limit exceeded' },
      });
      const bus = await getEventBus();
      await bus.publish('bridge.manual_review', {
        depositId: record.id, amount: usdcEquivalent.toString(),
        chain: params.chainName, occurredAt: new Date(),
      });
      console.warn(`[Bridge] Manual review required: ${params.txHash} (${usdcEquivalent} USDC eq)`);
      return;
    }

    // Mint $ARENA on Solana
    try {
      const solanaTxHash = await this.mintOnSolana(solanaAddress, usdcEquivalent, params.txHash);
      this.dailyRelayed += usdcEquivalent;

      await prisma.bridgeDeposit.update({
        where: { id: record.id },
        data:  { status: 'CONFIRMED', solanaTxHash, confirmedAt: new Date() },
      });

      console.log(`[Bridge] ✅ Minted $ARENA: ${solanaTxHash} (deposit ${params.txHash})`);

      const bus = await getEventBus();
      await bus.publish('bridge.deposit_confirmed', {
        depositId: record.id, solanaAddress,
        usdcAmount: usdcEquivalent.toString(),
        solanaTxHash, occurredAt: new Date(),
      });
    } catch (err) {
      console.error(`[Bridge] Mint failed for ${params.txHash}:`, err);
      await prisma.bridgeDeposit.update({
        where: { id: record.id },
        data:  { status: 'FAILED', errorMessage: String(err) },
      });
    }
  }

  // ── Finality wait ──────────────────────────────────────────────────────────

  private async waitForFinality(chainName: string, blockNumber: number): Promise<void> {
    const provider = this.providers[chainName];
    const required = CHAIN_CONFIG.find(c => c.name === chainName)?.confirms ?? 12;

    return new Promise((resolve) => {
      const check = async () => {
        try {
          const current = await provider.getBlockNumber();
          if (current >= blockNumber + required) { resolve(); return; }
        } catch { /* retry */ }
        setTimeout(check, 3_000);
      };
      check();
    });
  }

  // ── 0G native → USDC equivalent ────────────────────────────────────────────

  /**
   * Convert native 0G token amount (18 decimals) to USDC equivalent (6 decimals).
   * Uses CoinGecko free API. Falls back to env-configured manual rate.
   */
  private async nativeToUsdcEquivalent(chainName: string, rawAmount: bigint): Promise<bigint> {
    if (chainName !== '0g') return rawAmount;

    let priceUsd: number;
    try {
      // CoinGecko free API — 0G token ID
      const url = 'https://api.coingecko.com/api/v3/simple/price?ids=zero-gravity-2&vs_currencies=usd';
      const r = await fetch(url, { headers: { accept: 'application/json' } });
      const d = await r.json();
      priceUsd = d['zero-gravity-2']?.usd ?? 0;
      if (priceUsd <= 0) throw new Error('zero price');
    } catch {
      // Fallback: use manual rate from env (default 1 0G = $0.05)
      priceUsd = parseFloat(process.env.ZEROG_MANUAL_PRICE_USD ?? '0.05');
      console.warn(`[Bridge] CoinGecko failed — using manual 0G price: $${priceUsd}`);
    }

    // rawAmount is 18 decimals, priceUsd converts to USD, result in 6-decimal USDC
    // usdcEquivalent = rawAmount * priceUsd / 1e18 * 1e6
    //                = rawAmount * priceUsd / 1e12
    const priceScaled  = BigInt(Math.round(priceUsd * 1_000_000)); // 6 decimal fixed
    const usdcEquivalent = (rawAmount * priceScaled) / 1_000_000_000_000_000_000n;

    console.log(`[Bridge] 0G native ${rawAmount} → $${priceUsd}/0G → ${usdcEquivalent} USDC`);
    return usdcEquivalent;
  }

  // ── Solana mint ────────────────────────────────────────────────────────────

  private async mintOnSolana(
    solanaRecipient: string,
    usdcAmount:      bigint,
    sourceEvmTxHash: string,
  ): Promise<string> {
    const recipient = new PublicKey(solanaRecipient);

    const [reservePda] = PublicKey.findProgramAddressSync(
      [Buffer.from('reserve')],
      RESERVE_PROGRAM_ID,
    );

    // Phase 1 VAA hash: SHA256 of EVM tx hash padded to 32 bytes
    const vaaHash = Buffer.from(
      sourceEvmTxHash.replace('0x', '').padStart(64, '0'),
      'hex',
    );
    const [vaaRecordPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('vaa'), vaaHash],
      RESERVE_PROGRAM_ID,
    );

    const recipientAta = await getAssociatedTokenAddress(ARENA_MINT, recipient);

    // Anchor discriminator: sha256("global:receive_bridge_deposit")[0..8]
    const discriminator = Buffer.from([0xb4, 0x5c, 0x82, 0x1e, 0x3a, 0x90, 0x12, 0xf1]);
    const amtBuf = Buffer.alloc(8);
    amtBuf.writeBigUInt64LE(usdcAmount);

    const data = Buffer.concat([discriminator, amtBuf, recipient.toBuffer(), vaaHash]);

    const ix = new TransactionInstruction({
      programId: RESERVE_PROGRAM_ID,
      keys: [
        { pubkey: reservePda,                    isSigner: false, isWritable: true  },
        { pubkey: ARENA_MINT,                    isSigner: false, isWritable: true  },
        { pubkey: vaaRecordPda,                  isSigner: false, isWritable: true  },
        { pubkey: recipientAta,                  isSigner: false, isWritable: true  },
        { pubkey: recipient,                     isSigner: false, isWritable: false },
        { pubkey: this.relayerKeypair.publicKey, isSigner: true,  isWritable: true  },
        { pubkey: TOKEN_PROGRAM_ID,              isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID,   isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId,       isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY,            isSigner: false, isWritable: false },
      ],
      data,
    });

    const tx  = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(
      this.solana, tx, [this.relayerKeypair], { commitment: 'confirmed' },
    );
    return sig;
  }

  // ── Utilities ──────────────────────────────────────────────────────────────

  private bytes32ToSolanaAddress(bytes32Hex: string): string | null {
    try {
      const buf = Buffer.from(bytes32Hex.replace('0x', ''), 'hex');
      return new PublicKey(buf).toBase58();
    } catch {
      return null;
    }
  }
}
