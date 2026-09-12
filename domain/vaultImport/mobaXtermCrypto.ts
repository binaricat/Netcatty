const AES_SBOX = Uint8Array.from([
  0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
  0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
  0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
  0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
  0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
  0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
  0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
  0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
  0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
  0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
  0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
  0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
  0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
  0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
  0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
  0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16,
]);

const AES_RCON = Uint8Array.from([
  0x00, 0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36,
]);

const SHA512_K = [
  0x428a2f98d728ae22n, 0x7137449123ef65cdn, 0xb5c0fbcfec4d3b2fn, 0xe9b5dba58189dbbcn,
  0x3956c25bf348b538n, 0x59f111f1b605d019n, 0x923f82a4af194f9bn, 0xab1c5ed5da6d8118n,
  0xd807aa98a3030242n, 0x12835b0145706fben, 0x243185be4ee4b28cn, 0x550c7dc3d5ffb4e2n,
  0x72be5d74f27b896fn, 0x80deb1fe3b1696b1n, 0x9bdc06a725c71235n, 0xc19bf174cf692694n,
  0xe49b69c19ef14ad2n, 0xefbe4786384f25e3n, 0x0fc19dc68b8cd5b5n, 0x240ca1cc77ac9c65n,
  0x2de92c6f592b0275n, 0x4a7484aa6ea6e483n, 0x5cb0a9dcbd41fbd4n, 0x76f988da831153b5n,
  0x983e5152ee66dfabn, 0xa831c66d2db43210n, 0xb00327c898fb213fn, 0xbf597fc7beef0ee4n,
  0xc6e00bf33da88fc2n, 0xd5a79147930aa725n, 0x06ca6351e003826fn, 0x142929670a0e6e70n,
  0x27b70a8546d22ffcn, 0x2e1b21385c26c926n, 0x4d2c6dfc5ac42aedn, 0x53380d139d95b3dfn,
  0x650a73548baf63den, 0x766a0abb3c77b2a8n, 0x81c2c92e47edaee6n, 0x92722c851482353bn,
  0xa2bfe8a14cf10364n, 0xa81a664bbc423001n, 0xc24b8b70d0f89791n, 0xc76c51a30654be30n,
  0xd192e819d6ef5218n, 0xd69906245565a910n, 0xf40e35855771202an, 0x106aa07032bbd1b8n,
  0x19a4c116b8d2d0c8n, 0x1e376c085141ab53n, 0x2748774cdf8eeb99n, 0x34b0bcb5e19b48a8n,
  0x391c0cb3c5c95a63n, 0x4ed8aa4ae3418acbn, 0x5b9cca4f7763e373n, 0x682e6ff3d6b2b8a3n,
  0x748f82ee5defb2fcn, 0x78a5636f43172f60n, 0x84c87814a1f0ab72n, 0x8cc702081a6439ecn,
  0x90befffa23631e28n, 0xa4506cebde82bde9n, 0xbef9a3f7b2c67915n, 0xc67178f2e372532bn,
  0xca273eceea26619cn, 0xd186b8c721c0c207n, 0xeada7dd6cde0eb1en, 0xf57d4f7fee6ed178n,
  0x06f067aa72176fban, 0x0a637dc5a2c898a6n, 0x113f9804bef90daen, 0x1b710b35131c471bn,
  0x28db77f523047d84n, 0x32caab7b40c72493n, 0x3c9ebe0a15c9bebcn, 0x431d67c49c100d4cn,
  0x4cc5d4becb3e42b6n, 0x597f299cfc657e2an, 0x5fcb6fab3ad6faecn, 0x6c44198c4a475817n,
];

const MASK64 = 0xffffffffffffffffn;
const WEAK_KEY_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz+/";

const utf8Encode = (value: string): Uint8Array => new TextEncoder().encode(value);

const latin1Encode = (value: string): Uint8Array => {
  const out = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) out[i] = value.charCodeAt(i) & 0xff;
  return out;
};

const rotl32 = (value: number, n: number): number => ((value << n) | (value >>> (32 - n))) >>> 0;

