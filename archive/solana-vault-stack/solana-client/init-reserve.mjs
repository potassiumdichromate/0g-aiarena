/**
 * One-time script to call initialize_reserve on the arena-reserve Anchor program.
 * Run: node scripts/init-reserve.mjs
 *
 * Program: 5BzJy7xd1MuUfg5aRGohUgZTwCP4VgQ7YnrLmavaN2BG (devnet)
 */

import { Connection, Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction } from '@solana/spl-token';
import { AnchorProvider, Program, Wallet, BN } from '@coral-xyz/anchor';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import bs58 from 'bs58';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────────────────────

const RESERVE_PROGRAM_ID  = new PublicKey('5BzJy7xd1MuUfg5aRGohUgZTwCP4VgQ7YnrLmavaN2BG');
const ARENA_MINT          = new PublicKey('Egz4KxaLkoCP7d3wb8qE2qtFFBKe2Ha3c11UBjoitr7d');

// Devnet test tokens (created 2026-05-10)
const USDC_MINT_DEVNET    = new PublicKey('6DnLV68ueFS1p36DW2ptcBVLMCnjPGAJrZ1RHzkgUw7J');
const USDT_MINT_DEVNET    = new PublicKey('HF2WSuyjqHMYmCHQgyXFMWra6E2VFaLcnhS645BthRr2');

const RPC_URL = 'https://api.devnet.solana.com';

// Load authority keypair from Solana CLI config
const keypairPath = `${process.env.HOME || process.env.USERPROFILE}/.config/solana/id.json`;
const rawKeypair  = JSON.parse(readFileSync(keypairPath, 'utf-8'));
const authority   = Keypair.fromSecretKey(Uint8Array.from(rawKeypair));

console.log('Authority:', authority.publicKey.toBase58());

// ── Connection & Provider ─────────────────────────────────────────────────────

const connection = new Connection(RPC_URL, 'confirmed');
const wallet     = new Wallet(authority);
const provider   = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });

// ── Derive PDAs ───────────────────────────────────────────────────────────────

const [reservePda, reserveBump] = PublicKey.findProgramAddressSync(
  [Buffer.from('reserve')],
  RESERVE_PROGRAM_ID,
);

const [usdcVaultPda] = PublicKey.findProgramAddressSync(
  [Buffer.from('usdc_vault')],
  RESERVE_PROGRAM_ID,
);

const [usdtVaultPda] = PublicKey.findProgramAddressSync(
  [Buffer.from('usdt_vault')],
  RESERVE_PROGRAM_ID,
);

console.log('Reserve PDA:  ', reservePda.toBase58());
console.log('USDC Vault:   ', usdcVaultPda.toBase58());
console.log('USDT Vault:   ', usdtVaultPda.toBase58());
console.log('Reserve Bump: ', reserveBump);

// ── Check if already initialized ─────────────────────────────────────────────

const existing = await connection.getAccountInfo(reservePda);
if (existing) {
  console.log('\n✅ Reserve PDA already exists! Already initialized.');
  console.log('   Data length:', existing.data.length);
  process.exit(0);
}

// ── Build instruction manually (no IDL needed) ────────────────────────────────
// Anchor instruction discriminator: sha256("global:initialize_reserve")[0..8]

import { createHash } from 'crypto';

function getDiscriminator(name) {
  const hash = createHash('sha256').update(`global:${name}`).digest();
  return hash.slice(0, 8);
}

const { TransactionInstruction, Transaction, sendAndConfirmTransaction } = await import('@solana/web3.js');

const discriminator = getDiscriminator('initialize_reserve');

// Encode bump as u8 (1 byte little-endian)
const bumpBuffer = Buffer.alloc(1);
bumpBuffer.writeUInt8(reserveBump, 0);

const instructionData = Buffer.concat([discriminator, bumpBuffer]);

// Account metas for initialize_reserve:
// 0. reserve            (init PDA)         — writable, not signer
// 1. arena_mint         (existing mint)     — not mut, not signer
// 2. usdc_mint          (existing mint)     — not mut, not signer
// 3. usdt_mint          (existing mint)     — not mut, not signer
// 4. usdc_vault         (init token acct)   — writable, not signer
// 5. usdt_vault         (init token acct)   — writable, not signer
// 6. treasury           (wallet)            — not mut, not signer
// 7. authority          (payer + signer)    — writable, signer
// 8. token_program
// 9. system_program
// 10. rent

const keys = [
  { pubkey: reservePda,        isSigner: false, isWritable: true  },
  { pubkey: ARENA_MINT,        isSigner: false, isWritable: false },
  { pubkey: USDC_MINT_DEVNET,  isSigner: false, isWritable: false },
  { pubkey: USDT_MINT_DEVNET,  isSigner: false, isWritable: false },
  { pubkey: usdcVaultPda,      isSigner: false, isWritable: true  },
  { pubkey: usdtVaultPda,      isSigner: false, isWritable: true  },
  { pubkey: authority.publicKey, isSigner: false, isWritable: false }, // treasury
  { pubkey: authority.publicKey, isSigner: true,  isWritable: true  }, // authority/payer
  { pubkey: TOKEN_PROGRAM_ID,   isSigner: false, isWritable: false },
  { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
];

const ix = new TransactionInstruction({
  programId: RESERVE_PROGRAM_ID,
  keys,
  data: instructionData,
});

const tx = new Transaction().add(ix);
tx.feePayer = authority.publicKey;
tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

console.log('\nSending initialize_reserve transaction...');
try {
  const sig = await sendAndConfirmTransaction(connection, tx, [authority], {
    commitment: 'confirmed',
    skipPreflight: false,
  });
  console.log('\n✅ initialize_reserve SUCCESS!');
  console.log('   Signature:', sig);
  console.log('   Explorer: https://explorer.solana.com/tx/' + sig + '?cluster=devnet');
} catch (err) {
  console.error('\n❌ Transaction failed:', err.message);
  if (err.logs) {
    console.error('Program logs:');
    err.logs.forEach(l => console.error(' ', l));
  }
}
