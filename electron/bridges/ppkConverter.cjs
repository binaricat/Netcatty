/**
 * Convert PuTTY PPK private keys into unencrypted OpenSSH PEM.
 *
 * ssh2 only parses PPK v2 RSA/DSA (`PuTTY-User-Key-File-2: ssh-rsa|ssh-dss`).
 * Encrypted Ed25519/ECDSA keys and all PPK v3 files therefore fail even with
 * the correct passphrase. We decrypt the PPK ourselves and emit OpenSSH PEM
 * that ssh2 already understands.
 *
 * Format: https://the.earth.li/~sgtatham/putty/0.83/htmldoc/AppendixC.html
 */

const {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  argon2Sync,
} = require("node:crypto");

const PPK_HEADER_RE = /^\s*PuTTY-User-Key-File-([23]):\s*(\S+)\s*$/m;
const AES_BLOCK = 16;
const AES_KEY_LEN = 32;
const PPK_V2_IV = Buffer.alloc(16, 0);
const PPK_V2_SEQ0 = Buffer.from([0, 0, 0, 0]);
const PPK_V2_SEQ1 = Buffer.from([0, 0, 0, 1]);
const PPK_V3_DERIVED_LEN = 80; // 32-byte key + 16-byte IV + 32-byte MAC key
const OPENSSH_MAGIC = Buffer.from("openssh-key-v1\0");
// Caps keep a crafted PPK from stalling the Electron main process. Defaults
// from current PuTTYgen (8 MiB, ~13-34 passes, parallelism 1) sit well inside.
const ARGON2_MIN_MEMORY_KIB = 8;
const ARGON2_MAX_MEMORY_KIB = 65536;
const ARGON2_MIN_PASSES = 1;
const ARGON2_MAX_PASSES = 128;
const ARGON2_MIN_PARALLELISM = 1;
const ARGON2_MAX_PARALLELISM = 4;
const ARGON2_MIN_SALT_BYTES = 8;
const ARGON2_MAX_SALT_BYTES = 64;

const SUPPORTED_TYPES = new Set([
  "ssh-ed25519",
  "ssh-rsa",
  "ssh-dss",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
]);

function isPpkPrivateKey(text) {
  return typeof text === "string" && PPK_HEADER_RE.test(text);
}

function passphraseBytes(passphrase) {
  if (passphrase == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(passphrase)) return passphrase;
  return Buffer.from(String(passphrase), "utf8");
}

function writeU32(value) {
  const buf = Buffer.allocUnsafe(4);
  buf.writeUInt32BE(value);
  return buf;
}

function writeBytes(buf) {
  return Buffer.concat([writeU32(buf.length), buf]);
}

function writeString(value) {
  return writeBytes(Buffer.from(value, "utf8"));
}

function readString(buf, offset) {
  if (offset + 4 > buf.length) return undefined;
  const length = buf.readUInt32BE(offset);
  const start = offset + 4;
  const end = start + length;
  if (end > buf.length) return undefined;
  return { value: buf.subarray(start, end), next: end };
}

function readRequiredString(buf, offset, label) {
  const field = readString(buf, offset);
  if (!field) {
    throw new Error(`Malformed PPK ${label}`);
  }
  return field;
}

function wrapBase64(buf, width = 64) {
  const raw = buf.toString("base64");
  const lines = [];
  for (let i = 0; i < raw.length; i += width) {
    lines.push(raw.slice(i, i + width));
  }
  return lines;
}

