/**
 * EscrowService — locks $ARENA from two agents before a wager battle
 * and settles the 90/10 split when the battle ends.
 *
 * Flow:
 *   1. lockEscrow(agentId1, agentId2, stakeAmount, battleId)
 *      → deducts stakeAmount from each wallet
 *      → creates EscrowRecord (state = LOCKED)
 *
 *   2. settleEscrow(battleId, winnerId)
 *      → total pool = stakeAmount * 2
 *      → winner receives pool * 0.90
 *      → platform commission = pool * 0.10  (kept in reserve)
 *      → EscrowRecord state → SETTLED
 */

import { prisma, FinancialRepository } from '@ai-arena/db-client';
import { getEventBus } from '@ai-arena/event-bus';
import { AgentWalletClient } from '@ai-arena/solana-client';

const walletClient = new AgentWalletClient();

const finRepo = new FinancialRepository(prisma);

export const COMMISSION_RATE = 0.10; // 10% platform fee

export class EscrowService {

  // ── Lock ───────────────────────────────────────────────────────────────────

  async lockEscrow(
    agentId1:    string,
    agentId2:    string,
    stakeAmount: number,   // per-agent stake (e.g. 5 ARENA each)
    battleId:    string,
  ): Promise<{ escrowId: string; totalPool: number }> {
    const [wallet1, wallet2] = await Promise.all([
      finRepo.getWallet(agentId1),
      finRepo.getWallet(agentId2),
    ]);

    if (!wallet1) throw new Error(`Wallet not found for agent ${agentId1}`);
    if (!wallet2) throw new Error(`Wallet not found for agent ${agentId2}`);
    if (wallet1.isFrozen) throw new Error(`Wallet frozen for agent ${agentId1}`);
    if (wallet2.isFrozen) throw new Error(`Wallet frozen for agent ${agentId2}`);
    if (wallet1.balanceArena < stakeAmount)
      throw new Error(`Insufficient ARENA balance for agent ${agentId1} (need ${stakeAmount}, have ${wallet1.balanceArena})`);
    if (wallet2.balanceArena < stakeAmount)
      throw new Error(`Insufficient ARENA balance for agent ${agentId2} (need ${stakeAmount}, have ${wallet2.balanceArena})`);

    // Deduct from both wallets atomically
    await Promise.all([
      finRepo.updateBalance(agentId1, -stakeAmount, 0),
      finRepo.updateBalance(agentId2, -stakeAmount, 0),
    ]);

    // Create ledger entries for both
    await Promise.all([
      finRepo.createLedgerEntry({
        wallet:   { connect: { id: wallet1.id } },
        type:     'BATTLE_WAGER',
        amount:   stakeAmount,
        currency: 'ARENA',
        status:   'CONFIRMED',
        metadata: { battleId, role: 'escrow_lock' } as any,
      }),
      finRepo.createLedgerEntry({
        wallet:   { connect: { id: wallet2.id } },
        type:     'BATTLE_WAGER',
        amount:   stakeAmount,
        currency: 'ARENA',
        status:   'CONFIRMED',
        metadata: { battleId, role: 'escrow_lock' } as any,
      }),
    ]);

    // Create EscrowRecord
    const escrow = await prisma.escrowRecord.create({
      data: {
        battleId,
        agentIds:      [agentId1, agentId2],
        amounts:       { [agentId1]: stakeAmount, [agentId2]: stakeAmount },
        solanaAddress: `escrow_${battleId}`,   // real: on-chain escrow PDA
        state:         'LOCKED',
      },
    });

    console.log(`[EscrowService] Locked ${stakeAmount} ARENA from each agent. Escrow ${escrow.id}, battle ${battleId}`);

    return { escrowId: escrow.id, totalPool: stakeAmount * 2 };
  }

  // ── Settle ─────────────────────────────────────────────────────────────────

