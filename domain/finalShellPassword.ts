const JAVA_RANDOM_MULTIPLIER = 0x5deece66dn;
const JAVA_RANDOM_ADDEND = 0xbn;
const JAVA_RANDOM_MASK = (1n << 48n) - 1n;

class JavaRandom {
  private seed: bigint;

  constructor(seed: bigint) {
    this.seed = (BigInt.asIntN(64, seed) ^ JAVA_RANDOM_MULTIPLIER) & JAVA_RANDOM_MASK;
  }

  private next(bits: number): number {
    this.seed = (this.seed * JAVA_RANDOM_MULTIPLIER + JAVA_RANDOM_ADDEND) & JAVA_RANDOM_MASK;
    return Number(this.seed >> BigInt(48 - bits));
  }

  nextInt(bound: number): number {
    if ((bound & -bound) === bound) {
      return Math.floor((bound * this.next(31)) / 0x80000000);
    }
    let bits: number;
    let value: number;
    do {
      bits = this.next(31);
      value = bits % bound;
    } while (((bits - value + (bound - 1)) | 0) < 0);
    return value;
  }

  nextLong(): bigint {
    const high = BigInt.asIntN(32, BigInt(this.next(32)));
    const low = BigInt.asIntN(32, BigInt(this.next(32)));
    return BigInt.asIntN(64, (high << 32n) + low);
  }
}

const IP = [58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4, 62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8, 57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3, 61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7];
const FP = [40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31, 38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29, 36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27, 34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25];
const E = [32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17, 16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25, 24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1];
const P = [16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10, 2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25];
const PC1 = [57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60, 52, 44, 36, 63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 28, 20, 12, 4];
const PC2 = [14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10, 23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2, 41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48, 44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32];
const SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
const SBOXES = [
  [14,4,13,1,2,15,11,8,3,10,6,12,5,9,0,7,0,15,7,4,14,2,13,1,10,6,12,11,9,5,3,8,4,1,14,8,13,6,2,11,15,12,9,7,3,10,5,0,15,12,8,2,4,9,1,7,5,11,3,14,10,0,6,13],
  [15,1,8,14,6,11,3,4,9,7,2,13,12,0,5,10,3,13,4,7,15,2,8,14,12,0,1,10,6,9,11,5,0,14,7,11,10,4,13,1,5,8,12,6,9,3,2,15,13,8,10,1,3,15,4,2,11,6,7,12,0,5,14,9],
  [10,0,9,14,6,3,15,5,1,13,12,7,11,4,2,8,13,7,0,9,3,4,6,10,2,8,5,14,12,11,15,1,13,6,4,9,8,15,3,0,11,1,2,12,5,10,14,7,1,10,13,0,6,9,8,7,4,15,14,3,11,5,2,12],
  [7,13,14,3,0,6,9,10,1,2,8,5,11,12,4,15,13,8,11,5,6,15,0,3,4,7,2,12,1,10,14,9,10,6,9,0,12,11,7,13,15,1,3,14,5,2,8,4,3,15,0,6,10,1,13,8,9,4,5,11,12,7,2,14],
  [2,12,4,1,7,10,11,6,8,5,3,15,13,0,14,9,14,11,2,12,4,7,13,1,5,0,15,10,3,9,8,6,4,2,1,11,10,13,7,8,15,9,12,5,6,3,0,14,11,8,12,7,1,14,2,13,6,15,0,9,10,4,5,3],
  [12,1,10,15,9,2,6,8,0,13,3,4,14,7,5,11,10,15,4,2,7,12,9,5,6,1,13,14,0,11,3,8,9,14,15,5,2,8,12,3,7,0,4,10,1,13,11,6,4,3,2,12,9,5,15,10,11,14,1,7,6,0,8,13],
  [4,11,2,14,15,0,8,13,3,12,9,7,5,10,6,1,13,0,11,7,4,9,1,10,14,3,5,12,2,15,8,6,1,4,11,13,12,3,7,14,10,15,6,8,0,5,9,2,6,11,13,8,1,4,10,7,9,5,0,15,14,2,3,12],
  [13,2,8,4,6,15,11,1,10,9,3,14,5,0,12,7,1,15,13,8,10,3,7,4,12,5,6,11,0,14,9,2,7,11,4,1,9,12,14,2,0,6,10,13,15,3,5,8,2,1,14,7,4,10,8,13,15,12,9,0,3,5,6,11],
];

const permute = (value: bigint, inputBits: number, table: number[]): bigint => {
  let result = 0n;
  for (const position of table) {
    result = (result << 1n) | ((value >> BigInt(inputBits - position)) & 1n);
  }
  return result;
};

const bytesToBigInt = (bytes: Uint8Array): bigint => {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
};

