import test from 'node:test';
import assert from 'node:assert/strict';

// Set before any call, not before import: crypto.ts reads the secret lazily
// inside deriveKey(), so a static import is safe here.
process.env.AGENT_WALLET_ENCRYPTION_KEY ??= 'a'.repeat(64);

import { encryptAgentKey, decryptAgentKey, assertEncryptionConfigured } from '../src/crypto.js';

const SAMPLE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

test('round-trips an agent private key', () => {
  assert.equal(decryptAgentKey(encryptAgentKey(SAMPLE_KEY)), SAMPLE_KEY);
});

test('uses a fresh salt and IV per encryption', () => {
  // Identical plaintext must not produce identical ciphertext, or the store
  // leaks which agents share a key.
  assert.notEqual(encryptAgentKey(SAMPLE_KEY), encryptAgentKey(SAMPLE_KEY));
});

test('rejects a tampered ciphertext rather than returning garbage', () => {
  const parts = encryptAgentKey(SAMPLE_KEY).split(':');
  // Flip the final byte of the ciphertext.
  const ct = parts[4];
  parts[4] = ct.slice(0, -2) + (ct.slice(-2) === 'ff' ? '00' : 'ff');

  assert.throws(() => decryptAgentKey(parts.join(':')));
});

test('rejects a tampered auth tag', () => {
  const parts = encryptAgentKey(SAMPLE_KEY).split(':');
  parts[3] = parts[3].slice(0, -2) + (parts[3].slice(-2) === 'ff' ? '00' : 'ff');

  assert.throws(() => decryptAgentKey(parts.join(':')));
});

test('rejects an unknown scheme version', () => {
  const parts = encryptAgentKey(SAMPLE_KEY).split(':');
  parts[0] = 'v2';
  assert.throws(() => decryptAgentKey(parts.join(':')), /Unsupported key encryption scheme/);
});

test('rejects a malformed blob', () => {
  assert.throws(() => decryptAgentKey('not-a-real-blob'), /Malformed/);
});

test('fails to decrypt under a different master secret', () => {
  const blob = encryptAgentKey(SAMPLE_KEY);
  const original = process.env.AGENT_WALLET_ENCRYPTION_KEY;
  process.env.AGENT_WALLET_ENCRYPTION_KEY = 'b'.repeat(64);
  try {
    assert.throws(() => decryptAgentKey(blob));
  } finally {
    process.env.AGENT_WALLET_ENCRYPTION_KEY = original;
  }
});

test('self-test passes when configured', () => {
  assert.doesNotThrow(() => assertEncryptionConfigured());
});
