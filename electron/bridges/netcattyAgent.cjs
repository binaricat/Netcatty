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

// Simple file logger for debugging
const logFile = path.join(require("os").tmpdir(), "netcatty-agent.log");
const log = (msg, data) => {
  const line = `[${new Date().toISOString()}] ${msg} ${data ? JSON.stringify(data) : ""}\n`;
  try { fs.appendFileSync(logFile, line); } catch {}
  console.log("[Agent]", msg, data || "");
};

const DUMMY_ED25519_PUB =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB netcatty-agent-dummy";

function parseOpenSshKeyLine(line) {
  if (typeof line !== "string" || !line.trim()) throw new Error("Empty OpenSSH key line");
  const firstLine = line.split(/\r?\n/).find((l) => l.trim());
  if (!firstLine) throw new Error("Empty OpenSSH key line");
  const m = /^\s*(\S+)\s+([A-Za-z0-9+/=]+)(?:\s+(.*))?\s*$/.exec(firstLine);
  if (!m) throw new Error("Invalid OpenSSH key line");
  const type = m[1];
  const blob = Buffer.from(m[2], "base64");
  const comment = m[3] || "";
  return { type, blob, comment };
}

function buildCertificateIdentityKey({ certType, certBlob, comment }) {
  const key = parseKey(DUMMY_ED25519_PUB);
  if (key instanceof Error) throw key;
  key.type = certType;
  key.comment = comment || key.comment;
  key.getPublicSSH = () => certBlob;
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
      const { certificate, label } = opts.meta || {};
      if (!certificate) throw new Error("Missing certificate");
      const { type: certType, blob: certBlob } = parseOpenSshKeyLine(certificate);
      this._key = buildCertificateIdentityKey({
        certType,
        certBlob,
        comment: label || "",
      });
      this._advertisedType = certType;
    } else {
      throw new Error(`Unknown agent mode: ${opts.mode}`);
    }
  }

  getIdentities(cb) {
    log("getIdentities called", { mode: this._mode });
    cb(null, [this._key]);
  }

  sign(_pubKey, data, options, cb) {
    log("sign called", { 
      mode: this._mode, 
      dataLength: data?.length,
      advertisedType: this._advertisedType,
      options: options,
    });
    if (typeof options === "function") {
      cb = options;
      options = undefined;
    }
    if (typeof cb !== "function") cb = () => {};

    (async () => {
      if (this._mode === "certificate") {
        const { privateKey, passphrase } = this._meta || {};
        if (!privateKey) throw new Error("Missing privateKey for certificate auth");

        const parsed = parseKey(privateKey, passphrase);
        if (parsed instanceof Error) throw parsed;
        const key = Array.isArray(parsed) ? parsed[0] : parsed;

        const baseType = normalizeBaseTypeForConversion(key.type);
        let hash = options && options.hash ? options.hash : undefined;

        // ssh2 does not currently infer hash algorithms for certificate types.
        // For RSA cert algorithms, select the hash based on the *advertised* algorithm
        // (e.g. rsa-sha2-256-cert-v01@openssh.com), not the private key type (ssh-rsa).
        if (!hash) {
          const advertisedBaseType = normalizeBaseTypeForConversion(
            this._advertisedType || this._key?.type
          );
          if (advertisedBaseType === "rsa-sha2-256") hash = "sha256";
          else if (advertisedBaseType === "rsa-sha2-512") hash = "sha512";
          else if (advertisedBaseType === "ssh-rsa") hash = "sha1";
        }

        let sig = key.sign(data, hash);
        if (sig instanceof Error) throw sig;

        log("certificate sign result", {
          privateKeyType: key.type,
          baseType,
          advertisedType: this._advertisedType,
          hash,
          sigLength: sig?.length,
        });

        // Return raw signature - ssh2SkPatch will handle format conversion
        // for ECDSA/DSS types and proper signature field construction.
        return Buffer.from(sig);
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
