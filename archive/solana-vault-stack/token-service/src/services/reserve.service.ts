/**
 * ReserveService
 *
 * Reads the on-chain arena-reserve PDA and provides:
 *   - Current backing ratio (price per $ARENA in USDC)
 *   - Mint preview (how many $ARENA you get for X USDC)
 *   - Redeem preview (how much USDC you get for Y $ARENA)
 *
 * Does NOT sign transactions — the Solana program enforces everything on-chain.
 * This service is read-only + orchestration only.
 */

import {
  Connection, PublicKey, Keypair,
  sendAndConfirmTransaction, Transaction,
} from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import { prisma } from '@ai-arena/db-client';
import { getRedisClient } from '@ai-arena/cache';

// Fallback to System Program ID (always valid) when mint not yet deployed
const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const RESERVE_PROGRAM_ID = new PublicKey(process.env.ARENA_RESERVE_PROGRAM_ID || SYSTEM_PROGRAM);
const ARENA_MINT         = new PublicKey(process.env.ARENA_TOKEN_MINT           || SYSTEM_PROGRAM);
const USDC_MINT          = new PublicKey(process.env.USDC_MINT                  ?? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const USDT_MINT          = new PublicKey(process.env.USDT_MINT                  ?? 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB');

const BPS_DENOMINATOR = 10_000n;
const CACHE_TTL_S     = 10; // back ratio cached for 10 seconds

export interface ReserveSnapshot {
  totalReserveUsdc: bigint;  // raw 6-decimal
  totalReserveUsdt: bigint;
  totalShares:      bigint;  // raw $ARENA supply
  backingRatioBps:  bigint;  // 10000 = 1.0000 USDC per $ARENA
  backingRatioHuman: number; // e.g. 1.1842
  isPaused:         boolean;
  redemptionFeeBps: number;
  dailyRedeemed:    bigint;
}

export class ReserveService {
  private readonly connection: Connection;
  private readonly redis = getRedisClient();

  constructor() {
    this.connection = new Connection(
      process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com',
      'confirmed',
    );
  }

  // ── On-chain reads ──────────────────────────────────────────────────────────

  async getReserveSnapshot(): Promise<ReserveSnapshot> {
    const cacheKey = 'arena:reserve:snapshot';
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached, (_, v) =>
      typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v
    );

    const [reservePda] = PublicKey.findProgramAddressSync(
      [Buffer.from('reserve')],
      RESERVE_PROGRAM_ID,
    );

    const accountInfo = await this.connection.getAccountInfo(reservePda);
    if (!accountInfo) throw new Error('Reserve PDA not found — program not deployed?');

    const snapshot = this.decodeReserveState(accountInfo.data);
    await this.redis.setex(cacheKey, CACHE_TTL_S, JSON.stringify(snapshot, (_, v) =>
      typeof v === 'bigint' ? `${v}n` : v
    ));

    return snapshot;
  }

  private decodeReserveState(data: Buffer): ReserveSnapshot {
    // Skip 8-byte Anchor discriminator
    let offset = 8;
    const readPubkey = () => { const pk = data.slice(offset, offset + 32); offset += 32; return pk; };
    const readU64    = () => { const v = data.readBigUInt64LE(offset); offset += 8; return v; };
    const readU16    = () => { const v = data.readUInt16LE(offset);    offset += 2; return v; };
    const readBool   = () => { const v = data[offset] !== 0;            offset += 1; return v; };

    // authority, arena_mint, usdc_mint, usdt_mint, usdc_vault, usdt_vault, treasury
    for (let i = 0; i < 7; i++) readPubkey();

    const totalReserveUsdc = readU64();
    const totalReserveUsdt = readU64();
    const totalShares      = readU64();
    const redemptionFeeBps = readU16();
    const treasuryCutBps   = readU16();
    const dailyRedeemed    = readU64();
    readU64(); // last_reset_ts
    const isPaused         = readBool();

    const totalReserve = totalReserveUsdc + totalReserveUsdt;
    const backingRatioBps = totalShares === 0n
      ? 10_000n
      : (totalReserve * 10_000n) / totalShares;

    return {
      totalReserveUsdc,
      totalReserveUsdt,
      totalShares,
      backingRatioBps,
      backingRatioHuman: Number(backingRatioBps) / 10_000,
      isPaused,
      redemptionFeeBps,
      dailyRedeemed,
    };
  }

  // ── Price calculations ──────────────────────────────────────────────────────

  /** How many $ARENA do you get for `usdcAmount` (in raw 6-decimal units)? */
  async previewDeposit(usdcAmount: bigint): Promise<{
    arenaOut:     bigint;
    backingRatio: number;
    pricePerArena: number;
  }> {
    const s = await this.getReserveSnapshot();
    if (s.isPaused) throw new Error('Reserve is paused');

    const totalReserve = s.totalReserveUsdc + s.totalReserveUsdt;
    const arenaOut = s.totalShares === 0n
      ? usdcAmount                                              // first deposit: 1:1
      : (usdcAmount * s.totalShares) / totalReserve;           // vault-share formula

    return {
      arenaOut,
      backingRatio:  s.backingRatioHuman,
      pricePerArena: s.backingRatioHuman,
    };
  }

  /** How much USDC (net) do you get for burning `arenaAmount`? */
  async previewRedeem(arenaAmount: bigint): Promise<{
    grossUsdc:  bigint;
    fee:        bigint;
    netUsdc:    bigint;
    feeBps:     number;
  }> {
    const s = await this.getReserveSnapshot();
    if (s.isPaused) throw new Error('Reserve is paused');

    const totalReserve = s.totalReserveUsdc + s.totalReserveUsdt;
    const grossUsdc    = (arenaAmount * totalReserve) / s.totalShares;
    const fee          = (grossUsdc * BigInt(s.redemptionFeeBps)) / BPS_DENOMINATOR;
    const netUsdc      = grossUsdc - fee;

    return { grossUsdc, fee, netUsdc, feeBps: s.redemptionFeeBps };
  }

  // ── User balance ────────────────────────────────────────────────────────────

  async getUserArenaBalance(solanaAddress: string): Promise<{
    raw:   bigint;
    human: number;
    usdcEquivalent: number;
  }> {
    const wallet = new PublicKey(solanaAddress);
    const ata    = await getAssociatedTokenAddress(ARENA_MINT, wallet);

    let raw = 0n;
    try {
      const info = await this.connection.getTokenAccountBalance(ata);
      raw = BigInt(info.value.amount);
    } catch {
      // ATA doesn't exist yet — balance is 0
    }

    const s    = await this.getReserveSnapshot();
    const human = Number(raw) / 1e6;
    const usdcEquivalent = human * s.backingRatioHuman;

    return { raw, human, usdcEquivalent };
  }

  // ── Bridge deposit record ───────────────────────────────────────────────────

  async recordPendingBridgeDeposit(params: {
    userId:         string;
    sourceChain:    string;
    sourceTxHash:   string;
    solanaAddress:  string;
    usdcAmount:     bigint;
    depositId:      bigint;
  }): Promise<string> {
    const record = await prisma.bridgeDeposit.create({
      data: {
        userId:        params.userId,
        sourceChain:   params.sourceChain,
        sourceTxHash:  params.sourceTxHash,
        solanaAddress: params.solanaAddress,
        usdcAmount:    params.usdcAmount.toString(),
        depositId:     params.depositId.toString(),
        status:        'PENDING',
        createdAt:     new Date(),
      },
    });
    return record.id;
  }

  async markBridgeDepositConfirmed(depositId: string, solanaTxHash: string): Promise<void> {
    await prisma.bridgeDeposit.update({
      where: { id: depositId },
      data:  { status: 'CONFIRMED', solanaTxHash, confirmedAt: new Date() },
    });
  }
}