const subWord = (value: number): number => (
  (AES_SBOX[value >>> 24] << 24)
  | (AES_SBOX[(value >>> 16) & 0xff] << 16)
  | (AES_SBOX[(value >>> 8) & 0xff] << 8)
  | AES_SBOX[value & 0xff]
) >>> 0;

const expandAes256Key = (key: Uint8Array): Uint32Array => {
  const w = new Uint32Array(60);
  for (let i = 0; i < 8; i++) {
    w[i] = (
      (key[i * 4] << 24)
      | (key[i * 4 + 1] << 16)
      | (key[i * 4 + 2] << 8)
      | key[i * 4 + 3]
    ) >>> 0;
  }
  for (let i = 8; i < 60; i++) {
    let temp = w[i - 1];
    if (i % 8 === 0) {
      temp = (subWord(rotl32(temp, 8)) ^ (AES_RCON[i / 8] << 24)) >>> 0;
    } else if (i % 8 === 4) {
      temp = subWord(temp);
    }
    w[i] = (w[i - 8] ^ temp) >>> 0;
  }
  return w;
};

const xtime = (value: number): number => ((value << 1) ^ ((value & 0x80) !== 0 ? 0x1b : 0)) & 0xff;

const aesEncryptBlockWithRoundKeys = (roundKeys: Uint32Array, block: Uint8Array): Uint8Array => {
  const state = new Uint8Array(block);
  const addRoundKey = (round: number) => {
    for (let c = 0; c < 4; c++) {
      const word = roundKeys[round * 4 + c];
      const offset = c * 4;
      state[offset] ^= word >>> 24;
      state[offset + 1] ^= (word >>> 16) & 0xff;
      state[offset + 2] ^= (word >>> 8) & 0xff;
      state[offset + 3] ^= word & 0xff;
    }
  };
  const subBytes = () => {
    for (let i = 0; i < 16; i++) state[i] = AES_SBOX[state[i]];
  };
  const shiftRows = () => {
    const row1 = [state[1], state[5], state[9], state[13]];
    state[1] = row1[1];
    state[5] = row1[2];
    state[9] = row1[3];
    state[13] = row1[0];
    const row2 = [state[2], state[6], state[10], state[14]];
    state[2] = row2[2];
    state[6] = row2[3];
    state[10] = row2[0];
    state[14] = row2[1];
    const row3 = [state[3], state[7], state[11], state[15]];
    state[3] = row3[3];
    state[7] = row3[0];
    state[11] = row3[1];
    state[15] = row3[2];
  };
  const mixColumns = () => {
    for (let c = 0; c < 4; c++) {
      const offset = c * 4;
      const a0 = state[offset];
      const a1 = state[offset + 1];
      const a2 = state[offset + 2];
      const a3 = state[offset + 3];
      state[offset] = (xtime(a0) ^ xtime(a1) ^ a1 ^ a2 ^ a3) & 0xff;
      state[offset + 1] = (a0 ^ xtime(a1) ^ xtime(a2) ^ a2 ^ a3) & 0xff;
      state[offset + 2] = (a0 ^ a1 ^ xtime(a2) ^ xtime(a3) ^ a3) & 0xff;
      state[offset + 3] = (xtime(a0) ^ a0 ^ a1 ^ a2 ^ xtime(a3)) & 0xff;
    }
  };

  addRoundKey(0);
  for (let round = 1; round < 14; round++) {
    subBytes();
    shiftRows();
    mixColumns();
    addRoundKey(round);
  }
  subBytes();
  shiftRows();
  addRoundKey(14);
  return state;
};

const aesEncryptBlock = (key: Uint8Array, block: Uint8Array): Uint8Array => (
  aesEncryptBlockWithRoundKeys(expandAes256Key(key), block)
);

const aesCfb8Decrypt = (key: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array): Uint8Array => {
  const roundKeys = expandAes256Key(key);
  const shift = new Uint8Array(iv);
  const out = new Uint8Array(ciphertext.length);
  for (let i = 0; i < ciphertext.length; i++) {
    const encrypted = aesEncryptBlockWithRoundKeys(roundKeys, shift);
    out[i] = ciphertext[i] ^ encrypted[0];
    shift.copyWithin(0, 1);
    shift[15] = ciphertext[i];
  }
  return out;
};