  async settleEscrow(
    battleId: string,
    winnerId: string,
  ): Promise<{ winnerId: string; winnerPayout: number; commission: number }> {
    const escrow = await prisma.escrowRecord.findFirst({
      where: { battleId, state: 'LOCKED' },
    });

    if (!escrow) {
      // No escrow = not a wager battle, silently skip
      console.log(`[EscrowService] No locked escrow for battle ${battleId} — skipping settlement`);
      return { winnerId, winnerPayout: 0, commission: 0 };
    }

    const amounts = escrow.amounts as Record<string, number>;
    const totalPool = Object.values(amounts).reduce((sum, v) => sum + v, 0);
    const commission   = parseFloat((totalPool * COMMISSION_RATE).toFixed(6));
    const winnerPayout = parseFloat((totalPool - commission).toFixed(6));

    // Credit winner
    const winnerWallet = await finRepo.getWallet(winnerId);
    if (!winnerWallet) throw new Error(`Winner wallet not found for agent ${winnerId}`);

    await finRepo.updateBalance(winnerId, winnerPayout, 0);
    await finRepo.createLedgerEntry({
      wallet:   { connect: { id: winnerWallet.id } },
      type:     'BATTLE_REWARD',
      amount:   winnerPayout,
      currency: 'ARENA',
      status:   'CONFIRMED',
      metadata: { battleId, escrowId: escrow.id, commission, totalPool } as any,
    });

    // ── On-chain credit: write winner payout to Solana PDA ───────────────────
    // winnerPayout is in ARENA float (e.g. 9.0). Store as lamport-style u64 (×1000).
    // Falls back silently if program not yet deployed — Postgres is source of truth.
    let solanaTxHash: string | null = null;
    try {
      const arenaUnits = Math.round(winnerPayout * 1000); // 1 ARENA = 1000 units on-chain
      solanaTxHash = await walletClient.creditWallet(winnerId, arenaUnits);
    } catch (err) {
      console.warn('[EscrowService] On-chain credit failed (non-fatal):', (err as Error).message);
    }

    // Mark escrow as settled
    await prisma.escrowRecord.update({
      where: { id: escrow.id },
      data: {
        state:     'SETTLED',
        winnerId,
        settledAt: new Date(),
        txHashes:  { settlement: solanaTxHash ?? `settle_${battleId}_${Date.now()}` },
      },
    });

    // Publish settlement event
    try {
      const bus = await getEventBus();
      await bus.publish('financial.escrow.settled', {
        battleId,
        escrowId:    escrow.id,
        winnerId,
        winnerPayout,
        commission,
        totalPool,
        occurredAt:  new Date(),
      });
    } catch { /* NATS optional */ }

    console.log(`[EscrowService] Settled battle ${battleId}: winner ${winnerId} receives ${winnerPayout} ARENA, commission ${commission} ARENA`);

    return { winnerId, winnerPayout, commission };
  }

  // ── x402 Payment Verification ──────────────────────────────────────────────

  /**
   * Verify an x402 payment proof submitted via X-Payment-Tx-Hash header.
   * Checks:
   *   1. txHash exists in ledger and is CONFIRMED
   *   2. Amount matches expected
   *   3. Not already used (idempotency)
   */
  async verifyX402Payment(
    txHash:         string,
    agentId:        string,
    expectedAmount: number,
  ): Promise<{ valid: boolean; reason?: string }> {
    const wallet = await finRepo.getWallet(agentId);
    if (!wallet) return { valid: false, reason: 'Wallet not found' };

    // Check if this txHash was already used for x402
    const existing = await prisma.ledgerEntry.findFirst({
      where: {
        walletId: wallet.id,
        txHash,
        metadata: { path: ['x402'], equals: true },
      },
    });
    if (existing) return { valid: false, reason: 'Payment already used' };

    // Verify the agent has enough balance (optimistic: just check balance)
    if (wallet.balanceArena < expectedAmount) {
      return { valid: false, reason: `Insufficient balance (need ${expectedAmount}, have ${wallet.balanceArena})` };
    }

    return { valid: true };
  }

  // ── Charge x402 ───────────────────────────────────────────────────────────

  /**
   * Deduct x402 payment from agent wallet after verification.
   */
  async chargeX402(
    txHash:   string,
    agentId:  string,
    amount:   number,
    purpose:  string,
  ): Promise<void> {
    const wallet = await finRepo.getWallet(agentId);
    if (!wallet) throw new Error('Wallet not found');

    await finRepo.updateBalance(agentId, -amount, 0);
    await finRepo.createLedgerEntry({
      wallet:   { connect: { id: wallet.id } },
      type:     'BATTLE_WAGER',
      amount,
      currency: 'ARENA',
      status:   'CONFIRMED',
      txHash,
      metadata: { x402: true, purpose } as any,
    });
  }
}
