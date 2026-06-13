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

import { prisma, FinancialRepository, LeagueRepository } from '@ai-arena/db-client';
import { getEventBus } from '@ai-arena/event-bus';
import { AgentWalletClient } from '@ai-arena/solana-client';
import { FinancialOrchestrator } from './financial-orchestrator';

const walletClient = new AgentWalletClient();

const finRepo = new FinancialRepository(prisma);
const leagueRepo = new LeagueRepository(prisma);
const orchestrator = new FinancialOrchestrator();

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

  // ── League: Lock ─────────────────────────────────────────────────────────

  /**
   * §9.2 — locks `LeagueBattle.stakeArena` from both the challenger and
   * opponent's `AgentWallet.balanceArena`, creates an `EscrowRecord` (state
   * LOCKED, linked via `leagueBattleId`), and transitions the battle
   * PENDING -> LOCKED. Idempotent: a battle already LOCKED returns its
   * existing `escrowId` rather than locking funds twice.
   */
  async lockLeagueEscrow(battleId: string): Promise<{ escrowId: string }> {
    const battle = await prisma.leagueBattle.findUnique({ where: { id: battleId } });
    if (!battle) throw new Error(`League battle ${battleId} not found`);

    if (battle.status === 'LOCKED' && battle.escrowId) {
      return { escrowId: battle.escrowId };
    }
    if (battle.status !== 'PENDING') {
      throw new Error(`League battle ${battleId} is not PENDING (status=${battle.status})`);
    }

    const stake = battle.stakeArena;
    const [challengerWallet, opponentWallet] = await Promise.all([
      orchestrator.ensureWallet(battle.challengerId),
      orchestrator.ensureWallet(battle.opponentId),
    ]);
    if (!challengerWallet) throw new Error(`Wallet not found for agent ${battle.challengerId}`);
    if (!opponentWallet) throw new Error(`Wallet not found for agent ${battle.opponentId}`);
    if (challengerWallet.isFrozen) throw new Error(`Wallet frozen for agent ${battle.challengerId}`);
    if (opponentWallet.isFrozen) throw new Error(`Wallet frozen for agent ${battle.opponentId}`);
    if (challengerWallet.balanceArena < stake)
      throw new Error(`Insufficient ARENA balance for agent ${battle.challengerId} (need ${stake}, have ${challengerWallet.balanceArena})`);
    if (opponentWallet.balanceArena < stake)
      throw new Error(`Insufficient ARENA balance for agent ${battle.opponentId} (need ${stake}, have ${opponentWallet.balanceArena})`);

    await Promise.all([
      finRepo.updateBalance(battle.challengerId, -stake, 0),
      finRepo.updateBalance(battle.opponentId, -stake, 0),
    ]);

    await Promise.all([
      finRepo.createLedgerEntry({
        wallet:   { connect: { id: challengerWallet.id } },
        type:     'LEAGUE_BATTLE_WAGER',
        amount:   stake,
        currency: 'ARENA',
        status:   'CONFIRMED',
        metadata: { battleId, role: 'escrow_lock' } as any,
      }),
      finRepo.createLedgerEntry({
        wallet:   { connect: { id: opponentWallet.id } },
        type:     'LEAGUE_BATTLE_WAGER',
        amount:   stake,
        currency: 'ARENA',
        status:   'CONFIRMED',
        metadata: { battleId, role: 'escrow_lock' } as any,
      }),
    ]);

    const escrow = await prisma.escrowRecord.create({
      data: {
        battleId,
        agentIds:       [battle.challengerId, battle.opponentId],
        amounts:        { [battle.challengerId]: stake, [battle.opponentId]: stake },
        solanaAddress:  `escrow_league_${battleId}`,
        state:          'LOCKED',
        leagueBattleId: battle.id,
      },
    });

    await leagueRepo.transitionBattleStatus(battle.id, 'PENDING', 'LOCKED', {
      escrow:     { connect: { id: escrow.id } },
      acceptedAt: new Date(),
    });

    console.log(`[EscrowService] League escrow locked: battle ${battleId}, ${stake} ARENA each, escrow ${escrow.id}`);
    return { escrowId: escrow.id };
  }

  // ── League: Settle ───────────────────────────────────────────────────────

  /**
   * §9.3/§9.4 — settles a LOCKED League Battle escrow.
   *   winnerId set  -> winner receives 90% of the pool, 10% commission stays
   *                    in the platform reserve (never paid out).
   *   winnerId null -> void: both stakes are refunded in full (tie or the
   *                    match was cancelled).
   * Idempotent: a battle already SETTLED/VOID, or an escrow already
   * SETTLED/CANCELLED, is a no-op.
   */
  async settleLeagueBattle(battleId: string, winnerId: string | null): Promise<void> {
    const battle = await prisma.leagueBattle.findUnique({ where: { id: battleId } });
    if (!battle) throw new Error(`League battle ${battleId} not found`);

    if (battle.status === 'SETTLED' || battle.status === 'VOID') return;
    if (battle.status !== 'LOCKED' || !battle.escrowId) {
      throw new Error(`League battle ${battleId} is not LOCKED (status=${battle.status})`);
    }

    const escrow = await prisma.escrowRecord.findUnique({ where: { id: battle.escrowId } });
    if (!escrow) throw new Error(`Escrow ${battle.escrowId} not found for battle ${battleId}`);
    if (escrow.state === 'SETTLED' || escrow.state === 'CANCELLED') return;
    if (escrow.state !== 'LOCKED') {
      throw new Error(`Escrow ${escrow.id} is not LOCKED (state=${escrow.state})`);
    }

    const amounts = escrow.amounts as Record<string, number>;
    const totalPool = Object.values(amounts).reduce((sum, v) => sum + v, 0);
    const now = new Date();

    if (winnerId) {
      const commission   = parseFloat((totalPool * COMMISSION_RATE).toFixed(6));
      const winnerPayout = parseFloat((totalPool - commission).toFixed(6));

      const winnerWallet = await orchestrator.ensureWallet(winnerId);
      if (!winnerWallet) throw new Error(`Winner wallet not found for agent ${winnerId}`);

      await finRepo.updateBalance(winnerId, winnerPayout, 0);
      await finRepo.createLedgerEntry({
        wallet:   { connect: { id: winnerWallet.id } },
        type:     'LEAGUE_BATTLE_REWARD',
        amount:   winnerPayout,
        currency: 'ARENA',
        status:   'CONFIRMED',
        metadata: { battleId, escrowId: escrow.id, commission, totalPool } as any,
      });

      await prisma.escrowRecord.update({
        where: { id: escrow.id },
        data:  { state: 'SETTLED', winnerId, settledAt: now },
      });

      await leagueRepo.transitionBattleStatus(battle.id, 'LOCKED', 'SETTLED', { winnerId, settledAt: now });

      console.log(`[EscrowService] League battle ${battleId} settled: winner ${winnerId} receives ${winnerPayout} ARENA, commission ${commission} ARENA`);
    } else {
      await Promise.all(
        Object.entries(amounts).map(async ([agentId, amount]) => {
          const wallet = await orchestrator.ensureWallet(agentId);
          if (!wallet) return;
          await finRepo.updateBalance(agentId, amount, 0);
          await finRepo.createLedgerEntry({
            wallet:   { connect: { id: wallet.id } },
            type:     'LEAGUE_BATTLE_REFUND',
            amount,
            currency: 'ARENA',
            status:   'CONFIRMED',
            metadata: { battleId, escrowId: escrow.id } as any,
          });
        }),
      );

      await prisma.escrowRecord.update({
        where: { id: escrow.id },
        data:  { state: 'CANCELLED', settledAt: now },
      });

      await leagueRepo.transitionBattleStatus(battle.id, 'LOCKED', 'VOID', { settledAt: now });

      console.log(`[EscrowService] League battle ${battleId} voided: refunded ${totalPool} ARENA total`);
    }
  }

  // ── League: Prediction reward ───────────────────────────────────────────

  /**
   * §5.6/§10.2 step 4 — credits `AgentWallet.balanceArena` for a settled
   * League prediction. Idempotent on `(predictionId, LEAGUE_PREDICTION_REWARD)`
   * — a duplicate call for an already-credited prediction is a no-op.
   */
  async creditLeaguePrediction(
    agentId:      string,
    predictionId: string,
    amount:       number,
    metadata:     Record<string, unknown>,
  ): Promise<void> {
    const wallet = await orchestrator.ensureWallet(agentId);
    if (!wallet) throw new Error(`Wallet not found for agent ${agentId}`);

    const existing = await prisma.ledgerEntry.findFirst({
      where: {
        walletId: wallet.id,
        type:     'LEAGUE_PREDICTION_REWARD',
        metadata: { path: ['predictionId'], equals: predictionId },
      },
    });
    if (existing) return;

    await finRepo.updateBalance(agentId, amount, 0);
    await finRepo.createLedgerEntry({
      wallet:   { connect: { id: wallet.id } },
      type:     'LEAGUE_PREDICTION_REWARD',
      amount,
      currency: 'ARENA',
      status:   'CONFIRMED',
      metadata: { predictionId, ...metadata } as any,
    });
  }

  // ── x402 Auto-Pay (custodial wallet) ─────────────────────────────────────

  /**
   * Initiate an x402 payment from the agent's custodial ARENA wallet.
   *
   * Called by the frontend x402 interceptor when it receives a 402.
   * Deducts the amount up-front and returns a synthetic txHash the client
   * can immediately use to retry the original request.
   *
   * The gateway's verifyX402Payment will recognise this as a pre-paid entry
   * and let the request through without double-charging.
   */
  async initiateX402Payment(
    agentId: string,
    amount:  number,
    purpose: string,
  ): Promise<{ txHash: string }> {
    const wallet = await finRepo.getWallet(agentId);
    if (!wallet)        throw new Error('Wallet not found');
    if (wallet.isFrozen) throw new Error('Wallet is frozen');
    if (wallet.balanceArena < amount) {
      throw new Error(`Insufficient ARENA balance (need ${amount}, have ${wallet.balanceArena})`);
    }

    // Deduct balance up-front
    await finRepo.updateBalance(agentId, -amount, 0);

    // Synthetic internal txHash — unique and traceable
    const txHash = `x402_internal_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    await finRepo.createLedgerEntry({
      wallet:   { connect: { id: wallet.id } },
      type:     'BATTLE_WAGER',
      amount,
      currency: 'ARENA',
      status:   'CONFIRMED',
      txHash,
      metadata: { x402_prepaid: true, x402_used: false, purpose } as any,
    });

    console.log(`[EscrowService] x402 pre-paid: agent ${agentId}, ${amount} ARENA, purpose=${purpose}, tx=${txHash}`);
    return { txHash };
  }

  // ── x402 Payment Verification ──────────────────────────────────────────────

  /**
   * Verify an x402 payment proof submitted via X-Payment-Tx-Hash header.
   *
   * Handles two flows:
   *   A. Pre-paid (initiateX402Payment)  — finds the ledger entry by txHash,
   *      checks it hasn't been consumed yet.
   *   B. Manual Solana transfer          — checks the agent has sufficient balance.
   */
  async verifyX402Payment(
    txHash:         string,
    agentId:        string,
    expectedAmount: number,
  ): Promise<{ valid: boolean; reason?: string }> {
    const wallet = await finRepo.getWallet(agentId);
    if (!wallet) return { valid: false, reason: 'Wallet not found' };

    // ── Flow A: pre-paid internal payment ─────────────────────────────────────
    const prePaid = await prisma.ledgerEntry.findFirst({
      where: {
        walletId: wallet.id,
        txHash,
        metadata: { path: ['x402_prepaid'], equals: true },
      },
    });

    if (prePaid) {
      const meta = prePaid.metadata as Record<string, unknown>;
      if (meta.x402_used) return { valid: false, reason: 'Payment already used' };
      if ((prePaid.amount as number) < expectedAmount) {
        return { valid: false, reason: `Pre-paid amount ${prePaid.amount} < required ${expectedAmount}` };
      }
      return { valid: true };
    }

    // ── Flow B: external Solana tx — guard against replay ─────────────────────
    const existing = await prisma.ledgerEntry.findFirst({
      where: {
        walletId: wallet.id,
        txHash,
        metadata: { path: ['x402'], equals: true },
      },
    });
    if (existing) return { valid: false, reason: 'Payment already used' };

    if (wallet.balanceArena < expectedAmount) {
      return { valid: false, reason: `Insufficient balance (need ${expectedAmount}, have ${wallet.balanceArena})` };
    }

    return { valid: true };
  }

  // ── Charge x402 ───────────────────────────────────────────────────────────

  /**
   * Finalise an x402 payment after verification:
   *   - Pre-paid entries: mark as consumed (balance already deducted).
   *   - External Solana txs: deduct balance and record.
   */
  async chargeX402(
    txHash:   string,
    agentId:  string,
    amount:   number,
    purpose:  string,
  ): Promise<void> {
    const wallet = await finRepo.getWallet(agentId);
    if (!wallet) throw new Error('Wallet not found');

    // Mark pre-paid entry as consumed
    const prePaid = await prisma.ledgerEntry.findFirst({
      where: {
        walletId: wallet.id,
        txHash,
        metadata: { path: ['x402_prepaid'], equals: true },
      },
    });

    if (prePaid) {
      await prisma.ledgerEntry.update({
        where: { id: prePaid.id },
        data:  { metadata: { ...(prePaid.metadata as object), x402_used: true } },
      });
      return;
    }

    // External Solana flow: deduct + record
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