const rotr64 = (value: bigint, n: bigint): bigint => (
  ((value >> n) | (value << (64n - n))) & MASK64
);

export const sha512 = (message: Uint8Array): Uint8Array => {
  const bitLen = BigInt(message.length) * 8n;
  const padLen = (256 - ((message.length + 17) % 128)) % 128;
  const total = message.length + 1 + padLen + 16;
  const buf = new Uint8Array(total);
  buf.set(message);
  buf[message.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setBigUint64(total - 16, bitLen >> 64n, false);
  view.setBigUint64(total - 8, bitLen & MASK64, false);

  let h0 = 0x6a09e667f3bcc908n;
  let h1 = 0xbb67ae8584caa73bn;
  let h2 = 0x3c6ef372fe94f82bn;
  let h3 = 0xa54ff53a5f1d36f1n;
  let h4 = 0x510e527fade682d1n;
  let h5 = 0x9b05688c2b3e6c1fn;
  let h6 = 0x1f83d9abfb41bd6bn;
  let h7 = 0x5be0cd19137e2179n;

  const w = new Array<bigint>(80);
  for (let offset = 0; offset < total; offset += 128) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getBigUint64(offset + i * 8, false);
    }
    for (let i = 16; i < 80; i++) {
      const s0 = rotr64(w[i - 15], 1n) ^ rotr64(w[i - 15], 8n) ^ (w[i - 15] >> 7n);
      const s1 = rotr64(w[i - 2], 19n) ^ rotr64(w[i - 2], 61n) ^ (w[i - 2] >> 6n);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) & MASK64;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let i = 0; i < 80; i++) {
      const S1 = rotr64(e, 14n) ^ rotr64(e, 18n) ^ rotr64(e, 41n);
      const ch = (e & f) ^ ((~e) & g);
      const temp1 = (h + S1 + ch + SHA512_K[i] + w[i]) & MASK64;
      const S0 = rotr64(a, 28n) ^ rotr64(a, 34n) ^ rotr64(a, 39n);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) & MASK64;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) & MASK64;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) & MASK64;
    }
    h0 = (h0 + a) & MASK64;
    h1 = (h1 + b) & MASK64;
    h2 = (h2 + c) & MASK64;
    h3 = (h3 + d) & MASK64;
    h4 = (h4 + e) & MASK64;
    h5 = (h5 + f) & MASK64;
    h6 = (h6 + g) & MASK64;
    h7 = (h7 + h) & MASK64;
  }

  const digest = new Uint8Array(64);
  const out = new DataView(digest.buffer);
  out.setBigUint64(0, h0, false);
  out.setBigUint64(8, h1, false);
  out.setBigUint64(16, h2, false);
  out.setBigUint64(24, h3, false);
  out.setBigUint64(32, h4, false);
  out.setBigUint64(40, h5, false);
  out.setBigUint64(48, h6, false);
  out.setBigUint64(56, h7, false);
  return digest;
};

const decodeBase64 = (input: string, altChars = false): Uint8Array => {
  const normalized = (altChars ? input.replaceAll("@", "+").replaceAll("_", "/") : input)
    .replace(/\s+/g, "");
  if (!normalized) return new Uint8Array();
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(padded)) return new Uint8Array();
  try {
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return new Uint8Array();
  }
};

const rotateWeakKey = (key: Uint8Array): void => {
  const last = key[key.length - 1];
  key.copyWithin(1, 0, key.length - 1);
  key[0] = last;
};

const repeatToLength = (value: string, minLength: number): string => {
  if (!value) return value;
  let out = value;
  while (out.length < minLength) out += out;
  return out;
};

const craftWeakKey = (keySpace: string[]): Uint8Array => {
  const key = latin1Encode("0d5e9n1348/U2+67");
  for (let i = 0; i < key.length; i++) {
    const source = keySpace[(i + 1) % keySpace.length];
    const b = source.charCodeAt(i);
    if (!Number.isFinite(b)) continue;
    if (!key.includes(b) && WEAK_KEY_ALPHABET.includes(String.fromCharCode(b))) {
      key[i] = b;
    }
  }
  return key;
};