function parsePpk(text) {
  const lines = String(text).replace(/^\uFEFF/, "").split(/\r?\n/);
  while (lines.length && lines[0].trim() === "") lines.shift();
  const header = PPK_HEADER_RE.exec(lines[0] || "");
  if (!header) return null;

  const version = Number(header[1]);
  const type = header[2];
  let index = 1;

  const readHeader = (name) => {
    const line = lines[index++];
    if (line == null) {
      throw new Error(`Truncated PPK: missing ${name}`);
    }
    const match = new RegExp(`^${name}:\\s*(.*)$`).exec(line);
    if (!match) {
      throw new Error(`Malformed PPK: expected ${name}`);
    }
    return match[1];
  };

  const readBase64Block = (count) => {
    const chunk = lines.slice(index, index + count);
    if (chunk.length !== count) {
      throw new Error("Truncated PPK key data");
    }
    index += count;
    return Buffer.from(chunk.join(""), "base64");
  };

  const encryption = readHeader("Encryption");
  const comment = readHeader("Comment");
  const publicLines = Number(readHeader("Public-Lines"));
  if (!Number.isInteger(publicLines) || publicLines < 1) {
    throw new Error("Malformed PPK public key");
  }
  const publicBlob = readBase64Block(publicLines);

  let kdf;
  if (version === 3 && encryption !== "none") {
    kdf = {
      name: readHeader("Key-Derivation"),
      memory: Number(readHeader("Argon2-Memory")),
      passes: Number(readHeader("Argon2-Passes")),
      parallelism: Number(readHeader("Argon2-Parallelism")),
      saltHex: readHeader("Argon2-Salt"),
    };
  }

  const privateLines = Number(readHeader("Private-Lines"));
  if (!Number.isInteger(privateLines) || privateLines < 1) {
    throw new Error("Malformed PPK private key");
  }
  const privateBlob = readBase64Block(privateLines);
  const mac = readHeader("Private-MAC").trim().toLowerCase();

  return { version, type, encryption, comment, publicBlob, privateBlob, mac, kdf };
}

function deriveV2Keys(passphrase) {
  const material = Buffer.concat([
    createHash("sha1").update(PPK_V2_SEQ0).update(passphrase).digest(),
    createHash("sha1").update(PPK_V2_SEQ1).update(passphrase).digest(),
  ]);
  return {
    cipherKey: material.subarray(0, AES_KEY_LEN),
    iv: PPK_V2_IV,
    macKey: createHash("sha1").update("putty-private-key-file-mac-key").update(passphrase).digest(),
    macAlgo: "sha1",
  };
}

function inRange(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

function parseArgon2Salt(saltHex) {
  if (typeof saltHex !== "string" || !/^[0-9a-fA-F]+$/.test(saltHex) || saltHex.length % 2 !== 0) {
    throw new Error("Malformed PPK Argon2 salt");
  }
  const salt = Buffer.from(saltHex, "hex");
  if (salt.length < ARGON2_MIN_SALT_BYTES || salt.length > ARGON2_MAX_SALT_BYTES) {
    throw new Error("Malformed PPK Argon2 salt");
  }
  return salt;
}

function assertArgon2WorkFactors(kdf) {
  if (!inRange(kdf.memory, ARGON2_MIN_MEMORY_KIB, ARGON2_MAX_MEMORY_KIB)
      || !inRange(kdf.passes, ARGON2_MIN_PASSES, ARGON2_MAX_PASSES)
      || !inRange(kdf.parallelism, ARGON2_MIN_PARALLELISM, ARGON2_MAX_PARALLELISM)) {
    throw new Error(
      `PPK Argon2 parameters exceed supported limits ` +
        `(memory ${ARGON2_MIN_MEMORY_KIB}-${ARGON2_MAX_MEMORY_KIB} KiB, ` +
        `passes ${ARGON2_MIN_PASSES}-${ARGON2_MAX_PASSES}, ` +
        `parallelism ${ARGON2_MIN_PARALLELISM}-${ARGON2_MAX_PARALLELISM})`,
    );
  }
}

function deriveV3Keys(passphrase, encryption, kdf) {
  if (encryption === "none") {
    // Unencrypted PPK v3 uses HMAC-SHA256 with an empty key. Confirmed against
    // PuTTYgen 0.85 and the SshAgentLib ed25519 v3-none fixture.
    return { cipherKey: null, iv: null, macKey: Buffer.alloc(0), macAlgo: "sha256" };
  }
  const algorithm = String(kdf?.name || "").toLowerCase();
  if (algorithm !== "argon2id" && algorithm !== "argon2i" && algorithm !== "argon2d") {
    throw new Error(`Unsupported PPK key derivation "${kdf?.name}"`);
  }
  if (!kdf) {
    throw new Error("Malformed PPK Argon2 parameters");
  }
  assertArgon2WorkFactors(kdf);
  const salt = parseArgon2Salt(kdf.saltHex);
  if (typeof argon2Sync !== "function") {
    throw new Error("PPK_V3_ARGON2_UNAVAILABLE");
  }
  const derived = argon2Sync(algorithm, {
    message: passphrase,
    nonce: salt,
    parallelism: kdf.parallelism,
    tagLength: PPK_V3_DERIVED_LEN,
    memory: kdf.memory,
    passes: kdf.passes,
  });
  return {
    cipherKey: derived.subarray(0, AES_KEY_LEN),
    iv: derived.subarray(AES_KEY_LEN, AES_KEY_LEN + AES_BLOCK),
    macKey: derived.subarray(AES_KEY_LEN + AES_BLOCK),
    macAlgo: "sha256",
  };
}

function aes256Cbc(blob, key, iv, decrypt) {
  const fn = decrypt ? createDecipheriv : createCipheriv;
  const cipher = fn("aes-256-cbc", key, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(blob), cipher.final()]);
}

