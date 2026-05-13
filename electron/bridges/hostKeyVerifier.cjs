const crypto = require("node:crypto");
const { randomUUID } = require("node:crypto");
const { utils: sshUtils } = require("ssh2");

const REQUEST_TTL_MS = 2 * 60 * 1000;
const hostKeyRequests = new Map();

const normalizeFingerprint = (value) => {
  if (typeof value !== "string") return "";
  return value
    .trim()
    .replace(/^SHA256:/i, "")
    .replace(/=+$/g, "");
};

const normalizeHostname = (value) => String(value || "").trim().toLowerCase();

const parseKnownHostPattern = (hostname) => {
  const value = String(hostname || "").trim();
  if (!value) return { hostname: "", port: undefined };
  const first = value.split(",")[0];
  const bracketMatch = first.match(/^\[([^\]]+)\]:(\d+)$/);
  if (bracketMatch) {
    return {
      hostname: normalizeHostname(bracketMatch[1]),
      port: Number.parseInt(bracketMatch[2], 10),
    };
  }
  return { hostname: normalizeHostname(first), port: undefined };
};

const getKnownHostPort = (knownHost) => {
  const parsed = parseKnownHostPattern(knownHost?.hostname);
  if (Number.isFinite(knownHost?.port)) return Number(knownHost.port);
  if (Number.isFinite(parsed.port)) return Number(parsed.port);
  return 22;
};

const matchesHostAndPort = (knownHost, hostname, port) => {
  const parsed = parseKnownHostPattern(knownHost?.hostname);
  if (!parsed.hostname || parsed.hostname === "(hashed)") return false;
  return parsed.hostname === normalizeHostname(hostname) && getKnownHostPort(knownHost) === (port || 22);
};

const describeRawPublicKeyBlob = (key) => {
  if (!Buffer.isBuffer(key) || key.length < 8) return null;
  const typeLength = key.readUInt32BE(0);
  if (typeLength <= 0 || typeLength > 128 || 4 + typeLength > key.length) return null;

  const keyType = key.subarray(4, 4 + typeLength).toString("ascii");
  if (!/^[A-Za-z0-9@._+-]+$/.test(keyType)) return null;

  return {
    keyType,
    publicKey: `${keyType} ${key.toString("base64")}`,
  };
};

const fingerprintFromPublicKey = (publicKey) => {
  if (typeof publicKey !== "string") return "";
  const trimmed = publicKey.trim();
  if (!trimmed) return "";
  if (/^SHA256:/i.test(trimmed)) return normalizeFingerprint(trimmed);

  const parts = trimmed.split(/\s+/);
  if (parts.length >= 2 && /^ssh-|^ecdsa-|^sk-/.test(parts[0])) {
    try {
      return crypto.createHash("sha256")
        .update(Buffer.from(parts[1], "base64"))
        .digest("base64")
        .replace(/=+$/g, "");
    } catch {
      return "";
    }
  }
  return normalizeFingerprint(trimmed);
};

const getKnownHostFingerprint = (knownHost) => {
  return normalizeFingerprint(knownHost?.fingerprint)
    || fingerprintFromPublicKey(knownHost?.publicKey);
};

// Classification rules, in order:
//   1. Any record for (host, port) whose fingerprint matches the live key →
//      trusted. Fingerprint is the ground truth; key type is metadata.
//   2. A record matching (host, port, keyType) *exactly* with a non-matching
//      fingerprint → changed. Only this case is a real "key rotated" alarm —
//      the user already trusted this exact algorithm on this host and the
//      server now presents a different key of the same type.
//   3. Otherwise → unknown. This includes the case where the server presents
//      a key of an algorithm we have no record for, even if the host has
//      records for other algorithms. Tabby and OpenSSH both treat that as a
//      first-time prompt rather than a mismatch warning (#972).
const classifyHostKey = ({ knownHosts = [], hostname, port = 22, keyType, fingerprint }) => {
  const normalizedFingerprint = normalizeFingerprint(fingerprint);
  const candidates = Array.isArray(knownHosts)
    ? knownHosts.filter((knownHost) => matchesHostAndPort(knownHost, hostname, port))
    : [];

  if (candidates.length === 0) {
    return { status: "unknown" };
  }

  const comparableCandidates = candidates
    .map((knownHost) => ({
      knownHost,
      fingerprint: getKnownHostFingerprint(knownHost),
    }))
    .filter((entry) => entry.fingerprint);

  const match = comparableCandidates.find((entry) => entry.fingerprint === normalizedFingerprint);
  if (match) {
    return { status: "trusted", knownHost: match.knownHost };
  }

  const normalizedKeyType = typeof keyType === "string" ? keyType.trim() : "";
  if (normalizedKeyType && normalizedKeyType !== "unknown") {
    const sameTypeMismatch = comparableCandidates.find(
      (entry) => entry.knownHost.keyType === normalizedKeyType,
    );
    if (sameTypeMismatch) {
      return {
        status: "changed",
        knownHost: sameTypeMismatch.knownHost,
        expectedFingerprint: sameTypeMismatch.fingerprint,
      };
    }
  }

  return { status: "unknown" };
};