export const craftMobaSessionPKey = (sessionP: string): Uint8Array => {
  const s = repeatToLength(sessionP, 20);
  return craftWeakKey([s.toUpperCase(), s.toUpperCase(), s.toLowerCase(), s.toLowerCase()]);
};

export const craftMobaConnectionKey = (
  sysUsername: string,
  sysHostname: string,
  connUsername: string,
  connHostname: string,
): Uint8Array => {
  const s1 = repeatToLength(sysUsername + sysHostname, 20);
  const s2 = repeatToLength(connUsername + connHostname, 20);
  return craftWeakKey([s1.toUpperCase(), s2.toUpperCase(), s1.toLowerCase(), s2.toLowerCase()]);
};

export const decryptMobaWeakCipher = (ciphertext: string, key: Uint8Array): Uint8Array | null => {
  const filtered: number[] = [];
  for (let i = 0; i < ciphertext.length; i++) {
    const code = ciphertext.charCodeAt(i);
    if (key.includes(code)) filtered.push(code);
  }
  if (filtered.length === 0 || filtered.length % 2 !== 0) return null;
  const working = new Uint8Array(key);
  const plaintext = new Uint8Array(filtered.length / 2);
  for (let i = 0; i < filtered.length; i += 2) {
    const low = working.indexOf(filtered[i]);
    rotateWeakKey(working);
    const high = working.indexOf(filtered[i + 1]);
    rotateWeakKey(working);
    if (low < 0 || high < 0) return null;
    plaintext[i / 2] = ((high << 4) + low) & 0xff;
  }
  return plaintext;
};

export const decodeMobaPlaintext = (bytes: Uint8Array | null): string | null => {
  if (!bytes || bytes.length === 0) return null;
  const nul = bytes.indexOf(0);
  // AES-CFB is unauthenticated. A wrong key can inject an interior NUL and leave
  // a short printable prefix (e.g. "M)8%"). Only a trailing NUL pad is a C string.
  let slice = bytes;
  if (nul === 0) return null;
  if (nul > 0) {
    for (let i = nul; i < bytes.length; i++) {
      if (bytes[i] !== 0) return null;
    }
    slice = bytes.subarray(0, nul);
  }
  if (slice.length === 0) return null;
  for (const value of slice) {
    if (value < 0x20 && value !== 0x09) return null;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(slice);
  } catch {
    return null;
  }
};

const decryptMasterPasswordCipher = (ciphertext: string, masterPassword: string): Uint8Array | null => {
  const key = sha512(utf8Encode(masterPassword)).subarray(0, 32);
  if (ciphertext.startsWith("_@") && ciphertext.length >= 20) {
    const iv = latin1Encode(ciphertext.slice(2, 18));
    const body = decodeBase64(ciphertext, true).subarray(15);
    if (body.length === 0) return null;
    return aesCfb8Decrypt(key, iv, body);
  }
  const standard = decodeBase64(ciphertext);
  if (standard.length === 0) return null;
  const iv = aesEncryptBlock(key, new Uint8Array(16));
  return aesCfb8Decrypt(key, iv, standard);
};

export interface MobaStoredSecretInput {
  ciphertext: string;
  masterPassword?: string;
  sessionP?: string;
  sysUsername?: string;
  sysHostname?: string;
  connUsername?: string;
  connHostname?: string;
}

export const decryptMobaStoredSecret = (input: MobaStoredSecretInput): string | null => {
  const ciphertext = input.ciphertext.trim();
  if (!ciphertext) return null;

  if (input.masterPassword) {
    return decodeMobaPlaintext(decryptMasterPasswordCipher(ciphertext, input.masterPassword));
  }

  if (input.connUsername && input.connHostname && input.sysUsername && input.sysHostname) {
    const weak = decryptMobaWeakCipher(
      ciphertext,
      craftMobaConnectionKey(
        input.sysUsername,
        input.sysHostname,
        input.connUsername,
        input.connHostname,
      ),
    );
    const decoded = decodeMobaPlaintext(weak);
    if (decoded) return decoded;
  }

  if (input.sessionP) {
    return decodeMobaPlaintext(decryptMobaWeakCipher(ciphertext, craftMobaSessionPKey(input.sessionP)));
  }

  return null;
};
