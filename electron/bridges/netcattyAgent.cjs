/**
 * Netcatty in-process SSH agent
 *
 * Implements ssh2's BaseAgent interface to support:
 * - OpenSSH certificate authentication (client cert + private key)
 */

const fs = require("node:fs");
const path = require("node:path");
const { BaseAgent } = require("ssh2/lib/agent.js");
const { parseKey } = require("ssh2/lib/protocol/keyParser.js");

const DEBUG_SSH = process.env.NETCATTY_SSH_DEBUG === "1";

// Debug logger (disabled by default)
const logFile = DEBUG_SSH
  ? path.join(require("os").tmpdir(), "netcatty-agent.log")
  : null;
const log = (msg, data) => {
  if (!DEBUG_SSH) return;
  const line = `[${new Date().toISOString()}] ${msg} ${data ? JSON.stringify(data) : ""}\n`;
  try { fs.appendFileSync(logFile, line); } catch { }
  console.log("[Agent]", msg, data || "");
};

function parseOpenSshKeyLine(line) {
  if (typeof line !== "string" || !line.trim()) throw new Error("Empty OpenSSH key line");

  // Normalize input: remove extra whitespace and join into single line
  // This handles cases where long certificates are wrapped across multiple lines
  const normalized = line.split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l)
    .join(" ");

  if (!normalized) throw new Error("Empty OpenSSH key line");

  // Match format: <type> <base64-blob> [comment]
  // Base64 blob may be very long (certificates can be 2000+ chars)
  // Allow spaces within base64 for cases where it was wrapped
  const m = /^\s*(\S+)\s+((?:[A-Za-z0-9+/=]\s*)+?)(?:\s+(.+?))?\s*$/.exec(normalized);

  if (!m) {
    // Fallback: try simpler pattern for single-line format
    const parts = normalized.split(/\s+/);
    if (parts.length >= 2) {
      const type = parts[0];

      // Determine if last part is comment or base64
      // Comments usually don't start with base64-valid chars at boundaries
      const lastPart = parts[parts.length - 1];
      const isLastBase64 = /^[A-Za-z0-9+/=]+$/.test(lastPart) && lastPart.length > 20;

      // If last part is base64, it's part of the blob; otherwise it's a comment
      const blobParts = isLastBase64 ? parts.slice(1) : parts.slice(1, -1);
      const comment = isLastBase64 ? "" : lastPart;

      if (blobParts.length === 0) {
        throw new Error("No base64 data found in OpenSSH key line");
      }

      try {
        const base64Str = blobParts.join("");
        const blob = Buffer.from(base64Str, "base64");
        log("Fallback parse success", { type, blobLength: blob.length, comment });
        return { type, blob, comment };
      } catch (e) {
        throw new Error(`Invalid base64 in OpenSSH key line: ${e.message}`);
      }
    }
    throw new Error("Invalid OpenSSH key line format");
  }

  const type = m[1];
  const base64Str = m[2].replace(/\s+/g, ""); // Remove any spaces from base64
  const blob = Buffer.from(base64Str, "base64");
  const comment = m[3] || "";
  return { type, blob, comment };
}

function buildCertificateIdentityKey({ certType, certBlob, comment, privateKey, passphrase }) {
  // Parse the actual private key to get the correct public key object
  if (!privateKey) throw new Error("privateKey required to build certificate identity");
  const key = parseKey(privateKey, passphrase);
  if (key instanceof Error) throw new Error(`Failed to parse private key: ${key.message}`);

  // Extract base key type from certificate type (e.g., ssh-rsa-cert-v01@openssh.com -> ssh-rsa)
  const baseType = certType.replace(/-cert-v0[01]@openssh\.com$/i, '');

  // CRITICAL: Determine modern certificate type for algorithm negotiation
  // OpenSSH servers require explicit signature algorithms (SHA-256/SHA-512, not generic SHA-1)
  // But we MUST NOT modify the certificate blob (would break CA signature)
  let modernCertType = certType;
  if (certType === 'ssh-rsa-cert-v01@openssh.com' && baseType === 'ssh-rsa') {
    // Prefer SHA-512 for RSA certificates (matches OpenSSH client default)
    modernCertType = 'rsa-sha2-512-cert-v01@openssh.com';
  }

  log("Private key parsed for certificate identity", {
    originalKeyType: key.type,
    originalCertType: certType,
    modernCertType: modernCertType,
    baseType: baseType,
    hasGetPublicSSH: !!key.getPublicSSH,
    originalPublicSSHLength: key.getPublicSSH ? key.getPublicSSH().length : 0,
    certBlobLength: certBlob.length,
    certBlobPreview: certBlob.slice(0, 40).toString('hex')
  });

  // STRATEGY: Set key.type to MODERN certificate type for algorithm name in USERAUTH_REQUEST
  // but return ORIGINAL unmodified certificate blob (to preserve CA signature)
  // Server will accept this because:
  // - Algorithm name in USERAUTH_REQUEST: rsa-sha2-512-cert-v01@openssh.com (what we claim to support)
  // - Certificate blob type field: ssh-rsa-cert-v01@openssh.com (original, CA-signed)
  // - Server knows these are compatible (both are RSA certs, just different hash algorithms)
  key.type = modernCertType;  // Use modern cert type as algorithm name
  key._baseType = baseType;
  key._originalCertType = certType;
  key._certType = modernCertType;
  key._signatureAlgo = modernCertType.includes('512') ? 'rsa-sha2-512' : 'rsa-sha2-256';
  key.comment = comment || key.comment;
  key.getPublicSSH = () => certBlob;  // Return ORIGINAL unmodified certificate blob
  // CRITICAL: Override sign() to ensure it returns signature algorithm, not cert type
  // ssh2's authPK needs the signature algorithm for constructing the signature blob
  // but key.type is the cert type. We need to provide the signature algorithm separately.
  const originalSign = key.sign.bind(key);
  key.sign = function (data, hash) {
    const sig = originalSign(data, hash);
    // Return signature with metadata for ssh2
    if (sig instanceof Error) return sig;
    // Attach signature algorithm as property for ssh2 to use
    const sigBuffer = Buffer.from(sig);
    sigBuffer._signatureAlgorithm = key._signatureAlgo;
    return sigBuffer;
  };
  log("Built certificate identity key", {
    finalType: key.type,
    finalBaseType: key._baseType,
    finalCertType: key._certType,
    finalPublicSSHLength: key.getPublicSSH().length,
  });

  return key;
}