function macPayload({ type, encryption, comment, publicBlob, privateBlob }) {
  return Buffer.concat([
    writeString(type),
    writeString(encryption),
    writeString(comment),
    writeBytes(publicBlob),
    writeBytes(privateBlob),
  ]);
}

function verifyMac(parsed, keys) {
  const expected = createHmac(keys.macAlgo, keys.macKey)
    .update(macPayload(parsed))
    .digest("hex");
  return expected === parsed.mac;
}

function buildOpenSshPrivate({ publicBlob, privateInner, comment }) {
  const check = randomBytes(4);
  let inner = Buffer.concat([
    check,
    check,
    privateInner,
    writeString(comment || ""),
  ]);
  const padLen = (8 - (inner.length % 8)) % 8;
  if (padLen) {
    const pad = Buffer.allocUnsafe(padLen);
    for (let i = 0; i < padLen; i++) pad[i] = i + 1;
    inner = Buffer.concat([inner, pad]);
  }

  const blob = Buffer.concat([
    OPENSSH_MAGIC,
    writeString("none"),
    writeString("none"),
    writeBytes(Buffer.alloc(0)),
    writeU32(1),
    writeBytes(publicBlob),
    writeBytes(inner),
  ]);

  const body = wrapBase64(blob, 70).join("\n");
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

function ed25519PrivateInner(publicBlob, privateBlob) {
  const pubType = readRequiredString(publicBlob, 0, "public key type");
  const pubKey = readRequiredString(publicBlob, pubType.next, "public key");
  const seedField = readRequiredString(privateBlob, 0, "Ed25519 seed");
  if (pubKey.value.length !== 32 || seedField.value.length !== 32) {
    throw new Error("Malformed PPK Ed25519 key");
  }
  return Buffer.concat([
    writeString("ssh-ed25519"),
    writeBytes(pubKey.value),
    writeBytes(Buffer.concat([seedField.value, pubKey.value])),
  ]);
}

function rsaPrivateInner(publicBlob, privateBlob) {
  const pubType = readRequiredString(publicBlob, 0, "public key type");
  const e = readRequiredString(publicBlob, pubType.next, "RSA e");
  const n = readRequiredString(publicBlob, e.next, "RSA n");
  const d = readRequiredString(privateBlob, 0, "RSA d");
  const p = readRequiredString(privateBlob, d.next, "RSA p");
  const q = readRequiredString(privateBlob, p.next, "RSA q");
  const iqmp = readRequiredString(privateBlob, q.next, "RSA iqmp");
  return Buffer.concat([
    writeString("ssh-rsa"),
    writeBytes(n.value),
    writeBytes(e.value),
    writeBytes(d.value),
    writeBytes(iqmp.value),
    writeBytes(p.value),
    writeBytes(q.value),
  ]);
}

function dssPrivateInner(publicBlob, privateBlob) {
  const pubType = readRequiredString(publicBlob, 0, "public key type");
  const p = readRequiredString(publicBlob, pubType.next, "DSA p");
  const q = readRequiredString(publicBlob, p.next, "DSA q");
  const g = readRequiredString(publicBlob, q.next, "DSA g");
  const y = readRequiredString(publicBlob, g.next, "DSA y");
  const x = readRequiredString(privateBlob, 0, "DSA x");
  return Buffer.concat([
    writeString("ssh-dss"),
    writeBytes(p.value),
    writeBytes(q.value),
    writeBytes(g.value),
    writeBytes(y.value),
    writeBytes(x.value),
  ]);
}

function ecdsaPrivateInner(type, publicBlob, privateBlob) {
  const curve = type.slice("ecdsa-sha2-".length);
  const pubType = readRequiredString(publicBlob, 0, "public key type");
  const curveName = readRequiredString(publicBlob, pubType.next, "ECDSA curve");
  const point = readRequiredString(publicBlob, curveName.next, "ECDSA point");
  const scalar = readRequiredString(privateBlob, 0, "ECDSA scalar");
  return Buffer.concat([
    writeString(type),
    writeBytes(curveName.value.length ? curveName.value : Buffer.from(curve, "utf8")),
    writeBytes(point.value),
    writeBytes(scalar.value),
  ]);
}

function privateInnerForType(type, publicBlob, privateBlob) {
  switch (type) {
    case "ssh-ed25519":
      return ed25519PrivateInner(publicBlob, privateBlob);
    case "ssh-rsa":
      return rsaPrivateInner(publicBlob, privateBlob);
    case "ssh-dss":
      return dssPrivateInner(publicBlob, privateBlob);
    case "ecdsa-sha2-nistp256":
    case "ecdsa-sha2-nistp384":
    case "ecdsa-sha2-nistp521":
      return ecdsaPrivateInner(type, publicBlob, privateBlob);
    default:
      throw new Error(`Unsupported PPK key type "${type}"`);
  }
}

/**
 * Convert a PPK private key to unencrypted OpenSSH PEM.
 *
 * @returns {{ privateKey: string, comment: string } | null}
 *   `null` when the text is not a PPK. Throws on decrypt / format errors.
 */
function convertPpkToOpenSsh(text, passphrase) {
  let parsed;
  try {
    parsed = parsePpk(text);
  } catch (err) {
    if (!isPpkPrivateKey(text)) return null;
    const fail = new Error(`Malformed PPK private key: ${err.message}`);
    fail.code = "ERR_PPK_MALFORMED";
    fail.cause = err;
    throw fail;
  }
  if (!parsed) return null;

  if (!SUPPORTED_TYPES.has(parsed.type)) {
    const err = new Error(
      `PuTTY keys of type "${parsed.type}" are not supported. ` +
        "Export an OpenSSH key from PuTTYgen and try again.",
    );
    err.code = "ERR_PPK_UNSUPPORTED_TYPE";
    throw err;
  }

  const encrypted = parsed.encryption !== "none";
  if (encrypted && parsed.encryption !== "aes256-cbc") {
    const err = new Error(`Unsupported PPK encryption "${parsed.encryption}"`);
    err.code = "ERR_PPK_UNSUPPORTED_CIPHER";
    throw err;
  }
  if (encrypted && (passphrase == null || passphraseBytes(passphrase).length === 0)) {
    const err = new Error("Encrypted PPK private key detected, but no passphrase given");
    err.code = "ERR_PPK_PASSPHRASE";
    throw err;
  }

  const secret = passphraseBytes(encrypted ? passphrase : "");
  let keys;
  try {
    keys = parsed.version === 3
      ? deriveV3Keys(secret, parsed.encryption, parsed.kdf)
      : deriveV2Keys(secret);
  } catch (err) {
    if (err && err.message === "PPK_V3_ARGON2_UNAVAILABLE") {
      const missing = new Error(
        "Encrypted PuTTY PPK v3 keys require Argon2, which is unavailable in this runtime.",
      );
      missing.code = "ERR_PPK_UNSUPPORTED_KDF";
      throw missing;
    }
    throw err;
  }

  let privateBlob = parsed.privateBlob;
  if (encrypted) {
    if (privateBlob.length % AES_BLOCK !== 0) {
      const err = new Error("Malformed encrypted PPK private key");
      err.code = "ERR_PPK_MALFORMED";
      throw err;
    }
    try {
      privateBlob = aes256Cbc(privateBlob, keys.cipherKey, keys.iv, true);
    } catch (err) {
      const fail = new Error("Could not decrypt the PPK private key with the provided passphrase");
      fail.code = "ERR_PPK_PASSPHRASE";
      fail.cause = err;
      throw fail;
    }
  }

  const decrypted = { ...parsed, privateBlob };
  if (!verifyMac(decrypted, keys)) {
    const err = new Error(
      encrypted
        ? "PPK private key integrity check failed -- bad passphrase?"
        : "PPK private key integrity check failed",
    );
    err.code = encrypted ? "ERR_PPK_PASSPHRASE" : "ERR_PPK_MALFORMED";
    throw err;
  }

  const privateInner = privateInnerForType(parsed.type, parsed.publicBlob, privateBlob);
  return {
    privateKey: buildOpenSshPrivate({
      publicBlob: parsed.publicBlob,
      privateInner,
      comment: parsed.comment,
    }),
    comment: parsed.comment,
  };
}

// Test helper: serialize an already-assembled PPK (public/private SSH blobs).
function serializePpk({
  version = 2,
  type,
  comment = "",
  publicBlob,
  privateBlob,
  passphrase,
  argon2 = {
    name: "Argon2id",
    memory: 8192,
    passes: 2,
    parallelism: 1,
  },
}) {
  const encryption = passphrase ? "aes256-cbc" : "none";
  const secret = passphraseBytes(passphrase || "");
  let kdf;
  let keys;
  let storedPrivate = privateBlob;

  if (version === 3) {
    if (encryption === "aes256-cbc") {
      kdf = {
        ...argon2,
        saltHex: randomBytes(16).toString("hex"),
      };
    }
    keys = deriveV3Keys(secret, encryption, kdf);
  } else {
    keys = deriveV2Keys(secret);
  }

  if (encryption === "aes256-cbc") {
    const padLen = (AES_BLOCK - (storedPrivate.length % AES_BLOCK)) % AES_BLOCK;
    if (padLen) {
      storedPrivate = Buffer.concat([storedPrivate, randomBytes(padLen)]);
    }
  }

  const mac = createHmac(keys.macAlgo, keys.macKey)
    .update(macPayload({ type, encryption, comment, publicBlob, privateBlob: storedPrivate }))
    .digest("hex");

  if (encryption === "aes256-cbc") {
    storedPrivate = aes256Cbc(storedPrivate, keys.cipherKey, keys.iv, false);
  }

  const publicLines = wrapBase64(publicBlob);
  const privateLines = wrapBase64(storedPrivate);
  const lines = [
    `PuTTY-User-Key-File-${version}: ${type}`,
    `Encryption: ${encryption}`,
    `Comment: ${comment}`,
    `Public-Lines: ${publicLines.length}`,
    ...publicLines,
  ];
  if (kdf) {
    lines.push(
      `Key-Derivation: ${kdf.name}`,
      `Argon2-Memory: ${kdf.memory}`,
      `Argon2-Passes: ${kdf.passes}`,
      `Argon2-Parallelism: ${kdf.parallelism}`,
      `Argon2-Salt: ${kdf.saltHex}`,
    );
  }
  lines.push(
    `Private-Lines: ${privateLines.length}`,
    ...privateLines,
    `Private-MAC: ${mac}`,
    "",
  );
  return lines.join("\n");
}

module.exports = {
  isPpkPrivateKey,
  convertPpkToOpenSsh,
  serializePpk,
};
