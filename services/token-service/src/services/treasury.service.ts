/**
 * TreasuryService
 *
 * Handles all protocol fee routing for the $ARENA reserve:
 *   - 80% of every fee → arena-reserve (backs $ARENA, lifts backing ratio)
 *   - 20% → ops wallet (dev / marketing / liquidity / insurance)
 *
 * Also manages USDC/USDT rebalancing to keep the reserve at the 60/40 target.
 *
 * This service only builds and submits Solana transactions — the on-chain
 * reserve program enforces all accounting invariants.
 */

import {
  Connection, PublicKey, Keypair, Transaction,
  TransactionInstruction, SystemProgram,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { prisma } from '@ai-arena/db-client';
import { getRedisClient } from '@ai-arena/cache';
import { getEventBus } from '@ai-arena/event-bus';

const RESERVE_PROGRAM_ID = new PublicKey(process.env.ARENA_RESERVE_PROGRAM_ID ?? 'ARsv11111111111111111111111111111111111111');
const USDC_MINT          = new PublicKey(process.env.USDC_MINT ?? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const USDT_MINT          = new PublicKey(process.env.USDT_MINT ?? 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB');

// 80 / 20 split in basis points
const RESERVE_CUT_BPS = 8_000n;
const BPS_DENOM       = 10_000n;

// Target rebalance: 60% USDC, 40% USDT — drift >5% triggers rebalance
const TARGET_USDC_BPS   = 6_000n;
const REBALANCE_DRIFT_BPS = 500n;

export interface FeeRouteResult {
  reserveUsdc: bigint;
  opsUsdc:     bigint;
  onChainTx:   string;
}

export class TreasuryService {
  private readonly solana: Connection;
  private readonly relayerKeypair: Keypair;
  private readonly redis = getRedisClient();

  constructor() {
    this.solana = new Connection(
      process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com',
      'confirmed',
    );

    const privKey = process.env.RELAYER_SOLANA_PRIVATE_KEY;
    if (!privKey) throw new Error('RELAYER_SOLANA_PRIVATE_KEY not set');
    this.relayerKeypair = Keypair.fromSecretKey(Buffer.from(privKey, 'base64'));
  }

  // ── Fee Routing ─────────────────────────────────────────────────────────────

  /**
   * Route a protocol fee:
   *   - 80% gets sent to the reserve program via add_protocol_revenue
   *   - 20% stays in ops wallet (transfer handled by caller or separately)
   *
   * @param totalUsdc  Raw USDC amount (6 decimals) to split and route
   * @param sourceType Label for the allocation log
   * @param sourceTxHash  Optional Solana/EVM tx that generated the fee
   */
  async routeFee(params: {
    totalUsdc:    bigint;
    sourceType:   'battle_fee' | 'tournament_fee' | 'redemption_fee';
    sourceTxHash?: string;
  }): Promise<FeeRouteResult> {
    const reserveUsdc = (params.totalUsdc * RESERVE_CUT_BPS) / BPS_DENOM;
    const opsUsdc     = params.totalUsdc - reserveUsdc;

    // Call add_protocol_revenue on the reserve program
    const onChainTx = await this.addProtocolRevenue(reserveUsdc);

    // Log to DB
    await prisma.treasuryAllocation.create({
      data: {
        sourceType:   params.sourceType,
        sourceTxHash: params.sourceTxHash ?? null,
        totalUsdc:    params.totalUsdc.toString(),
        reserveUsdc:  reserveUsdc.toString(),
        opsUsdc:      opsUsdc.toString(),
        onChainTxHash: onChainTx,
      },
    });

    // Bust reserve snapshot cache so next read reflects new backing ratio
    await this.redis.del('arena:reserve:snapshot');

    // Publish event for analytics
    const bus = await getEventBus();
    await bus.publish('treasury.fee_routed', {
      sourceType:  params.sourceType,
      totalUsdc:   params.totalUsdc.toString(),
      reserveUsdc: reserveUsdc.toString(),
      opsUsdc:     opsUsdc.toString(),
      onChainTx,
      occurredAt:  new Date(),
    });

    console.log(
      `[Treasury] Fee routed: total=${params.totalUsdc} reserve=${reserveUsdc} ops=${opsUsdc} tx=${onChainTx}`,
    );

    return { reserveUsdc, opsUsdc, onChainTx };
  }

  // ── Reserve Revenue Instruction ─────────────────────────────────────────────

  private async addProtocolRevenue(usdcAmount: bigint): Promise<string> {
    const [reservePda] = PublicKey.findProgramAddressSync(
      [Buffer.from('reserve')],
      RESERVE_PROGRAM_ID,
    );

    const relayerUsdcAta = await getAssociatedTokenAddress(
      USDC_MINT,
      this.relayerKeypair.publicKey,
    );

    const [usdcVaultPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('usdc_vault')],
      RESERVE_PROGRAM_ID,
    );

    // Anchor discriminator: sha256("global:add_protocol_revenue")[0..8]
    const discriminator = Buffer.from([0x3f, 0xa1, 0x22, 0x7c, 0x9b, 0x44, 0xe8, 0x10]);

    const amtBuf = Buffer.alloc(8);
    amtBuf.writeBigUInt64LE(usdcAmount);

    const data = Buffer.concat([discriminator, amtBuf]);

    const ix = new TransactionInstruction({
      programId: RESERVE_PROGRAM_ID,
      keys: [
        { pubkey: reservePda,                    isSigner: false, isWritable: true  },
        { pubkey: usdcVaultPda,                  isSigner: false, isWritable: true  },
        { pubkey: relayerUsdcAta,                isSigner: false, isWritable: true  },
        { pubkey: this.relayerKeypair.publicKey, isSigner: true,  isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID,              isSigner: false, isWritable: false },
      ],
      data,
    });

    const tx = new Transaction().add(ix);
    return sendAndConfirmTransaction(this.solana, tx, [this.relayerKeypair], {
      commitment: 'confirmed',
    });
  }

  // ── Reserve Rebalancing ─────────────────────────────────────────────────────

  /**
   * Check if USDC/USDT ratio has drifted beyond threshold.
   * If yes, swap excess via a DEX (stub — hook in Jupiter or Orca in prod).
   */
  async maybeRebalance(): Promise<void> {
    const [reservePda] = PublicKey.findProgramAddressSync(
      [Buffer.from('reserve')],
      RESERVE_PROGRAM_ID,
    );
    const info = await this.solana.getAccountInfo(reservePda);
    if (!info) return;

    // Parse USDC + USDT from reserve state (skip 8B disc + 7 pubkeys = 8+224 = 232)
    const usdcRaw = info.data.readBigUInt64LE(232);
    const usdtRaw = info.data.readBigUInt64LE(240);
    const total   = usdcRaw + usdtRaw;
    if (total === 0n) return;

    const usdcBps = (usdcRaw * 10_000n) / total;
    const drift   = usdcBps > TARGET_USDC_BPS
      ? usdcBps - TARGET_USDC_BPS
      : TARGET_USDC_BPS - usdcBps;

    if (drift < REBALANCE_DRIFT_BPS) {
      console.log(`[Treasury] Reserve balanced — USDC ${usdcBps}bps (target ${TARGET_USDC_BPS}bps, drift ${drift}bps)`);
      return;
    }

    console.log(`[Treasury] Rebalance triggered — USDC ${usdcBps}bps drift=${drift}bps`);

    // TODO(Phase 2): Execute swap via Jupiter Aggregator
    // For now: log the intent and alert ops channel
    await prisma.reserveRebalance.create({
      data: {
        triggerReason: 'drift_threshold',
        usdcBefore:    usdcRaw.toString(),
        usdtBefore:    usdtRaw.toString(),
        usdcAfter:     usdcRaw.toString(), // placeholder — no swap yet
        usdtAfter:     usdtRaw.toString(),
        txHash:        null,
      },
    });

    const bus = await getEventBus();
    await bus.publish('treasury.rebalance_needed', {
      usdcBps:    Number(usdcBps),
      targetBps:  Number(TARGET_USDC_BPS),
      driftBps:   Number(drift),
      usdcRaw:    usdcRaw.toString(),
      usdtRaw:    usdtRaw.toString(),
      occurredAt: new Date(),
    });
  }

  // ── Treasury Stats ──────────────────────────────────────────────────────────

  async getTreasuryStats(): Promise<{
    totalFeesRouted7d:    bigint;
    totalFeesRouted30d:   bigint;
    totalReserveAdded7d:  bigint;
    totalOpsAllocated7d:  bigint;
    allocationCount7d:    number;
  }> {
    const since7d  = new Date(Date.now() - 7  * 86_400_000);
    const since30d = new Date(Date.now() - 30 * 86_400_000);

    const [rows7d, rows30d] = await Promise.all([
      prisma.treasuryAllocation.findMany({ where: { createdAt: { gte: since7d  } } }),
      prisma.treasuryAllocation.findMany({ where: { createdAt: { gte: since30d } } }),
    ]);

    const sum = (arr: typeof rows7d, field: 'totalUsdc' | 'reserveUsdc' | 'opsUsdc') =>
      arr.reduce((acc, r) => acc + BigInt(r[field]), 0n);

    return {
      totalFeesRouted7d:   sum(rows7d, 'totalUsdc'),
      totalFeesRouted30d:  sum(rows30d, 'totalUsdc'),
      totalReserveAdded7d: sum(rows7d, 'reserveUsdc'),
      totalOpsAllocated7d: sum(rows7d, 'opsUsdc'),
      allocationCount7d:   rows7d.length,
    };
  }
}
