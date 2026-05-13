import type { KnownHost } from "./models";

const normalizeHost = (value: string) => value.trim().toLowerCase();

const sameKnownHostSelector = (a: KnownHost, b: KnownHost) =>
  normalizeHost(a.hostname) === normalizeHost(b.hostname) &&
  a.port === b.port &&
  a.keyType === b.keyType;

export const upsertKnownHost = (
  knownHosts: KnownHost[],
  incoming: KnownHost,
): KnownHost[] => {
  const idIndex = knownHosts.findIndex((existing) => existing.id === incoming.id);
  const index = idIndex !== -1
    ? idIndex
    : knownHosts.findIndex((existing) => sameKnownHostSelector(existing, incoming));

  if (index === -1) {
    return [...knownHosts, incoming];
  }

  const existing = knownHosts[index];
  const updated: KnownHost = {
    ...existing,
    ...incoming,
    id: existing.id,
    discoveredAt: existing.discoveredAt,
    convertedToHostId: existing.convertedToHostId ?? incoming.convertedToHostId,
    lastSeen: incoming.lastSeen ?? incoming.discoveredAt,
  };

  return [
    ...knownHosts.slice(0, index),
    updated,
    ...knownHosts.slice(index + 1),
  ];
};

const SSH_KEY_TYPE_PREFIX = /^(?:ssh-|ecdsa-|sk-)/;

const stripPadding = (value: string) => value.replace(/=+$/g, "");

// Pure-JS SHA-256 used to migrate stored knownHosts records on hydration.
// crypto.subtle is async and would force the migration through useEffect; for
// a one-shot read-and-rewrite of a typically-small list, the sync path keeps
// the call sites simple. Runs at most a handful of times per app start.
const sha256Bytes = (data: Uint8Array): Uint8Array => {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const length = data.length;
  const bitLength = BigInt(length) * 8n;
  const padded = new Uint8Array(((length + 9 + 63) >> 6) << 6);
  padded.set(data);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setBigUint64(padded.length - 8, bitLength, false);

  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const W = new Uint32Array(64);

  for (let chunk = 0; chunk < padded.length; chunk += 64) {
    for (let i = 0; i < 16; i += 1) W[i] = view.getUint32(chunk + i * 4, false);
    for (let i = 16; i < 64; i += 1) {
      const s0 = ((W[i - 15] >>> 7) | (W[i - 15] << 25)) ^ ((W[i - 15] >>> 18) | (W[i - 15] << 14)) ^ (W[i - 15] >>> 3);
      const s1 = ((W[i - 2] >>> 17) | (W[i - 2] << 15)) ^ ((W[i - 2] >>> 19) | (W[i - 2] << 13)) ^ (W[i - 2] >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i += 1) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + W[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + mj) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i += 1) outView.setUint32(i * 4, H[i], false);
  return out;
};

const base64Decode = (value: string): Uint8Array | null => {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
};

const base64Encode = (bytes: Uint8Array): string => {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
};

/**
 * Compute the SHA-256 base64 fingerprint (no padding, no SHA256: prefix) from
 * a stored `publicKey` field. Mirrors `fingerprintFromPublicKey` in
 * electron/bridges/hostKeyVerifier.cjs so renderer-side migration produces the
 * same value the verifier compares against at connect time.
 */
export const fingerprintFromPublicKey = (publicKey: string | undefined | null): string => {
  if (typeof publicKey !== "string") return "";
  const trimmed = publicKey.trim();
  if (!trimmed) return "";

  if (/^SHA256:/i.test(trimmed)) {
    return stripPadding(trimmed.replace(/^SHA256:/i, ""));
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length >= 2 && SSH_KEY_TYPE_PREFIX.test(parts[0])) {
    const bytes = base64Decode(parts[1]);
    if (bytes) return stripPadding(base64Encode(sha256Bytes(bytes)));
  }

  return stripPadding(trimmed);
};

const extractKeyTypeFromPublicKey = (publicKey: string | undefined | null): string => {
  if (typeof publicKey !== "string") return "";
  const first = publicKey.trim().split(/\s+/)[0] ?? "";
  return SSH_KEY_TYPE_PREFIX.test(first) ? first : "";
};

/**
 * Backfill missing `fingerprint` / `keyType` on a stored record so the host
 * verifier can match it without falling back to the brittle re-derivation
 * path. Returns the same reference when nothing changes so callers can skip
 * persistence writes and React re-renders.
 */
export const normalizeKnownHost = (knownHost: KnownHost): KnownHost => {
  const hasFingerprint = typeof knownHost.fingerprint === "string" && knownHost.fingerprint.length > 0;
  const hasKeyType = typeof knownHost.keyType === "string"
    && knownHost.keyType.length > 0
    && knownHost.keyType !== "unknown";

  if (hasFingerprint && hasKeyType) return knownHost;

  const derivedFingerprint = hasFingerprint
    ? knownHost.fingerprint!
    : fingerprintFromPublicKey(knownHost.publicKey);
  const derivedKeyType = hasKeyType
    ? knownHost.keyType
    : extractKeyTypeFromPublicKey(knownHost.publicKey);

  const fingerprintChanged = derivedFingerprint && derivedFingerprint !== knownHost.fingerprint;
  const keyTypeChanged = derivedKeyType && derivedKeyType !== knownHost.keyType;
  if (!fingerprintChanged && !keyTypeChanged) return knownHost;

  return {
    ...knownHost,
    fingerprint: fingerprintChanged ? derivedFingerprint : knownHost.fingerprint,
    keyType: keyTypeChanged ? derivedKeyType : knownHost.keyType,
  };
};

/**
 * Normalize a whole list. Returns the same array reference when no entries
 * needed migration so referential-equality consumers (React.memo, prop
 * comparisons in TerminalLayer) don't re-render on every hydration.
 */
export const normalizeKnownHosts = (knownHosts: KnownHost[]): KnownHost[] => {
  let changed = false;
  const next = knownHosts.map((entry) => {
    const normalized = normalizeKnownHost(entry);
    if (normalized !== entry) changed = true;
    return normalized;
  });
  return changed ? next : knownHosts;
};