const bigIntToBytes = (value: bigint, length: number): Uint8Array => {
  const result = new Uint8Array(length);
  for (let index = length - 1; index >= 0; index--) {
    result[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  return result;
};

const createSubkeys = (key: Uint8Array): bigint[] => {
  const selected = permute(bytesToBigInt(key), 64, PC1);
  let left = Number((selected >> 28n) & 0xfffffffn);
  let right = Number(selected & 0xfffffffn);
  return SHIFTS.map((shift) => {
    left = ((left << shift) | (left >>> (28 - shift))) & 0xfffffff;
    right = ((right << shift) | (right >>> (28 - shift))) & 0xfffffff;
    return permute((BigInt(left) << 28n) | BigInt(right), 56, PC2);
  });
};

const feistel = (right: number, subkey: bigint): number => {
  const expanded = permute(BigInt(right >>> 0), 32, E) ^ subkey;
  let output = 0;
  for (let box = 0; box < 8; box++) {
    const sixBits = Number((expanded >> BigInt(42 - box * 6)) & 0x3fn);
    const row = ((sixBits & 0x20) >> 4) | (sixBits & 1);
    const column = (sixBits >> 1) & 0xf;
    output = (output << 4) | SBOXES[box][row * 16 + column];
  }
  return Number(permute(BigInt(output >>> 0), 32, P));
};

const decryptDesBlock = (block: Uint8Array, subkeys: bigint[]): Uint8Array => {
  const initial = permute(bytesToBigInt(block), 64, IP);
  let left = Number((initial >> 32n) & 0xffffffffn);
  let right = Number(initial & 0xffffffffn);
  for (let round = 15; round >= 0; round--) {
    const next = (left ^ feistel(right, subkeys[round])) >>> 0;
    left = right;
    right = next;
  }
  return bigIntToBytes(permute((BigInt(right) << 32n) | BigInt(left), 64, FP), 8);
};

const add32 = (...values: number[]): number => values.reduce((sum, value) => (sum + value) >>> 0, 0);
const rotateLeft = (value: number, shift: number): number => ((value << shift) | (value >>> (32 - shift))) >>> 0;

const md5 = (input: Uint8Array): Uint8Array => {
  const bitLength = BigInt(input.length) * 8n;
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;
  for (let index = 0; index < 8; index++) padded[paddedLength - 8 + index] = Number((bitLength >> BigInt(index * 8)) & 0xffn);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const shifts = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
  const constants = Array.from({ length: 64 }, (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 0x100000000) >>> 0);

  for (let offset = 0; offset < padded.length; offset += 64) {
    const words = new Uint32Array(16);
    for (let index = 0; index < 16; index++) {
      const start = offset + index * 4;
      words[index] = padded[start] | (padded[start + 1] << 8) | (padded[start + 2] << 16) | (padded[start + 3] << 24);
    }
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let index = 0; index < 64; index++) {
      let f: number;
      let wordIndex: number;
      if (index < 16) {
        f = (b & c) | (~b & d);
        wordIndex = index;
      } else if (index < 32) {
        f = (d & b) | (~d & c);
        wordIndex = (5 * index + 1) % 16;
      } else if (index < 48) {
        f = b ^ c ^ d;
        wordIndex = (3 * index + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        wordIndex = (7 * index) % 16;
      }
      const previousD = d;
      d = c;
      c = b;
      b = add32(b, rotateLeft(add32(a, f, constants[index], words[wordIndex]), shifts[index]));
      a = previousD;
    }
    a0 = add32(a0, a);
    b0 = add32(b0, b);
    c0 = add32(c0, c);
    d0 = add32(d0, d);
  }

  const output = new Uint8Array(16);
  [a0, b0, c0, d0].forEach((word, wordIndex) => {
    for (let byte = 0; byte < 4; byte++) output[wordIndex * 4 + byte] = (word >>> (byte * 8)) & 0xff;
  });
  return output;
};

const signedByte = (value: number): bigint => BigInt(value > 127 ? value - 256 : value);

const decodeBase64 = (value: string): Uint8Array | undefined => {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) return undefined;
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const canonical = btoa(String.fromCharCode(...bytes));
    return canonical === value ? bytes : undefined;
  } catch {
    return undefined;
  }
};

const deriveKey = (head: Uint8Array): Uint8Array | undefined => {
  const divisor = new JavaRandom(signedByte(head[5])).nextInt(127);
  if (divisor === 0) return undefined;
  const random = new JavaRandom(BigInt.asIntN(64, 3680984568597093857n / BigInt(divisor)));
  const iterations = Number(signedByte(head[0]));
  for (let index = 0; index < iterations; index++) random.nextLong();
  const secondRandom = new JavaRandom(random.nextLong());
  const longs = [
    signedByte(head[4]),
    secondRandom.nextLong(),
    signedByte(head[7]),
    signedByte(head[3]),
    secondRandom.nextLong(),
    signedByte(head[1]),
    random.nextLong(),
    signedByte(head[2]),
  ];
  const source = new Uint8Array(64);
  longs.forEach((value, index) => source.set(bigIntToBytes(BigInt.asUintN(64, value), 8), index * 8));
  return md5(source).slice(0, 8);
};

export const decodeFinalShellPassword = (encoded: string): string | undefined => {
  const decoded = decodeBase64(encoded);
  if (!decoded || decoded.length < 16 || (decoded.length - 8) % 8 !== 0) return undefined;
  const key = deriveKey(decoded.slice(0, 8));
  if (!key) return undefined;
  const subkeys = createSubkeys(key);
  const ciphertext = decoded.slice(8);
  const plaintext = new Uint8Array(ciphertext.length);
  for (let offset = 0; offset < ciphertext.length; offset += 8) {
    plaintext.set(decryptDesBlock(ciphertext.slice(offset, offset + 8), subkeys), offset);
  }
  const padding = plaintext[plaintext.length - 1];
  if (padding < 1 || padding > 8) return undefined;
  for (let index = plaintext.length - padding; index < plaintext.length; index++) {
    if (plaintext[index] !== padding) return undefined;
  }
  try {
    const password = new TextDecoder("utf-8", { fatal: true }).decode(plaintext.slice(0, -padding));
    const hasControlCharacters = Array.from(password).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    });
    return password && !hasControlCharacters ? password : undefined;
  } catch {
    return undefined;
  }
};
