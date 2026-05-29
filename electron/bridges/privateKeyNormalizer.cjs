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

  // We can only rescue PKCS#8 keys, which Node's crypto can read.
  if (!PKCS8_HEADER_RE.test(privateKey)) {
    return { privateKey, passphrase, converted: false };
  }

  const encrypted = privateKey.includes("-----BEGIN ENCRYPTED PRIVATE KEY-----");

  let keyObject;
  try {
    keyObject = crypto.createPrivateKey(
      passphrase ? { key: privateKey, passphrase } : privateKey,
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
  PrivateKeyPassphraseError,
  UnsupportedPrivateKeyError,
};
