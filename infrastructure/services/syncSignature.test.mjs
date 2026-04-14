import test from 'node:test';
import assert from 'node:assert/strict';

import { createSyncedFileSignature } from './syncSignature.js';

function makeSyncedFile(overrides = {}) {
  const meta = {
    version: 1,
    updatedAt: 1_700_000_000_000,
    deviceId: 'device-a',
    deviceName: 'Device A',
    appVersion: '1.0.0',
    iv: 'BASE64_IV',
    salt: 'BASE64_SALT',
    algorithm: 'AES-256-GCM',
    kdf: 'PBKDF2',
    kdfIterations: 600000,
    ...(overrides.meta || {}),
  };
  return {
    meta,
    payload: overrides.payload ?? 'CIPHERTEXTxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  };
}

test('null file produces null signature', async () => {
  assert.equal(await createSyncedFileSignature(null), null);
});

test('two identical files produce identical signatures', async () => {
  const a = makeSyncedFile();
  const b = makeSyncedFile();
  assert.equal(await createSyncedFileSignature(a), await createSyncedFileSignature(b));
});

test('signature is stable across meta key-insertion order', async () => {
  const canonical = makeSyncedFile();
  const shuffled = {
    meta: {
      kdf: 'PBKDF2',
      salt: 'BASE64_SALT',
      iv: 'BASE64_IV',
      appVersion: '1.0.0',
      deviceName: 'Device A',
      deviceId: 'device-a',
      updatedAt: 1_700_000_000_000,
      version: 1,
      algorithm: 'AES-256-GCM',
      kdfIterations: 600000,
    },
    payload: canonical.payload,
  };
  assert.equal(await createSyncedFileSignature(canonical), await createSyncedFileSignature(shuffled));
});

test('changing iv flips the signature', async () => {
  const a = makeSyncedFile();
  const b = makeSyncedFile({ meta: { iv: 'DIFFERENT_IV' } });
  assert.notEqual(await createSyncedFileSignature(a), await createSyncedFileSignature(b));
});

test('changing salt flips the signature', async () => {
  const a = makeSyncedFile();
  const b = makeSyncedFile({ meta: { salt: 'DIFFERENT_SALT' } });
  assert.notEqual(await createSyncedFileSignature(a), await createSyncedFileSignature(b));
});

test('changing updatedAt flips the signature', async () => {
  const a = makeSyncedFile();
  const b = makeSyncedFile({ meta: { updatedAt: 1_700_000_000_001 } });
  assert.notEqual(await createSyncedFileSignature(a), await createSyncedFileSignature(b));
});

test('changing algorithm flips the signature (v1 regression guard)', async () => {
  // The old signature only hashed version/updatedAt/deviceId/iv/salt — an
  // adapter could have changed algorithm/kdf while holding those constant.
  // v2+ must reject that.
  const a = makeSyncedFile({ meta: { algorithm: 'AES-256-GCM' } });
  const b = makeSyncedFile({ meta: { algorithm: 'ChaCha20-Poly1305' } });
  assert.notEqual(await createSyncedFileSignature(a), await createSyncedFileSignature(b));
});

test('changing kdf flips the signature (v1 regression guard)', async () => {
  const a = makeSyncedFile({ meta: { kdf: 'PBKDF2' } });
  const b = makeSyncedFile({ meta: { kdf: 'Argon2id' } });
  assert.notEqual(await createSyncedFileSignature(a), await createSyncedFileSignature(b));
});

test('changing appVersion flips the signature (v1 regression guard)', async () => {
  const a = makeSyncedFile({ meta: { appVersion: '1.0.0' } });
  const b = makeSyncedFile({ meta: { appVersion: '2.0.0' } });
  assert.notEqual(await createSyncedFileSignature(a), await createSyncedFileSignature(b));
});

test('changing payload ciphertext flips the signature even when meta matches', async () => {
  // Critical: a malicious or buggy adapter could replay meta while swapping
  // the ciphertext. v2+ must treat the payload as load-bearing.
  const a = makeSyncedFile({ payload: 'AAA' + 'x'.repeat(60) });
  const b = makeSyncedFile({ payload: 'BBB' + 'x'.repeat(60) });
  assert.notEqual(await createSyncedFileSignature(a), await createSyncedFileSignature(b));
});

test('changing payload length flips the signature (truncation guard)', async () => {
  // v3 hashes the full ciphertext — any length difference flips the signature.
  const prefix = 'x'.repeat(64);
  const a = makeSyncedFile({ payload: prefix });
  const b = makeSyncedFile({ payload: `${prefix}extra` });
  assert.notEqual(await createSyncedFileSignature(a), await createSyncedFileSignature(b));
});

test('tail-mutation of a long ciphertext flips the signature (v2 prefix-replay guard)', async () => {
  // v2 only hashed the first 64 chars of the ciphertext. An adversary with
  // write access to the remote could preserve the prefix and mutate only the
  // tail, producing a signature collision. v3 hashes the full ciphertext and
  // must catch tail mutations even when prefix + length are preserved.
  const prefix = 'x'.repeat(64);
  const tailA = 'AAAAAAAAAAAAAAAA';
  const tailB = 'BBBBBBBBBBBBBBBB';
  const a = makeSyncedFile({ payload: `${prefix}${tailA}` });
  const b = makeSyncedFile({ payload: `${prefix}${tailB}` });
  assert.notEqual(await createSyncedFileSignature(a), await createSyncedFileSignature(b));
});

test('deviceId alone is not sufficient to match (metadata weighted properly)', async () => {
  // Both share deviceId but differ on iv — must not alias.
  const a = makeSyncedFile({ meta: { deviceId: 'same', iv: 'IV_A' } });
  const b = makeSyncedFile({ meta: { deviceId: 'same', iv: 'IV_B' } });
  assert.notEqual(await createSyncedFileSignature(a), await createSyncedFileSignature(b));
});

test('missing optional meta fields hash as null rather than throwing', async () => {
  const partial = {
    meta: {
      version: 1,
      updatedAt: 1_700_000_000_000,
      deviceId: 'device',
      appVersion: '1.0.0',
      iv: 'IV',
      salt: 'S',
      algorithm: 'AES-256-GCM',
      kdf: 'PBKDF2',
      // deviceName and kdfIterations omitted intentionally
    },
    payload: 'short',
  };
  const sig = await createSyncedFileSignature(partial);
  assert.equal(typeof sig, 'string');
  assert.ok(sig.startsWith('v3:'));
});

test('file with non-string payload produces signature with len=0', async () => {
  // Defensive: if an adapter somehow yields a non-string payload, we still
  // generate a well-formed signature rather than crashing.
  const weird = { meta: makeSyncedFile().meta, payload: null };
  const sig = await createSyncedFileSignature(weird);
  assert.ok(sig);
  assert.ok(sig.includes('len=0'));
  assert.ok(sig.includes('sha256='));
});

test('signature contains a 64-char hex SHA-256 segment', async () => {
  // Lock in the hash algorithm choice so a future regression to prefix-hashing
  // is caught by this unit test.
  const file = makeSyncedFile();
  const sig = await createSyncedFileSignature(file);
  assert.ok(sig);
  const match = sig.match(/sha256=([a-f0-9]+)/);
  assert.ok(match, `expected sha256=<hex> in signature, got ${sig}`);
  assert.equal(match[1].length, 64);
});

test('v2-format anchor string does not equal a v3 signature', async () => {
  // Migration guard: if a user's localStorage carries a v2-prefixed anchor
  // from a previous build, comparing against a fresh v3 signature must flip
  // to "remote changed" so we re-observe rather than treating a stale anchor
  // as authoritative.
  const file = makeSyncedFile();
  const v3 = await createSyncedFileSignature(file);
  const v2Like = String(v3).replace(/^v3:/, 'v2:').replace(/sha256=[a-f0-9]+$/, 'head=xxxxxxxxxxxxxxxx');
  assert.notEqual(v3, v2Like);
});

test('missing WebCrypto subtle → signature is null (fail-closed, no weak fallback)', async () => {
  // Earlier revisions returned `nosha-<length>` when subtle.digest was
  // unavailable. That fallback was length-only, so an adversary
  // controlling the remote could trivially produce a payload whose
  // weak pseudo-signature equals a legitimate v3 signature of the
  // same length. Failing to `null` routes decideRemoteChanged into the
  // "unreadable remote → treat as changed → three-way merge" path,
  // which is strictly safer.
  //
  // `globalThis.crypto` is a read-only getter in Node, so we override
  // the `subtle` property on the existing object rather than
  // reassigning the whole binding.
  const subtleDescriptor = Object.getOwnPropertyDescriptor(globalThis.crypto, 'subtle');
  Object.defineProperty(globalThis.crypto, 'subtle', {
    configurable: true,
    get() {
      return undefined;
    },
  });
  try {
    const sig = await createSyncedFileSignature(makeSyncedFile());
    assert.equal(sig, null, 'missing subtle must not produce a weak fallback string');
  } finally {
    if (subtleDescriptor) {
      Object.defineProperty(globalThis.crypto, 'subtle', subtleDescriptor);
    } else {
      delete globalThis.crypto.subtle;
    }
  }
});
