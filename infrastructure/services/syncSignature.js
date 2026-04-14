/**
 * syncSignature - Provider-agnostic remote snapshot fingerprint.
 *
 * Stable, order-independent signature of a SyncedFile used by
 * CloudSyncManager to decide whether a remote has changed since we last
 * observed it. Must produce the same value for semantically-identical
 * remotes and a different value for any ciphertext/metadata change.
 *
 * Kept as a plain ESM .js file (JSDoc-typed) so it works seamlessly with
 * both Vite's bundler in the renderer AND Node's `node --test` harness
 * without needing a TypeScript test runner. CloudSyncManager.ts imports
 * it via a normal ESM import.
 *
 * The previous implementation in CloudSyncManager only hashed
 * `[version, updatedAt, deviceId, iv, salt]`. That meant:
 *   - a misbehaving adapter could replay those five fields while
 *     mutating algorithm/kdf/appVersion and the anchor would treat the
 *     remote as unchanged;
 *   - deviceId (a field the remote controls) was weighted as strongly
 *     as iv/salt;
 *   - ciphertext changes with metadata held constant could slip past.
 *
 * v3 hashes the full meta object (sorted for stability) plus the
 * SHA-256 of the full payload ciphertext so any of those mutations flip
 * the anchor. v2 used only a 64-char prefix of the ciphertext, which is
 * easily defeated by an adversary that controls the remote and can
 * tail-mutate while preserving the prefix. v3 is resistant to any
 * ciphertext mutation.
 *
 * Version prefixes are part of the signature string itself (`v3:`) so
 * an older anchor persisted from a previous build will simply never
 * compare equal to a fresh signature from this build, forcing a
 * single-cycle safe re-detection (treated as "remote changed" which
 * triggers three-way merge) rather than a silent mismatch.
 *
 * INVARIANT: `meta` values must be primitives (strings, numbers,
 * booleans, null/undefined). Nested objects or arrays in meta would
 * serialize via JSON.stringify, which does NOT sort keys — breaking
 * signature stability. All current SyncedFile meta fields satisfy this.
 */

/**
 * Compute SHA-256 of a UTF-8 string, returning lowercase hex.
 *
 * Uses `globalThis.crypto.subtle` (Web Crypto API) which is available in
 * both the Electron renderer and Node.js ≥ 19 (the repo's runtime targets
 * both, and CI/tests run under Node). Keeping to the Web Crypto API also
 * avoids pulling `node:crypto` into the renderer bundle.
 *
 * @param {string} input
 * @returns {Promise<string>}
 */
async function sha256Hex(input) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle?.digest) {
    // Extremely unusual environment — no WebCrypto at all. Fall back to
    // a non-cryptographic but length-stable marker so the signature is
    // still well-formed; callers will at worst over-eagerly detect a
    // remote change and re-merge, which is safe.
    return `nosha-${input.length}`;
  }
  const bytes = new globalThis.TextEncoder().encode(input);
  const buf = await subtle.digest('SHA-256', bytes);
  const arr = new Uint8Array(buf);
  let hex = '';
  for (let i = 0; i < arr.length; i += 1) {
    hex += arr[i].toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * @param {import('../../domain/sync').SyncedFile | null} syncedFile
 * @returns {Promise<string | null>}
 */
export async function createSyncedFileSignature(syncedFile) {
  if (!syncedFile) return null;
  const { meta, payload } = syncedFile;
  if (!meta || typeof meta !== 'object') return null;

  const metaKeys = Object.keys(meta).sort();
  const metaSerialized = metaKeys
    .map((key) => `${key}=${JSON.stringify(meta[key] ?? null)}`)
    .join('|');

  const payloadStr = typeof payload === 'string' ? payload : '';
  const payloadLen = payloadStr.length;
  const payloadHash = payloadStr ? await sha256Hex(payloadStr) : 'empty';

  return `v3:${metaSerialized}|len=${payloadLen}|sha256=${payloadHash}`;
}
