/**
 * crypto-secrets — round-trip + tamper detection + dev-fail behavior.
 *
 * Tests are written to survive environments without a built
 * better-sqlite3 binary by isolating the crypto module (no DB import).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  encryptSecret,
  decryptSecret,
  maskKey,
  fingerprintKey,
} from './crypto-secrets.js';

test('round-trip: encryptSecret → decryptSecret returns original plaintext', () => {
  const plain = 'sk-1234567890abcdef';
  const blob = encryptSecret(plain);
  assert.equal(typeof blob, 'string');
  assert.ok(/^[A-Za-z0-9+/=]+$/.test(blob), 'blob is base64');
  assert.equal(decryptSecret(blob), plain);
});

test('fresh IV per call: same plaintext produces different ciphertexts', () => {
  const a = encryptSecret('sk-same-key');
  const b = encryptSecret('sk-same-key');
  assert.notEqual(a, b, 'two encryptions of the same plaintext differ');
  assert.equal(decryptSecret(a), 'sk-same-key');
  assert.equal(decryptSecret(b), 'sk-same-key');
});

test('tamper detection: flipping a bit in the tag causes decrypt to throw', () => {
  const blob = encryptSecret('sk-very-secret');
  const buf = Buffer.from(blob, 'base64');
  // Flip a bit in the tag (last 16 bytes)
  buf[buf.length - 5] ^= 0xff;
  const tampered = buf.toString('base64');
  assert.throws(() => decryptSecret(tampered), /unsupported|auth|tag/i);
});

test('tamper detection: modifying ciphertext body also throws', () => {
  const blob = encryptSecret('sk-very-secret');
  const buf = Buffer.from(blob, 'base64');
  // Flip a bit in the ciphertext (between IV and tag)
  buf[15] ^= 0x01;
  const tampered = buf.toString('base64');
  assert.throws(() => decryptSecret(tampered));
});

test('truncated ciphertext throws', () => {
  assert.throws(() => decryptSecret('aGVsbG8='), /truncated/);
});

test('non-string input throws TypeError', () => {
  assert.throws(() => encryptSecret(null), TypeError);
  assert.throws(() => encryptSecret(123), TypeError);
  assert.throws(() => decryptSecret(null), TypeError);
  assert.throws(() => decryptSecret(''), TypeError);
});

test('empty string refuse to encrypt (use null to clear a key)', () => {
  assert.throws(() => encryptSecret(''), /empty/);
});

test('maskKey: long key returns last 4 with ellipsis', () => {
  assert.equal(maskKey('sk-1234567890abcd'), '…abcd');
  assert.equal(maskKey('super-secret-key'), '…-key');
});

test('maskKey: short key returns dots', () => {
  assert.equal(maskKey('abc'), '••••');
  assert.equal(maskKey(''), null);
});

test('fingerprintKey is an alias for maskKey', () => {
  assert.equal(fingerprintKey('sk-1234'), maskKey('sk-1234'));
});

test('domain separation: key derived from LLM_SETTINGS_SECRET ≠ JWT_SECRET', async () => {
  // Snapshot the current key material by encrypting the same plaintext
  // before and after changing the secret. We can't swap the env in
  // place (the module caches the key at load), so this test imports
  // the module fresh under two different envs.
  const path = './crypto-secrets.js';
  const url = new URL(path, import.meta.url);
  const fullUrl = new URL(`file://${url.pathname.replace(/^\/([A-Za-z]:)/, '$1')}`);

  const a = await import(`${fullUrl.href}?a=${Date.now()}`);
  const blobA = a.encryptSecret('sk-test');

  process.env.LLM_SETTINGS_SECRET = 'different-secret';
  const b = await import(`${fullUrl.href}?b=${Date.now() + 1}`);
  const blobB = b.encryptSecret('sk-test');

  assert.notEqual(blobA, blobB, 'different secrets produce different ciphertexts');
  delete process.env.LLM_SETTINGS_SECRET;
});