function normalizeBaseTypeForConversion(type) {
  if (typeof type !== "string") return type;
  // ssh-rsa-cert-v01@openssh.com -> ssh-rsa, ecdsa-sha2-nistp256-cert-v01@openssh.com -> ecdsa-sha2-nistp256
  return type.replace(/-cert-v0[01]@openssh\.com$/i, "");
}

class NetcattyAgent extends BaseAgent {
  constructor(opts) {
    super();
    this._mode = opts.mode;
    this._key = null;
    this._meta = opts.meta;
    this._advertisedType = null;

    if (this._mode === "certificate") {
      const { certificate, privateKey, passphrase, label } = opts.meta || {};
      if (!certificate) throw new Error("Missing certificate");
      if (!privateKey) throw new Error("Missing privateKey for certificate auth");
      log("Parsing certificate", { certLength: certificate.length, label, hasPrivateKey: !!privateKey });
      try {
        const { type: certType, blob: certBlob } = parseOpenSshKeyLine(certificate);
        log("Certificate parsed successfully", {
          certType,
          blobLength: certBlob.length,
          blobPreview: certBlob.slice(0, 32).toString('hex')
        });
        this._key = buildCertificateIdentityKey({
          certType,
          certBlob,
          comment: label || "",
          privateKey,
          passphrase,
        });
        this._advertisedType = certType;  // Store original cert type for debugging

        // Cache parsed private key to avoid re-parsing on every sign() call
        const parsed = parseKey(privateKey, passphrase);
        if (parsed instanceof Error) throw parsed;
        this._parsedPrivateKey = Array.isArray(parsed) ? parsed[0] : parsed;

        log("Agent initialized successfully", {
          keyType: this._key.type,
          certType: certType,
          baseType: this._key._baseType,
        });
      } catch (err) {
        log("Certificate parse error", { error: err.message, stack: err.stack });
        throw err;
      }
    } else {
      throw new Error(`Unknown agent mode: ${opts.mode}`);
    }
  }

  getIdentities(cb) {
    log("getIdentities called", { mode: this._mode });
    // Debug: log key structure
    if (this._key) {
      const publicSSH = this._key.getPublicSSH ? this._key.getPublicSSH() : null;
      log("Returning key identity", {
        keyType: this._key.type,
        hasGetPublicSSH: !!this._key.getPublicSSH,
        publicSSHLength: publicSSH?.length,
        publicSSHPreview: publicSSH?.slice(0, 32).toString('hex'),
        keyComment: this._key.comment,
      });
    }
    cb(null, [this._key]);
  }

  sign(_pubKey, data, options, cb) {
    log("sign called", {
      mode: this._mode,
      dataLength: data?.length,
      advertisedType: this._advertisedType,
      options: options,
      hasPrivateKeyInMeta: !!this._meta?.privateKey,
      privateKeyLength: this._meta?.privateKey?.length,
    });
    if (typeof options === "function") {
      cb = options;
      options = undefined;
    }
    if (typeof cb !== "function") cb = () => { };

    (async () => {
      if (this._mode === "certificate") {
        // Use cached parsed private key (parsed once during construction)
        const key = this._parsedPrivateKey;
        if (!key) {
          throw new Error("Missing parsed private key — agent not properly initialized");
        }
        log("Using cached private key", { keyType: key.type });

        // For certificates, key.type is now the base type (e.g., 'ssh-rsa')
        // ssh2's getKeyAlgos() will negotiate the proper hash algorithm
        const baseType = normalizeBaseTypeForConversion(key.type);
        let hash = options && options.hash ? options.hash : undefined;

        // If hash not provided by ssh2, default to SHA-512 for RSA keys
        // (matches OpenSSH client behavior, modern servers disable SHA-1)
        if (!hash && baseType === 'ssh-rsa') {
          hash = 'sha512';  // Use SHA-512 like OpenSSH client
        }

        log("Signing with parameters", {
          privateKeyType: key.type,
          baseType: baseType,
          advertisedType: this._advertisedType,
          hash: hash,
        });

        let sig = key.sign(data, hash);
        if (sig instanceof Error) throw sig;

        log("certificate sign result", {
          privateKeyType: key.type,
          baseType,
          advertisedType: this._advertisedType,
          hash,
          sigLength: sig.length,
        });

        // CRITICAL: ssh2's authPK() expects RAW signature (without algorithm name wrapper)
        // authPK will construct the signature blob itself: algo_name + raw_signature
        // If we return pre-wrapped blob, authPK will wrap it again causing double-wrapping
        // which server will reject. So we must return ONLY the raw signature bytes.
        log("Returning raw signature to ssh2", {
          signatureLength: sig.length,
          signaturePreview: sig.slice(0, 32).toString('hex')
        });

        return Buffer.from(sig);  // Return RAW signature only
      }

      throw new Error("Unsupported agent mode");
    })()
      .then((sig) => cb(null, sig))
      .catch((err) => cb(err));
  }
}

module.exports = {
  NetcattyAgent,
};
