/**
 * Three-step on-chain initialization for the arena-reserve program.
 *
 * Step 1: initialize_reserve — creates the reserve state PDA
 * Step 2: initialize_usdc_vault — creates the USDC token vault PDA
 * Step 3: initialize_usdt_vault — creates the USDT token vault PDA
 *
 * Run from packages/solana-client:
 *   node init-reserve.cjs
 *
 * Prerequisites:
 *   - arena-reserve binary deployed at RESERVE_PROGRAM_ID (with Box<> stack fix)
 *   - Authority wallet funded with ≥ 3 SOL devnet
 */
'use strict';

const {
  Connection, Keypair, PublicKey, SystemProgram,
  SYSVAR_RENT_PUBKEY, TransactionInstruction, Transaction,
  sendAndConfirmTransaction,
} = require('@solana/web3.js');
const splToken = require('@solana/spl-token');
const { createHash } = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ── Config ────────────────────────────────────────────────────────────────────
const RESERVE_PROGRAM_ID = new PublicKey('5BzJy7xd1MuUfg5aRGohUgZTwCP4VgQ7YnrLmavaN2BG');
const ARENA_MINT         = new PublicKey('Egz4KxaLkoCP7d3wb8qE2qtFFBKe2Ha3c11UBjoitr7d');
const USDC_MINT          = new PublicKey('6DnLV68ueFS1p36DW2ptcBVLMCnjPGAJrZ1RHzkgUw7J');
const USDT_MINT          = new PublicKey('HF2WSuyjqHMYmCHQgyXFMWra6E2VFaLcnhS645BthRr2');
const TOKEN_PROGRAM_ID   = splToken.TOKEN_PROGRAM_ID;
const RPC_URL = 'https://api.devnet.solana.com';

// Load authority keypair
const keypairPath = path.join(os.homedir(), '.config', 'solana', 'id.json');
const rawKeypair  = JSON.parse(fs.readFileSync(keypairPath, 'utf-8'));
const authority   = Keypair.fromSecretKey(Uint8Array.from(rawKeypair));
console.log('Authority:', authority.publicKey.toBase58());

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

// ── Anchor discriminator ──────────────────────────────────────────────────────
function getDiscriminator(name) {
  return createHash('sha256').update(`global:${name}`).digest().slice(0, 8);
}

