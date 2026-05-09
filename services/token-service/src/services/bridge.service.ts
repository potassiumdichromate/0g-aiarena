/**
 * BridgeService
 *
 * Phase 1 (MVP): Backend relayer for Base → Solana and 0G → Solana deposits.
 * Listens for DepositQueued events on EVM chains, verifies finality,
 * then calls arena-reserve.receive_bridge_deposit() on Solana.
 *
 * Phase 2: Replace with Wormhole VAA-based trustless relay.
 *
 * Security model (Phase 1):
 *   - Relayer is the reserve program's authority (multisig in prod)
 *   - All deposits logged to DB and verifiable by users on-chain
 *   - Rate limited: auto-approve ≤ $50k/day, larger goes to manual queue
 *   - VAA hash stored on-chain prevents double-minting
 */

import { ethers } from 'ethers';
import {
  Connection, PublicKey, Keypair, Transaction,
  TransactionInstruction, SystemProgram, SYSVAR_RENT_PUBKEY,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { getAssociatedTokenAddress, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { getEventBus, SUBJECTS } from '@ai-arena/event-bus';
import { prisma } from '@ai-arena/db-client';
import { ReserveService } from './reserve.service';

const DEPOSIT_VAULT_ABI = [
  'event DepositQueued(uint256 indexed depositId, address indexed depositor, bytes32 indexed solanaRecipient, uint8 asset, uint256 amount, uint256 fee, uint256 chain)',
];

const RESERVE_PROGRAM_ID = new PublicKey(process.env.ARENA_RESERVE_PROGRAM_ID ?? 'ARsv11111111111111111111111111111111111111');
const ARENA_MINT         = new PublicKey(process.env.ARENA_TOKEN_MINT          ?? '');

// Daily auto-approval limit: $50,000 in raw USDC (6 decimals)
const AUTO_APPROVE_DAILY_LIMIT = 50_000_000_000n;

export class BridgeService {
  private readonly reserveService = new ReserveService();
  private readonly solana: Connection;
  private readonly relayerKeypair: Keypair;
  private dailyRelayed = 0n;
  private lastResetDate = new Date().toDateString();

  // EVM providers keyed by chain name
  private readonly providers: Record<string, ethers.Provider> = {};
  private readonly vaultContracts: Record<string, ethers.Contract> = {};

  constructor() {
    this.solana = new Connection(
      process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com',
      'confirmed',
    );

    // In production: load from AWS KMS. For now: env var.
    const privKey = process.env.RELAYER_SOLANA_PRIVATE_KEY;
    if (!privKey) throw new Error('RELAYER_SOLANA_PRIVATE_KEY not set');
    this.relayerKeypair = Keypair.fromSecretKey(Buffer.from(privKey, 'base64'));

    this.initEVMProviders();
  }

  private initEVMProviders() {
    const chains = [
      {
        name:     'base',
        rpc:      process.env.BASE_RPC_URL    ?? 'https://mainnet.base.org',
        vault:    process.env.BASE_DEPOSIT_VAULT_ADDRESS ?? '',
        confirms: 12, // ~24s finality on Base
      },
      {
        name:     '0g',
        rpc:      process.env.ZEROG_EVM_RPC   ?? 'https://evmrpc.0g.ai',
        vault:    process.env.ZEROG_DEPOSIT_VAULT_ADDRESS ?? '',
        confirms: 20, // conservative for 0G
      },
    ];

    for (const chain of chains) {
      if (!chain.vault) continue;
      const provider = new ethers.JsonRpcProvider(chain.rpc);
      const contract = new ethers.Contract(chain.vault, DEPOSIT_VAULT_ABI, provider);
      this.providers[chain.name]     = provider;
      this.vaultContracts[chain.name] = contract;
    }
  }

  // ── Event Listening ─────────────────────────────────────────────────────────

  /** Start listening for DepositQueued events on all configured EVM chains. */
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
        console.log(`[Bridge] DepositQueued on ${chainName}: id=${depositId} amount=${amount}`);
        await this.handleDepositQueued({
          chainName,
          depositId,
          depositor,
          solanaRecipient,
          asset,
          amount,
          fee,
          txHash: event.transactionHash,
          blockNumber: event.blockNumber,
        });
      });

      console.log(`[Bridge] Listening on ${chainName} vault...`);
    }
  }

  stopListening() {
    for (const contract of Object.values(this.vaultContracts)) {
      contract.removeAllListeners();
    }
  }

  // ── Deposit Processing ──────────────────────────────────────────────────────

  private async handleDepositQueued(params: {
    chainName:       string;
    depositId:       bigint;
    depositor:       string;
    solanaRecipient: string; // bytes32 as hex
    asset:           number;
    amount:          bigint;
    fee:             bigint;
    txHash:          string;
    blockNumber:     number;
  }) {
    // Idempotency: check if already processed
    const existing = await prisma.bridgeDeposit.findFirst({
      where: { sourceTxHash: params.txHash, sourceChain: params.chainName },
    });
    if (existing?.status === 'CONFIRMED') {
      console.log(`[Bridge] Already processed: ${params.txHash}`);
      return;
    }

    // Decode Solana recipient from bytes32
    const solanaAddress = this.bytes32ToSolanaAddress(params.solanaRecipient);
    if (!solanaAddress) {
      console.error(`[Bridge] Invalid Solana recipient: ${params.solanaRecipient}`);
      return;
    }

    // Record pending deposit
    const record = await prisma.bridgeDeposit.upsert({
      where:  { sourceTxHash_sourceChain: { sourceTxHash: params.txHash, sourceChain: params.chainName } },
      update: { status: 'PENDING' },
      create: {
        sourceChain:    params.chainName,
        sourceTxHash:   params.txHash,
        solanaAddress:  solanaAddress,
        usdcAmount:     params.amount.toString(),
        depositId:      params.depositId.toString(),
        depositorEvm:   params.depositor,
        status:         'PENDING',
        createdAt:      new Date(),
      },
    });

    // Wait for finality
    await this.waitForFinality(params.chainName, params.blockNumber);

    // Daily limit check
    const today = new Date().toDateString();
    if (today !== this.lastResetDate) {
      this.dailyRelayed  = 0n;
      this.lastResetDate = today;
    }

    if (this.dailyRelayed + params.amount > AUTO_APPROVE_DAILY_LIMIT) {
      // Flag for manual review
      await prisma.bridgeDeposit.update({
        where: { id: record.id },
        data:  { status: 'MANUAL_REVIEW', flagReason: 'Daily auto-approve limit exceeded' },
      });
      const bus = await getEventBus();
      await bus.publish('bridge.manual_review', {
        depositId:  record.id,
        amount:     params.amount.toString(),
        chain:      params.chainName,
        occurredAt: new Date(),
      });
      return;
    }

    // Execute the Solana mint
    try {
      const solanaTxHash = await this.mintOnSolana(
        solanaAddress,
        params.amount,
        params.txHash,
      );

      this.dailyRelayed += params.amount;

      await prisma.bridgeDeposit.update({
        where: { id: record.id },
        data:  { status: 'CONFIRMED', solanaTxHash, confirmedAt: new Date() },
      });

      console.log(`[Bridge] Minted on Solana: ${solanaTxHash}`);

      const bus = await getEventBus();
      await bus.publish('bridge.deposit_confirmed', {
        depositId:     record.id,
        solanaAddress,
        usdcAmount:    params.amount.toString(),
        solanaTxHash,
        occurredAt:    new Date(),
      });
    } catch (err) {
      console.error(`[Bridge] Solana mint failed for ${params.txHash}:`, err);
      await prisma.bridgeDeposit.update({
        where: { id: record.id },
        data:  { status: 'FAILED', errorMessage: String(err) },
      });
    }
  }

  private async waitForFinality(chainName: string, blockNumber: number): Promise<void> {
    const provider    = this.providers[chainName];
    const requiredConfs = chainName === 'base' ? 12 : 20;

    return new Promise((resolve) => {
      const check = async () => {
        const current = await provider.getBlockNumber();
        if (current >= blockNumber + requiredConfs) {
          resolve();
        } else {
          setTimeout(check, 3_000);
        }
      };
      check();
    });
  }

  private async mintOnSolana(
    solanaRecipient: string,
    usdcAmount:      bigint,
    sourceEvmTxHash: string,
  ): Promise<string> {
    const recipient = new PublicKey(solanaRecipient);

    // Derive PDA accounts
    const [reservePda] = PublicKey.findProgramAddressSync(
      [Buffer.from('reserve')],
      RESERVE_PROGRAM_ID,
    );

    // VAA hash (Phase 1: SHA256 of EVM tx hash — not a real Wormhole VAA)
    const vaaHash = Buffer.from(
      sourceEvmTxHash.replace('0x', '').padStart(64, '0'),
      'hex',
    );
    const [vaaRecordPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('vaa'), vaaHash],
      RESERVE_PROGRAM_ID,
    );

    const recipientAta = await getAssociatedTokenAddress(ARENA_MINT, recipient);

    // Build receive_bridge_deposit instruction
    // Instruction discriminator (Anchor: sha256("global:receive_bridge_deposit")[0..8])
    const discriminator = Buffer.from([0xb4, 0x5c, 0x82, 0x1e, 0x3a, 0x90, 0x12, 0xf1]);

    const data = Buffer.concat([
      discriminator,
      this.u64ToLEBuffer(usdcAmount),
      recipient.toBuffer(),
      vaaHash,
    ]);

    const ix = new TransactionInstruction({
      programId: RESERVE_PROGRAM_ID,
      keys: [
        { pubkey: reservePda,         isSigner: false, isWritable: true },
        { pubkey: ARENA_MINT,         isSigner: false, isWritable: true },
        { pubkey: vaaRecordPda,       isSigner: false, isWritable: true },
        { pubkey: recipientAta,       isSigner: false, isWritable: true },
        { pubkey: recipient,          isSigner: false, isWritable: false },
        { pubkey: this.relayerKeypair.publicKey, isSigner: true, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID,   isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      data,
    });

    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(
      this.solana,
      tx,
      [this.relayerKeypair],
      { commitment: 'confirmed' },
    );

    return sig;
  }

  // ── Utilities ───────────────────────────────────────────────────────────────

  private bytes32ToSolanaAddress(bytes32Hex: string): string | null {
    try {
      const buf = Buffer.from(bytes32Hex.replace('0x', ''), 'hex');
      // Solana address is 32 bytes
      return new PublicKey(buf).toBase58();
    } catch {
      return null;
    }
  }

  private u64ToLEBuffer(value: bigint): Buffer {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(value);
    return buf;
  }
}