const describeHostKey = (rawKey) => {
  const key = Buffer.isBuffer(rawKey) ? rawKey : Buffer.from(rawKey || "");
  const fingerprint = crypto.createHash("sha256")
    .update(key)
    .digest("base64")
    .replace(/=+$/g, "");
  let keyType = "unknown";
  let publicKey;

  const rawPublicKey = describeRawPublicKeyBlob(key);
  if (rawPublicKey) {
    keyType = rawPublicKey.keyType;
    publicKey = rawPublicKey.publicKey;
  }

  try {
    const parsed = sshUtils.parseKey(key);
    const parsedKey = Array.isArray(parsed) ? parsed[0] : parsed;
    if (parsedKey && !(parsedKey instanceof Error)) {
      keyType = parsedKey.type || keyType;
      const publicSsh = parsedKey.getPublicSSH?.();
      if (publicSsh) publicKey = publicSsh.toString("utf8");
    }
  } catch {
    // Keep the fingerprint; key type/public key are best-effort metadata.
  }

  return { keyType, fingerprint, publicKey };
};

const generateRequestId = () => `hostkey-${randomUUID()}`;

const settleRequest = (requestId, response) => {
  const pending = hostKeyRequests.get(requestId);
  if (!pending) return { success: false, error: "Request not found" };
  if (pending.timeoutId) clearTimeout(pending.timeoutId);
  hostKeyRequests.delete(requestId);
  pending.resolve(response);
  return { success: true };
};

const requestHostKeyVerification = (sender, info) => new Promise((resolve) => {
  if (!sender || sender.isDestroyed?.()) {
    resolve({ accept: false });
    return;
  }

  const requestId = generateRequestId();
  const timeoutId = setTimeout(() => {
    settleRequest(requestId, { accept: false, timeout: true });
  }, REQUEST_TTL_MS);

  hostKeyRequests.set(requestId, {
    resolve,
    timeoutId,
    createdAt: Date.now(),
    webContentsId: sender.id,
    sessionId: info.sessionId,
  });

  try {
    sender.send("netcatty:host-key:verify", {
      requestId,
      ...info,
    });
  } catch {
    settleRequest(requestId, { accept: false });
  }
});

const createHostVerifier = ({
  sender,
  sessionId,
  hostname,
  port = 22,
  knownHosts = [],
}) => (rawKey, callback) => {
  const keyInfo = describeHostKey(rawKey);
  const decision = classifyHostKey({
    knownHosts,
    hostname,
    port,
    keyType: keyInfo.keyType,
    fingerprint: keyInfo.fingerprint,
  });

  if (decision.status === "trusted") {
    callback(true);
    return;
  }

  void requestHostKeyVerification(sender, {
    sessionId,
    hostname,
    port,
    status: decision.status,
    keyType: keyInfo.keyType,
    fingerprint: keyInfo.fingerprint,
    publicKey: keyInfo.publicKey,
    knownHostId: decision.knownHost?.id,
    knownFingerprint: decision.expectedFingerprint,
  }).then((response) => {
    callback(Boolean(response?.accept));
  }).catch(() => {
    callback(false);
  });
};

const handleResponse = (_event, payload) => {
  const { requestId, accept, addToKnownHosts } = payload || {};
  return settleRequest(requestId, {
    accept: Boolean(accept),
    addToKnownHosts: Boolean(addToKnownHosts),
  });
};

const registerHandler = (ipcMain) => {
  ipcMain.handle("netcatty:host-key:respond", handleResponse);
};

const getRequests = () => hostKeyRequests;

module.exports = {
  classifyHostKey,
  createHostVerifier,
  describeHostKey,
  getKnownHostFingerprint,
  handleResponse,
  normalizeFingerprint,
  registerHandler,
  requestHostKeyVerification,
  getRequests,
};