async function sendIx(connection, keys, data, label) {
  const ix = new TransactionInstruction({ programId: RESERVE_PROGRAM_ID, keys, data });
  const tx = new Transaction().add(ix);
  console.log(`\nSending ${label}...`);
  const sig = await sendAndConfirmTransaction(connection, tx, [authority], { commitment: 'confirmed' });
  console.log(`✅ ${label} SUCCESS!`);
  console.log(`   Signature: ${sig}`);
  console.log(`   Explorer: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const connection = new Connection(RPC_URL, 'confirmed');

  const balance = await connection.getBalance(authority.publicKey);
  console.log('Authority balance:', balance / 1e9, 'SOL');
  if (balance < 1e9) {
    console.error('❌ Need at least 1 SOL. Visit https://faucet.solana.com/ to get devnet SOL.');
    process.exit(1);
  }

  // ── Step 1: initialize_reserve ─────────────────────────────────────────────
  const existingReserve = await connection.getAccountInfo(reservePda);
  if (existingReserve) {
    console.log('\n✅ Reserve PDA already exists (', existingReserve.data.length, 'bytes)');
  } else {
    console.log('\nStep 1: Creating reserve state PDA...');

    const discriminator = getDiscriminator('initialize_reserve');
    const bumpBuffer    = Buffer.alloc(1);
    bumpBuffer.writeUInt8(reserveBump, 0);
    const data = Buffer.concat([discriminator, bumpBuffer]);

    // Accounts for InitializeReserve (simplified — no vault inits):
    // 0. reserve PDA       (init)     — writable
    // 1. arena_mint        (CHECK)    — read-only
    // 2. usdc_mint         (CHECK)    — read-only
    // 3. usdt_mint         (CHECK)    — read-only
    // 4. treasury          (CHECK)    — read-only
    // 5. authority         (signer)   — writable
    // 6. system_program               — read-only
    const keys = [
      { pubkey: reservePda,              isSigner: false, isWritable: true  },
      { pubkey: ARENA_MINT,              isSigner: false, isWritable: false },
      { pubkey: USDC_MINT,               isSigner: false, isWritable: false },
      { pubkey: USDT_MINT,               isSigner: false, isWritable: false },
      { pubkey: authority.publicKey,     isSigner: false, isWritable: false }, // treasury
      { pubkey: authority.publicKey,     isSigner: true,  isWritable: true  }, // authority/payer
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];

    try {
      await sendIx(connection, keys, data, 'initialize_reserve');
    } catch (err) {
      console.error('❌ initialize_reserve failed:', err.message);
      const logs = err.logs || [];
      if (logs.length) logs.forEach(l => console.error('  ', l));
      process.exit(1);
    }
  }

  // ── Step 2: initialize_usdc_vault ─────────────────────────────────────────
  const existingUsdcVault = await connection.getAccountInfo(usdcVaultPda);
  if (existingUsdcVault) {
    console.log('\n✅ USDC vault already exists (', existingUsdcVault.data.length, 'bytes)');
  } else {
    console.log('\nStep 2: Creating USDC vault PDA...');

    const data = getDiscriminator('initialize_usdc_vault');

    // Accounts for InitUsdcVault:
    // 0. reserve           (mut, has_one=authority)  — writable
    // 1. usdc_mint         (CHECK)                   — read-only
    // 2. usdc_vault        (init PDA)                — writable
    // 3. authority         (signer)                  — writable
    // 4. token_program
    // 5. system_program
    // 6. rent
    const keys = [
      { pubkey: reservePda,              isSigner: false, isWritable: true  },
      { pubkey: USDC_MINT,               isSigner: false, isWritable: false },
      { pubkey: usdcVaultPda,            isSigner: false, isWritable: true  },
      { pubkey: authority.publicKey,     isSigner: true,  isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID,        isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY,      isSigner: false, isWritable: false },
    ];

    try {
      await sendIx(connection, keys, data, 'initialize_usdc_vault');
    } catch (err) {
      console.error('❌ initialize_usdc_vault failed:', err.message);
      const logs = err.logs || [];
      if (logs.length) logs.forEach(l => console.error('  ', l));
      process.exit(1);
    }
  }

  // ── Step 3: initialize_usdt_vault ─────────────────────────────────────────
  const existingUsdtVault = await connection.getAccountInfo(usdtVaultPda);
  if (existingUsdtVault) {
    console.log('\n✅ USDT vault already exists (', existingUsdtVault.data.length, 'bytes)');
  } else {
    console.log('\nStep 3: Creating USDT vault PDA...');

    const data = getDiscriminator('initialize_usdt_vault');

    // Accounts for InitUsdtVault:
    // 0. reserve           (mut, has_one=authority)  — writable
    // 1. usdt_mint         (CHECK)                   — read-only
    // 2. usdt_vault        (init PDA)                — writable
    // 3. authority         (signer)                  — writable
    // 4. token_program
    // 5. system_program
    // 6. rent
    const keys = [
      { pubkey: reservePda,              isSigner: false, isWritable: true  },
      { pubkey: USDT_MINT,               isSigner: false, isWritable: false },
      { pubkey: usdtVaultPda,            isSigner: false, isWritable: true  },
      { pubkey: authority.publicKey,     isSigner: true,  isWritable: true  },
      { pubkey: TOKEN_PROGRAM_ID,        isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY,      isSigner: false, isWritable: false },
    ];

    try {
      await sendIx(connection, keys, data, 'initialize_usdt_vault');
    } catch (err) {
      console.error('❌ initialize_usdt_vault failed:', err.message);
      const logs = err.logs || [];
      if (logs.length) logs.forEach(l => console.error('  ', l));
      process.exit(1);
    }
  }

  console.log('\n🎉 Arena reserve fully initialized!');
  console.log('   Reserve PDA: ', reservePda.toBase58());
  console.log('   USDC Vault:  ', usdcVaultPda.toBase58());
  console.log('   USDT Vault:  ', usdtVaultPda.toBase58());
  console.log('\nNext step: transfer ARENA mint authority to reserve PDA so only the program can mint.');
  console.log(`  spl-token authorize ${ARENA_MINT.toBase58()} mint ${reservePda.toBase58()} --url devnet`);
}

main().catch(console.error);
