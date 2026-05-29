/**
 * Private key normalizer.
 *
 * ssh2's key parser only understands OpenSSH, legacy PKCS#1/SEC1
 * (`BEGIN RSA/DSA/EC PRIVATE KEY`) and PuTTY keys. It rejects PKCS#8
 * (`-----BEGIN PRIVATE KEY-----` / `-----BEGIN ENCRYPTED PRIVATE KEY-----`)
 * with "Unsupported key format", even though such keys are valid and accepted
 * by other clients (e.g. Termius). See issue #1139.
 *
 * Node's crypto can read PKCS#8 and re-export RSA/EC keys in the legacy PEM
 * forms ssh2 accepts, so we transparently convert them before handing the key
 * to ssh2. Ed25519 (and other) PKCS#8 keys have no legacy PEM representation
 * and surface a clear, actionable error instead of ssh2's opaque one.
 */

const crypto = require("node:crypto");
const { utils: sshUtils } = require("ssh2");

const PKCS8_HEADER_RE = /-----BEGIN (?:ENCRYPTED )?PRIVATE KEY-----/;

// Node asymmetricKeyType -> legacy PEM export type that ssh2 can parse.
const LEGACY_EXPORT_TYPE = {
  rsa: "pkcs1",
  ec: "sec1",
};

class PrivateKeyPassphraseError extends Error {
  constructor(message) {
    super(message || "Incorrect passphrase for private key");
    this.name = "PrivateKeyPassphraseError";
    this.code = "ERR_PRIVATE_KEY_PASSPHRASE";
  }
}

class UnsupportedPrivateKeyError extends Error {
  constructor(message) {
    super(message);
    this.name = "UnsupportedPrivateKeyError";
    this.code = "ERR_PRIVATE_KEY_UNSUPPORTED";
  }
}

// Matches a private-key PEM block by its BEGIN/END markers (which survive even
// when the surrounding newlines are lost), capturing the label and raw body.
const PEM_BLOCK_RE =
  /-----BEGIN ((?:RSA |DSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY)-----([\s\S]*?)-----END \1-----/;

/**
 * Rebuild clean PEM framing for a key whose text was mangled in transit —
 * newlines collapsed to spaces, turned into literal "\n", or lines indented.
 * Returns the repaired PEM, or null when it isn't a recoverable block.
 *
 * The base64 body is preserved byte-for-byte (only non-base64 characters are
 * stripped before re-wrapping), so this can never produce a different key.
 * Encrypted legacy PEM (Proc-Type / DEK-Info header lines inside the body) is
 * left alone — those lines aren't base64 and can't be safely re-wrapped.
 */
function repairMalformedPem(text) {
  // Newlines flattened into literal "\n" / "\r\n" escape sequences.
  const unescaped = text.replace(/\\r\\n|\\n|\\r/g, "\n");
  const match = PEM_BLOCK_RE.exec(unescaped);
  if (!match) return null;

  const label = match[1];
  const body = match[2];
  if (/Proc-Type:|DEK-Info:/i.test(body)) return null;

  const base64 = body.replace(/[^A-Za-z0-9+/=]/g, "");
  if (!base64) return null;

  const wrapped = base64.replace(/.{1,64}/g, "$&\n").trimEnd();
  return `-----BEGIN ${label}-----\n${wrapped}\n-----END ${label}-----\n`;
}

/**
 * Normalize a private key into a form ssh2 can parse.
 *
 * @param {string} privateKey - PEM private key contents.
 * @param {string} [passphrase] - Passphrase, if the key is encrypted.
 * @returns {{ privateKey: string, passphrase: string|undefined, converted: boolean }}
 * @throws {PrivateKeyPassphraseError} Encrypted PKCS#8 with a wrong/missing passphrase.
 * @throws {UnsupportedPrivateKeyError} PKCS#8 key whose type has no legacy PEM form (e.g. Ed25519).
 */
function normalizePrivateKeyForSsh2(privateKey, passphrase) {
  if (typeof privateKey !== "string" || privateKey.length === 0) {
    return { privateKey, passphrase, converted: false };
  }

  // If ssh2 already understands the key, leave it exactly as-is.
  const parsed = sshUtils.parseKey(privateKey, passphrase);
  if (parsed && !(parsed instanceof Error)) {
    return { privateKey, passphrase, converted: false };
  }

  // The key text may have been mangled before it reached us — newlines lost,
  // turned into literal "\n", or lines indented. Rebuild clean PEM framing and
  // retry; a repaired key also feeds cleanly into the PKCS#8 path below.
  const repaired = repairMalformedPem(privateKey);
  if (repaired && repaired !== privateKey) {
    const reparsed = sshUtils.parseKey(repaired, passphrase);
    if (reparsed && !(reparsed instanceof Error)) {
      return { privateKey: repaired, passphrase, converted: true };
    }
  }
  const candidate = repaired || privateKey;

  // We can only rescue PKCS#8 keys, which Node's crypto can read.
  if (!PKCS8_HEADER_RE.test(candidate)) {
    return { privateKey, passphrase, converted: false };
  }

  const encrypted = candidate.includes("-----BEGIN ENCRYPTED PRIVATE KEY-----");

  let keyObject;
  try {
    keyObject = crypto.createPrivateKey(
      passphrase ? { key: candidate, passphrase } : candidate,
    );
  } catch (err) {
    if (encrypted) {
      throw new PrivateKeyPassphraseError(
        "Could not decrypt the PKCS#8 private key with the provided passphrase",
      );
    }
    throw new UnsupportedPrivateKeyError(
      `Unable to read the PKCS#8 private key: ${err.message}. ` +
        "Convert it with `ssh-keygen -p -m PEM -f <key>` and try again.",
    );
  }

  const exportType = LEGACY_EXPORT_TYPE[keyObject.asymmetricKeyType];
  if (!exportType) {
    throw new UnsupportedPrivateKeyError(
      `Private keys of type "${keyObject.asymmetricKeyType}" in PKCS#8 format are not supported. ` +
        "Convert it to OpenSSH format with `ssh-keygen -p -f <key>` and try again.",
    );
  }

  const converted = keyObject.export({ type: exportType, format: "pem" }).toString();
  return { privateKey: converted, passphrase: undefined, converted: true };
}

module.exports = {
  normalizePrivateKeyForSsh2,
  repairMalformedPem,
  PrivateKeyPassphraseError,
  UnsupportedPrivateKeyError,
};
