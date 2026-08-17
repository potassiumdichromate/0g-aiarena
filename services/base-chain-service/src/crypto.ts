/**
 * Agent signing-key encryption.
 *
 * Deliberately NOT the same scheme as identity-service's custodial Solana
 * wallets (`aes-256-cbc`, key = the raw env string padded to 32 bytes). That
 * path predates this one and has two properties we cannot accept for a key
 * that carries settlement authority on Base:
 *
 *   1. CBC is unauthenticated — a tampered ciphertext decrypts to garbage
 *      rather than failing loudly, so corruption/tampering is silent.
 *   2. `KEY.padEnd(32, '0')` turns a short secret into a low-entropy AES key.
 *
 * Here: scrypt KDF (per-record random salt) + AES-256-GCM (authenticated).
 * Wrong key or tampered ciphertext throws on `decrypt`, it does not return
 * plausible bytes.
 *
 * Format: `v1:<salt>:<iv>:<authTag>:<ciphertext>`, all hex. The version prefix
 * exists so a future scheme change can be rolled out without a flag day.
 */

import * as crypto from 'node:crypto';

const SCHEME_VERSION = 'v1';
const SALT_BYTES = 16;
const IV_BYTES = 12; // 96-bit nonce — the GCM standard
const KEY_BYTES = 32;
const SCRYPT_COST = 2 ** 15; // N=32768: ~100ms, deliberately slow

function masterSecret(): string {
  const secret = process.env.AGENT_WALLET_ENCRYPTION_KEY;
  if (!secret) {
    throw new Error(
      'AGENT_WALLET_ENCRYPTION_KEY is not set. Generate one with: ' +
        'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  if (secret.length < 32) {
    throw new Error('AGENT_WALLET_ENCRYPTION_KEY must be at least 32 characters (64 hex chars recommended)');
  }
  return secret;
}

function deriveKey(salt: Buffer): Buffer {
  // maxmem must be raised above the 32MB default or scrypt throws at N=2^15.
  return crypto.scryptSync(masterSecret(), salt, KEY_BYTES, { N: SCRYPT_COST, maxmem: 128 * 1024 * 1024 });
}

/** Encrypt an agent private key (0x-prefixed hex) for storage at rest. */
export function encryptAgentKey(privateKey: string): string {
  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(salt), iv);
  const ciphertext = Buffer.concat([cipher.update(privateKey, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    SCHEME_VERSION,
    salt.toString('hex'),
    iv.toString('hex'),
    tag.toString('hex'),
    ciphertext.toString('hex'),
  ].join(':');
}

/** Reverse of `encryptAgentKey`. Throws if the key is wrong or the blob was tampered with. */
export function decryptAgentKey(encrypted: string): string {
  const parts = encrypted.split(':');
  if (parts.length !== 5) throw new Error('Malformed encrypted agent key');

  const [version, saltHex, ivHex, tagHex, ciphertextHex] = parts;
  if (version !== SCHEME_VERSION) throw new Error(`Unsupported key encryption scheme: ${version}`);

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    deriveKey(Buffer.from(saltHex, 'hex')),
    Buffer.from(ivHex, 'hex'),
  );
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));

  // .final() is what raises on a bad tag — that is the tamper/wrong-key signal.
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}

/** Fail fast at boot rather than on the first agent registration. */
export function assertEncryptionConfigured(): void {
  const probe = encryptAgentKey('0x' + '11'.repeat(32));
  if (decryptAgentKey(probe) !== '0x' + '11'.repeat(32)) {
    throw new Error('Agent key encryption self-test failed');
  }
}
