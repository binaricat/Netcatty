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
 * Sentinel error for a missing WebCrypto subtle digest — see
 * `sha256Hex` and `createSyncedFileSignature` for the fail-closed
 * handling.
 */
class SyncSignatureUnavailableError extends Error {
  constructor() {
    super('WebCrypto subtle.digest is unavailable; signature cannot be computed safely.');
    this.name = 'SyncSignatureUnavailableError';
  }
}

/**
 * Compute SHA-256 of a UTF-8 string, returning lowercase hex.
 *
 * Uses `globalThis.crypto.subtle` (Web Crypto API) which is available in
 * both the Electron renderer and Node.js ≥ 19 (the repo's runtime targets
 * both, and CI/tests run under Node). Keeping to the Web Crypto API also
 * avoids pulling `node:crypto` into the renderer bundle.
 *
 * Throws `SyncSignatureUnavailableError` when subtle.digest is missing.
 * Earlier revisions returned a length-only fallback string (`nosha-N`),
 * which would produce a short, truncation-trivial pseudo-signature that
 * an attacker controlling the remote could alias against a legitimate
 * v3 signature of the same length. Failing loudly here lets the caller
 * in `createSyncedFileSignature` return `null`, which routes through
 * the "unreadable remote → treat as changed → three-way merge or
 * surface decrypt error" path — strictly safer than a weak signature.
 *
 * @param {string} input
 * @returns {Promise<string>}
 */
async function sha256Hex(input) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle?.digest) {
    throw new SyncSignatureUnavailableError();
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

  // Serialize meta as a canonical JSON object with keys sorted. Earlier
  // versions joined `${key}=${JSON.stringify(...)}` with `|`, which left
  // the `=` separator unescaped: a future meta key containing `=` in its
  // name (or a string value that mimics the separator syntax) could
  // alias with a different key/value pair. JSON.stringify of a sorted
  // plain object is injection-proof because string values are quoted
  // and escaped by the serializer.
  const metaKeys = Object.keys(meta).sort();
  const canonicalMeta = {};
  for (const key of metaKeys) {
    canonicalMeta[key] = meta[key] ?? null;
  }
  const metaSerialized = JSON.stringify(canonicalMeta);

  const payloadStr = typeof payload === 'string' ? payload : '';
  const payloadLen = payloadStr.length;
  let payloadHash;
  try {
    payloadHash = payloadStr ? await sha256Hex(payloadStr) : 'empty';
  } catch (error) {
    if (error instanceof SyncSignatureUnavailableError) {
      // Fail closed: no signature → decideRemoteChanged's
      // `currentSignature === null` branch treats the remote as
      // "unreadable" and routes through three-way merge. That is the
      // safe behavior vs. a weak pseudo-signature that could silently
      // alias against another payload of the same length.
      return null;
    }
    throw error;
  }

  return `v3:${metaSerialized}|len=${payloadLen}|sha256=${payloadHash}`;
}
