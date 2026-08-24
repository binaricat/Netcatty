"use strict";

/**
 * Shared SSH transport registry (borrow / return + idle park).
 *
 * Background (issue #1204): "Copy Tab" on an MFA-protected host used to open a
 * brand-new SSH connection, forcing the user through a second MFA prompt. Like
 * Tabby's session-multiplexing, we open additional channels on an already-
 * authenticated connection. The SSH protocol natively supports many session
 * channels over one transport, so no re-authentication is needed.
 *
 * Lifecycle model (OpenSSH ControlPersist-style):
 * - Consumers **borrow** a lease (shell / sftp / transfer / forward).
 * - **return** drops the lease. When no leases remain, the transport enters
 *   idle park for a configurable TTL instead of ending immediately.
 * - A later borrow against the same endpoint can wake an idle transport.
 * - When the idle TTL fires (or TTL is 0 on last return), the underlying
 *   ssh2 Client and jump-host chain are torn down.
 *
 * Compatibility: createConnectionRef / acquireConnectionRef /
 * releaseConnectionRef / findReusableSession keep working. `connRef` is the
 * transport object; `count` mirrors active lease size for existing callers.
 *
 * The same `sessions` Map is shared by sshBridge and terminalBridge (see
 * registerBridges.cjs). SFTP session-backed clients and (later) port-forward
 * tunnels borrow the same transports via this registry.
 */

const { randomUUID, createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { remoteAllowsIdleParkedShellReuse } = require("./sshIdleParkPolicy.cjs");

/**
 * Default idle park after last lease returns (5 minutes).
 * 0 = park until app quit / discard (ControlPersist-style, never auto-reclaim).
 * Positive = park that many ms then end.
 */
const DEFAULT_SSH_TRANSPORT_IDLE_TTL_MS = 5 * 60_000;

/**
 * Global safety bound for authenticated transports with no active leases.
 * Active transports never count toward this limit and are never evicted.
 */
const DEFAULT_MAX_IDLE_SSH_TRANSPORTS = 128;

/** Storage key mirrored in infrastructure/config/storageKeys.ts (main + renderer). */
const STORAGE_KEY_SSH_TRANSPORT_IDLE_TTL_MS = "netcatty_ssh_transport_idle_ttl_ms_v1";

const LEASE_KINDS = Object.freeze({
  shell: "shell",
  sftp: "sftp",
  transfer: "transfer",
  forward: "forward",
});

/** @type {Map<string, object>} transportId -> transport */
const transportsById = new Map();
/** @type {Map<string, Set<string>>} endpointKey -> transport ids */
const transportIdsByEndpoint = new Map();
/** @type {Map<string, { transport: object, holder: object|null }>} leaseId -> entry */
const leasesById = new Map();
/** @type {Map<string, Set<object>>} endpointKey -> pending physical dials */
const pendingDialsByEndpoint = new Map();
/** @type {Map<string, object>} oldest -> newest idle transport */
const idleTransportsLru = new Map();

let defaultIdleTtlMs = resolveEnvIdleTtlMs(DEFAULT_SSH_TRANSPORT_IDLE_TTL_MS);
let maxIdleTransports = DEFAULT_MAX_IDLE_SSH_TRANSPORTS;
let timerApi = {
  setTimeout: (...args) => setTimeout(...args),
  clearTimeout: (...args) => clearTimeout(...args),
};
let nowFn = () => Date.now();
let nextLeaseSeq = 0;
/** Endpoint keys whose parked transports cannot host a later interactive shell. */
const noIdleParkEndpointKeys = new Set();

function markEndpointNoIdlePark(endpointOrKey) {
  const key = typeof endpointOrKey === "string"
    ? endpointOrKey
    : buildEndpointKey(endpointOrKey);
  if (!key) return false;
  noIdleParkEndpointKeys.add(key);
  return true;
}

function endpointAllowsIdlePark(endpointOrKey, remoteSshVersion) {
  if (!remoteAllowsIdleParkedShellReuse(remoteSshVersion)) return false;
  const key = typeof endpointOrKey === "string"
    ? endpointOrKey
    : buildEndpointKey(endpointOrKey);
  if (key && noIdleParkEndpointKeys.has(key)) return false;
  return true;
}

function applyIdleParkPolicy(transport, remoteSshVersion) {
  if (!transport) return false;
  const remoteVer = remoteSshVersion
    || (typeof transport.conn?._remoteVer === "string" ? transport.conn._remoteVer : "");
  const allowed = endpointAllowsIdlePark(transport.endpointKey || transport.endpoint, remoteVer);
  transport.allowIdlePark = allowed;
  if (!allowed && transport.endpointKey) {
    noIdleParkEndpointKeys.add(transport.endpointKey);
  }
  return allowed;
}

function removePendingDial(record) {
  if (!record?.endpointKey) return;
  const records = pendingDialsByEndpoint.get(record.endpointKey);
  if (!records) return;
  records.delete(record);
  if (records.size === 0) pendingDialsByEndpoint.delete(record.endpointKey);
}

/**
 * Atomically choose whether an opener should reuse, join, or lead a physical
 * SSH dial. Keeping this registry beside the authenticated transport index
 * closes the gap where two callers both observe "no transport" and connect.
 */
function beginTransportDial(endpoint, opts = {}) {
  const kind = opts?.kind === "shell" ? "shell" : "channel";
  const reusable = findTransportByEndpoint(endpoint, { kind });
  if (reusable) {
    return { role: "reuse", transport: reusable, endpoint, kind };
  }

  const normalizedEndpoint = normalizeEndpoint(endpoint);
  const endpointKey = buildEndpointKey(normalizedEndpoint);
  if (!endpointKey) {
    throw new Error("Cannot coordinate SSH dial without a valid endpoint");
  }

  const pending = pendingDialsByEndpoint.get(endpointKey);
  if (pending) {
    for (const record of pending) {
      if (record.settled) continue;
      // Reuse is evaluated from the waiter's requirements against the leader's
      // negotiated policy. This preserves ForwardAgent's asymmetric channel
      // rule and exact shell rule while the connection is still being opened.
      if (endpointAllowsReuse(normalizedEndpoint, record.endpoint, kind)) {
        return {
          role: "join",
          promise: record.promise,
          endpoint: normalizedEndpoint,
          kind,
          _record: record,
        };
      }
    }
  }

  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  // A leader may fail before any waiter joins. Mark the rejection observed
  // without changing what actual waiters receive from the original promise.
  promise.catch(() => {});
  const record = {
    endpoint: normalizedEndpoint,
    endpointKey,
    kind,
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
    settled: false,
  };
  let records = pendingDialsByEndpoint.get(endpointKey);
  if (!records) {
    records = new Set();
    pendingDialsByEndpoint.set(endpointKey, records);
  }
  records.add(record);
  return {
    role: "leader",
    promise,
    endpoint: normalizedEndpoint,
    kind,
    _record: record,
  };
}

function waitForTransportDial(coordination, opts = {}) {
  if (coordination?.role === "reuse") {
    return Promise.resolve(coordination.transport);
  }
  const promise = coordination?.promise;
  if (!promise || typeof promise.then !== "function") {
    return Promise.reject(new Error("Invalid SSH dial coordination handle"));
  }
  const validateTransport = (transport) => {
    if (!endpointAllowsReuse(coordination.endpoint, transport?.endpoint, coordination.kind)) {
      throw new Error("SSH dial completed with an incompatible endpoint");
    }
    return transport;
  };
  const signal = opts?.signal;
  if (!signal) return promise.then(validateTransport);
  if (signal.aborted) {
    return Promise.reject(signal.reason || new Error("SSH connection wait cancelled"));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason || new Error("SSH connection wait cancelled"));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (transport) => {
        cleanup();
        try {
          resolve(validateTransport(transport));
        } catch (error) {
          reject(error);
        }
      },
      (err) => { cleanup(); reject(err); },
    );
  });
}

function completeTransportDial(coordination, transport) {
  const record = coordination?._record;
  if (coordination?.role !== "leader" || !record || record.settled) return false;
  if (!transport || !isTransportSocketHealthy(transport)) {
    return failTransportDial(coordination, new Error("SSH dial completed without a healthy transport"));
  }
  record.settled = true;
  removePendingDial(record);
  record.resolve(transport);
  return true;
}

function failTransportDial(coordination, error) {
  const record = coordination?._record;
  if (coordination?.role !== "leader" || !record || record.settled) return false;
  record.settled = true;
  removePendingDial(record);
  record.reject(error instanceof Error ? error : new Error(String(error || "SSH dial failed")));
  return true;
}

function failAllPendingDials(reason = "SSH connection pool reset") {
  const records = [];
  for (const set of pendingDialsByEndpoint.values()) records.push(...set);
  for (const record of records) {
    failTransportDial(
      { role: "leader", _record: record },
      new Error(reason),
    );
  }
}

function resolveEnvIdleTtlMs(fallback) {
  const raw = process.env.NETCATTY_SSH_TRANSPORT_IDLE_TTL_MS;
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function stableSerialize(value, seen = new WeakSet()) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Buffer.isBuffer(value)) return `buffer:${value.toString("base64")}`;
  const type = typeof value;
  if (type === "string" || type === "boolean") return JSON.stringify(value);
  if (type === "number") return Number.isFinite(value) ? String(value) : JSON.stringify(String(value));
  if (type !== "object") return JSON.stringify(String(value));
  if (seen.has(value)) return '"[circular]"';
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = `[${value.map((item) => stableSerialize(item, seen)).join(",")}]`;
  } else {
    result = `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableSerialize(value[key], seen)}`
    )).join(",")}}`;
  }
  seen.delete(value);
  return result;
}

function secureDigest(value) {
  return createHash("sha256").update(stableSerialize(value)).digest("hex");
}

function expandIdentityFilePath(filePath) {
  if (typeof filePath !== "string" || !filePath.trim()) return "";
  return filePath.trim()
    .replace(/^~(?=$|[\\/])/, os.homedir())
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name) => process.env[name] ?? "")
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name) => process.env[name] ?? "");
}

function fingerprintIdentityFiles(identityFilePaths) {
  const paths = Array.isArray(identityFilePaths)
    ? identityFilePaths
    : (identityFilePaths ? [identityFilePaths] : []);
  return secureDigest(paths.map((filePath) => {
    const expanded = expandIdentityFilePath(filePath);
    if (!expanded) return { path: String(filePath || ""), state: "invalid" };
    try {
      return {
        path: path.normalize(expanded),
        content: createHash("sha256").update(fs.readFileSync(expanded)).digest("hex"),
      };
    } catch (err) {
      return {
        path: path.normalize(expanded),
        state: err?.code || "unreadable",
      };
    }
  }));
}

function fingerprintProxy(proxy) {
  if (!proxy || typeof proxy !== "object") return "-";
  const type = proxy.type || proxy.proxyType || proxy.mode || "";
  const host = proxy.host || proxy.hostname || proxy.server || "";
  const port = proxy.port || "";
  const command = proxy.command || proxy.proxyCommand || proxy.cmd || "";
  if (!type && !host && !port && !command) return "-";
  // The full resolved proxy object includes authentication and identity
  // selection. Only the digest is retained in the transport registry.
  return secureDigest(proxy);
}

function fingerprintJumpHosts(jumpHosts) {
  if (!Array.isArray(jumpHosts) || jumpHosts.length === 0) return "-";
  return secureDigest(jumpHosts.map((hop) => {
    if (!hop || typeof hop !== "object") return hop;
    return {
      ...hop,
      identityFileContentFingerprint: fingerprintIdentityFiles(hop.identityFilePaths),
      proxyFingerprint: fingerprintProxy(hop.proxy || hop.proxyConfig || null),
    };
  }));
}

function parseKnownHostTarget(value) {
  const first = String(value || "").trim().split(",")[0];
  if (!first) return null;
  const bracketed = first.match(/^\[([^\]]+)\]:(\d+)$/);
  if (bracketed) {
    return {
      hostname: bracketed[1].trim().toLowerCase(),
      port: Number.parseInt(bracketed[2], 10),
    };
  }
  return { hostname: first.toLowerCase(), port: 22 };
}

/**
 * Digest only the known-host records that can authorize this target or one of
 * its SSH jump hosts. The registry retains only the digest, never public-key
 * text or the full known-hosts vault.
 */
function fingerprintKnownHostTrust(endpoint) {
  if (!endpoint || endpoint.verifyHostKeys === false) return "disabled";
  const targets = [];
  const addTarget = (hostname, port, verifyHostKeys = true) => {
    if (verifyHostKeys === false) return;
    const normalizedHostname = String(hostname || "").trim().toLowerCase();
    if (!normalizedHostname) return;
    targets.push(`${normalizedHostname}|${Number(port) || 22}`);
  };
  addTarget(endpoint.hostname, endpoint.port, endpoint.verifyHostKeys);
  for (const hop of Array.isArray(endpoint.jumpHosts) ? endpoint.jumpHosts : []) {
    addTarget(
      hop?.hostname,
      hop?.port,
      hop?.verifyHostKeys ?? endpoint.verifyHostKeys,
    );
  }
  const targetSet = new Set(targets);
  const relevant = [];
  for (const knownHost of Array.isArray(endpoint.knownHosts) ? endpoint.knownHosts : []) {
    const parsed = parseKnownHostTarget(knownHost?.hostname);
    if (!parsed || parsed.hostname === "(hashed)") continue;
    const port = Number.isFinite(knownHost?.port) ? Number(knownHost.port) : parsed.port;
    if (!targetSet.has(`${parsed.hostname}|${port || 22}`)) continue;
    relevant.push({
      hostname: parsed.hostname,
      port: port || 22,
      keyType: String(knownHost?.keyType || ""),
      fingerprint: String(knownHost?.fingerprint || ""),
      publicKeyDigest: secureDigest(String(knownHost?.publicKey || "")),
    });
  }
  relevant.sort((a, b) => stableSerialize(a).localeCompare(stableSerialize(b)));
  return secureDigest(relevant);
}

/**
 * Non-secret digest of credential material for reuse invalidation.
 * Digests every credential that can authenticate the selected policy. For
 * automatic authentication we cannot know, while coordinating a pending dial,
 * whether a key will succeed or ssh2 will fall back to the saved password.
 * Including both is deliberately conservative: an irrelevant password change
 * may cause one extra connection after key authentication, but a password that
 * actually authenticated can never keep reusing a TTL-zero transport after it
 * was rotated. Raw secrets are never stored.
 */
function digestAuthMaterial(endpoint) {
  if (!endpoint || typeof endpoint !== "object") return "none";
  if (endpoint.authMaterialFingerprint) return String(endpoint.authMaterialFingerprint);
  const method = String(endpoint.authType || endpoint.authMethod || "auto").toLowerCase();
  const h = createHash("sha256");
  h.update(method);
  h.update("\0");
  h.update(String(endpoint.keyId || endpoint.identityId || ""));
  h.update("\0");
  const identityPaths = Array.isArray(endpoint.identityFilePaths)
    ? endpoint.identityFilePaths.join("\n")
    : (endpoint.identityFilePaths || "");
  const identityFileContentFingerprint = fingerprintIdentityFiles(endpoint.identityFilePaths);

  if (method === "password") {
    h.update(String(endpoint.password || ""));
  } else if (method === "certificate") {
    h.update(String(endpoint.certificate || ""));
    h.update("\0");
    h.update(String(endpoint.privateKey || endpoint.publicKey || ""));
    h.update("\0");
    h.update(String(endpoint.passphrase || ""));
  } else if (method === "key") {
    h.update(String(endpoint.privateKey || endpoint.publicKey || ""));
    h.update("\0");
    h.update(String(endpoint.passphrase || ""));
    h.update("\0");
    h.update(String(identityPaths));
    h.update("\0");
    h.update(identityFileContentFingerprint);
  } else {
    // auto / agent: include every configured key source plus the fallback
    // password. The pool coordinates before authentication completes, so it
    // must not assume that the first key source is the one that succeeded.
    h.update(String(endpoint.publicKey || ""));
    h.update("\0");
    if (endpoint.privateKey) {
      h.update("private-key:");
      h.update(String(endpoint.privateKey));
      h.update("\0");
    }
    h.update(endpoint.certificate ? "cert" : "nocert");
    h.update("\0");
    h.update(String(identityPaths));
    h.update("\0");
    h.update(identityFileContentFingerprint);
    h.update("\0pw:");
    h.update(String(endpoint.password || ""));
  }
  return h.digest("hex").slice(0, 16);
}

function fingerprintAuth(endpoint) {
  if (!endpoint || typeof endpoint !== "object") return "-";
  if (endpoint.authFingerprint) return String(endpoint.authFingerprint);
  // Invalidate parked reuse when auth material or host-key policy changes for
  // the same hostId/route (key rotation, MFA toggle, verifyHostKeys, etc.).
  const authType = endpoint.authType || endpoint.authMethod || "";
  const keyId = endpoint.keyId || endpoint.identityId || "";
  const material = digestAuthMaterial(endpoint);
  return secureDigest({
    authType,
    keyId,
    material,
    certificate: endpoint.certificate ? secureDigest(endpoint.certificate) : "none",
    requiresMfa: Boolean(endpoint.requiresMfa),
    verifyHostKeys: endpoint.verifyHostKeys !== false,
    knownHostTrust: fingerprintKnownHostTrust(endpoint),
    authPolicyVersion: endpoint.authPolicyVersion ?? null,
    useSshAgent: endpoint.useSshAgent ?? null,
    identityAgent: endpoint.identityAgent ?? null,
    identitiesOnly: endpoint.identitiesOnly ?? null,
    addKeysToAgent: endpoint.addKeysToAgent ?? null,
    useKeychain: endpoint.useKeychain ?? null,
    agentPublicKeys: endpoint.agentPublicKeys ?? null,
    legacyAlgorithms: endpoint.legacyAlgorithms ?? null,
    skipEcdsaHostKey: endpoint.skipEcdsaHostKey ?? null,
    algorithmOverrides: endpoint.algorithmOverrides ?? null,
  });
}

function resolveConnectionKeepalivePolicy(options = {}) {
  const configuredInterval = options.keepaliveInterval;
  const intervalSeconds = configuredInterval == null
    ? 10
    : Number(configuredInterval);
  const keepaliveIntervalMs = Number.isFinite(intervalSeconds) && intervalSeconds > 0
    ? intervalSeconds * 1000
    : 0;
  const configuredCount = configuredInterval == null
    ? 3
    : options.keepaliveCountMax;
  const count = Number(configuredCount ?? 3);
  return {
    keepaliveIntervalMs,
    keepaliveCountMax: keepaliveIntervalMs > 0 && Number.isFinite(count) && count >= 0
      ? count
      : 0,
  };
}

/**
 * Build the common terminal/SFTP endpoint description consumed by the pool.
 * Raw credentials exist only while the caller computes the normalized hashes;
 * beginTransportDial/createTransport retain the normalized, digest-only form.
 */
function buildConnectionReuseEndpoint(options = {}, overrides = {}) {
  const keepalive = resolveConnectionKeepalivePolicy({
    keepaliveInterval: overrides.keepaliveInterval ?? options.keepaliveInterval,
    keepaliveCountMax: overrides.keepaliveCountMax ?? options.keepaliveCountMax,
  });
  return {
    hostId: options.hostId || "",
    hostname: options.hostname,
    port: options.port || 22,
    username: options.username || "root",
    protocol: options.protocol || "ssh",
    sftpSudo: overrides.sftpSudo ?? Boolean(options.sftpSudo || options.sudo),
    jumpHosts: Array.isArray(options.jumpHosts) ? options.jumpHosts : [],
    proxy: options.proxy || null,
    authType: options.authType || options.authMethod || "",
    authPolicyVersion: options.authPolicyVersion,
    keyId: options.keyId || options.identityId || "",
    certificate: options.certificate || "",
    requiresMfa: Boolean(options.requiresMfa),
    verifyHostKeys: options.verifyHostKeys,
    knownHosts: options.knownHosts,
    useSshAgent: options.useSshAgent,
    identityAgent: options.identityAgent,
    identitiesOnly: options.identitiesOnly,
    addKeysToAgent: options.addKeysToAgent,
    useKeychain: options.useKeychain,
    agentPublicKeys: options.agentPublicKeys,
    agentForwarding: Boolean(overrides.agentForwarding ?? options.agentForwarding),
    forwardingAgentSocket: options.forwardingAgentSocket || "",
    ...keepalive,
    password: options.password,
    privateKey: options.privateKey,
    publicKey: options.publicKey,
    passphrase: options.passphrase,
    identityFilePaths: options.identityFilePaths,
    legacyAlgorithms: options.legacyAlgorithms,
    skipEcdsaHostKey: options.skipEcdsaHostKey,
    algorithmOverrides: options.algorithmOverrides,
  };
}

function normalizeEndpoint(endpoint) {
  if (!endpoint || typeof endpoint !== "object") return null;
  const hostname = String(endpoint.hostname || "").trim();
  if (!hostname) return null;
  // hostId scopes reuse to a vault profile so two saved hosts that share
  // hostname:port:user but differ in credentials/proxy/host-key policy never
  // silently share an authenticated transport.
  const hostId = endpoint.hostId != null && String(endpoint.hostId).trim()
    ? String(endpoint.hostId).trim()
    : "";
  const keepalive = endpoint.keepaliveIntervalMs != null
    ? {
      keepaliveIntervalMs: Number(endpoint.keepaliveIntervalMs) || 0,
      keepaliveCountMax: Number(endpoint.keepaliveCountMax) || 0,
    }
    : resolveConnectionKeepalivePolicy(endpoint);
  return {
    hostId,
    hostname,
    port: endpoint.port || 22,
    username: endpoint.username || "root",
    protocol: endpoint.protocol || "ssh",
    sftpSudo: Boolean(endpoint.sftpSudo),
    jumpFingerprint: endpoint.jumpFingerprint
      ? String(endpoint.jumpFingerprint)
      : fingerprintJumpHosts(endpoint.jumpHosts),
    proxyFingerprint: endpoint.proxyFingerprint
      ? String(endpoint.proxyFingerprint)
      : fingerprintProxy(endpoint.proxy),
    authFingerprint: fingerprintAuth(endpoint),
    // Stored for asymmetric reuse checks (not part of the endpoint key).
    // A transport opened with ForwardAgent can serve SFTP/PF; a transport
    // without it cannot satisfy a later shell open that needs agentForwarding.
    agentForwarding: Boolean(endpoint.agentForwarding),
    forwardingAgentFingerprint: endpoint.forwardingAgentFingerprint
      ? String(endpoint.forwardingAgentFingerprint)
      : endpoint.agentForwarding && endpoint.forwardingAgentSocket
        ? secureDigest(String(endpoint.forwardingAgentSocket))
        : "-",
    ...keepalive,
  };
}

function buildEndpointKey(endpoint) {
  const ep = normalizeEndpoint(endpoint);
  if (!ep) return null;
  const sudo = ep.sftpSudo ? "sudo" : "nosudo";
  const jump = ep.jumpFingerprint || "-";
  const proxy = ep.proxyFingerprint || "-";
  const auth = ep.authFingerprint || "-";
  const profile = ep.hostId || "-";
  return [
    profile,
    ep.hostname,
    ep.port,
    ep.username,
    ep.protocol,
    sudo,
    jump,
    proxy,
    auth,
    `keepalive:${ep.keepaliveIntervalMs}:${ep.keepaliveCountMax}`,
  ].join("|");
}

function sameEndpoint(a, b) {
  const left = normalizeEndpoint(a);
  const right = normalizeEndpoint(b);
  if (!left || !right) return false;
  // When both sides carry a vault hostId they must match so different profiles
  // never cross-reuse. If either omits hostId (legacy / explicit session-id
  // reuse), fall back to route comparison only.
  if (left.hostId && right.hostId && left.hostId !== right.hostId) return false;
  return left.hostname === right.hostname
    && left.port === right.port
    && left.username === right.username
    && left.protocol === right.protocol
    && left.sftpSudo === right.sftpSudo
    && left.jumpFingerprint === right.jumpFingerprint
    && left.proxyFingerprint === right.proxyFingerprint
    && left.authFingerprint === right.authFingerprint
    && left.keepaliveIntervalMs === right.keepaliveIntervalMs
    && left.keepaliveCountMax === right.keepaliveCountMax;
}

function sameTransportEndpoint(a, b) {
  const left = normalizeEndpoint(a);
  const right = normalizeEndpoint(b);
  if (!left || !right) return false;
  // SFTP sudo changes the channel/subsystem setup, not the authenticated SSH
  // transport. Channel borrowers (SFTP/port forwarding) may reuse the terminal
  // connection and apply sudo when opening their own channel.
  if (left.hostId && right.hostId && left.hostId !== right.hostId) return false;
  return left.hostname === right.hostname
    && left.port === right.port
    && left.username === right.username
    && left.protocol === right.protocol
    && left.jumpFingerprint === right.jumpFingerprint
    && left.proxyFingerprint === right.proxyFingerprint
    && left.authFingerprint === right.authFingerprint
    && left.keepaliveIntervalMs === right.keepaliveIntervalMs
    && left.keepaliveCountMax === right.keepaliveCountMax;
}

/**
 * True when a requested open can reuse an existing transport/session endpoint.
 *
 * @param {object} requested
 * @param {object} existing
 * @param {"shell"|"channel"} [kind="channel"]
 *   - shell: exact agentForwarding match. Disabling ForwardAgent must not reattach
 *     to a warm conn that still exposes the local agent to the remote host.
 *   - channel: asymmetric (SFTP/PF). May reuse a ForwardAgent-enabled terminal
 *     transport; cannot use a nofwd transport when the request needs ForwardAgent.
 */
function endpointAllowsReuse(requested, existing, kind = "channel") {
  if (kind === "shell") {
    if (!sameEndpoint(requested, existing)) return false;
  } else if (!sameTransportEndpoint(requested, existing)) {
    return false;
  }
  const req = normalizeEndpoint(requested);
  const have = normalizeEndpoint(existing);
  if (!req || !have) return false;
  if (kind === "shell") {
    return req.agentForwarding === have.agentForwarding
      && (!req.agentForwarding
        || req.forwardingAgentFingerprint === have.forwardingAgentFingerprint);
  }
  if (req.agentForwarding && !have.agentForwarding) return false;
  return true;
}

function isTransportSocketHealthy(transport) {
  if (!transport || !transport.conn) return false;
  if (transport.state === "dead" || transport.state === "closing") return false;
  const sock = transport.conn._sock;
  if (sock && sock.destroyed) return false;
  return true;
}

function clearIdleTimer(transport) {
  if (!transport?.idleTimer) return;
  try {
    timerApi.clearTimeout(transport.idleTimer);
  } catch {
    /* ignore */
  }
  transport.idleTimer = null;
  transport.idleDeadlineAt = null;
}

function removeIdleTransportLru(transport) {
  if (!transport?.id) return;
  idleTransportsLru.delete(transport.id);
}

function touchIdleTransportLru(transport) {
  if (!transport?.id || transport.state !== "idle" || transport.leases?.size !== 0) {
    removeIdleTransportLru(transport);
    return;
  }
  idleTransportsLru.delete(transport.id);
  idleTransportsLru.set(transport.id, transport);
}

function enforceIdleTransportLimit() {
  for (const [id, transport] of idleTransportsLru) {
    if (
      transportsById.get(id) !== transport
      || transport.state !== "idle"
      || transport.leases?.size !== 0
    ) {
      idleTransportsLru.delete(id);
    }
  }

  while (idleTransportsLru.size > maxIdleTransports) {
    const oldest = idleTransportsLru.values().next().value;
    if (!oldest) break;
    idleTransportsLru.delete(oldest.id);
    // Only zero-lease idle transports are eligible. If state changed between
    // selection and eviction, leave the active transport alone.
    if (oldest.state === "idle" && oldest.leases?.size === 0) {
      endTransport(oldest, "idle-cap");
    }
  }
}

function unregisterTransport(transport) {
  if (!transport) return;
  removeIdleTransportLru(transport);
  transportsById.delete(transport.id);
  if (transport.endpointKey) {
    const set = transportIdsByEndpoint.get(transport.endpointKey);
    if (set) {
      set.delete(transport.id);
      if (set.size === 0) transportIdsByEndpoint.delete(transport.endpointKey);
    }
  }
}

function detachTransportLifecycle(transport) {
  const conn = transport?.conn;
  if (!conn?.removeListener) return;
  if (transport._poolOnConnectionClose) {
    try { conn.removeListener("close", transport._poolOnConnectionClose); } catch { /* ignore */ }
  }
  if (transport._poolOnConnectionError) {
    try { conn.removeListener("error", transport._poolOnConnectionError); } catch { /* ignore */ }
  }
  transport._poolOnConnectionClose = null;
  transport._poolOnConnectionError = null;
}

function attachTransportLifecycle(transport) {
  const conn = transport?.conn;
  if (!conn?.once) return;
  const onClose = () => {
    endTransport(transport, "socket-close", { skipConnectionEnd: true });
  };
  const onError = () => {
    endTransport(transport, "socket-error");
  };
  transport._poolOnConnectionClose = onClose;
  transport._poolOnConnectionError = onError;
  conn.once("close", onClose);
  conn.once("error", onError);
}

function endTransport(transport, reason = "end", opts = {}) {
  if (!transport) return false;
  if (transport.state === "dead" || transport.state === "closing") return false;

  transport.state = "closing";
  clearIdleTimer(transport);
  detachTransportLifecycle(transport);

  for (const leaseId of [...transport.leases.keys()]) {
    const entry = leasesById.get(leaseId);
    leasesById.delete(leaseId);
    transport.leases.delete(leaseId);
    if (entry?.holder && entry.holder.connRef === transport) {
      entry.holder.connRef = null;
      entry.holder._sshTransportLeaseId = null;
    }
  }
  transport.count = 0;

  if (!opts.skipConnectionEnd) {
    try {
      transport.conn?.end();
    } catch {
      /* connection may already be gone */
    }
  }
  const chain = Array.isArray(transport.chainConnections) ? transport.chainConnections : [];
  for (const c of chain) {
    try {
      c?.end();
    } catch {
      /* ignore */
    }
  }
  transport.chainConnections = [];
  transport.conn = null;
  transport.state = "dead";
  transport.endedReason = reason;
  unregisterTransport(transport);
  return true;
}

/**
 * Park a transport until TTL elapses (or forever when TTL is 0).
 * @param {object} transport
 * @param {{ preserveIdleSince?: boolean, preserveLru?: boolean }} [opts]
 *   preserveIdleSince: when rescheduling after a settings change, keep the
 *   original idle start so remaining lifetime is not extended.
 *   preserveLru: keep the existing idle recency while only changing its timer.
 */
function scheduleIdleEnd(transport, opts = {}) {
  clearIdleTimer(transport);
  // Never park a dead socket — last lease release can race the remote close.
  if (!isTransportSocketHealthy(transport)) {
    endTransport(transport, "unhealthy-last-lease");
    return { ended: true, idle: false };
  }
  // Bastions such as 齐治 TERM-SSHD accept a later session channel on a parked
  // transport and then immediately exit 0 (#2923). End instead of parking.
  if (transport.allowIdlePark === false) {
    endTransport(transport, "no-idle-park");
    return { ended: true, idle: false };
  }
  const ttl = Number.isFinite(transport.idleTtlMs) ? transport.idleTtlMs : defaultIdleTtlMs;
  const now = nowFn();

  transport.state = "idle";
  if (!opts.preserveIdleSince || !Number.isFinite(transport.idleSince)) {
    transport.idleSince = now;
  }

  if (!opts.preserveLru || !idleTransportsLru.has(transport.id)) {
    touchIdleTransportLru(transport);
  }
  enforceIdleTransportLimit();
  if (transport.state === "dead" || transport.state === "closing") {
    return { ended: true, idle: false };
  }

  // 0 (or negative/non-finite): park until quit/discard — matches settings
  // "Until app quit" and OpenSSH ControlPersist yes.
  if (!Number.isFinite(ttl) || ttl <= 0) {
    transport.idleDeadlineAt = null;
    return { ended: false, idle: true };
  }

  const elapsed = Math.max(0, now - transport.idleSince);
  const remaining = Math.max(0, ttl - elapsed);
  transport.idleDeadlineAt = transport.idleSince + ttl;
  if (remaining === 0) {
    endTransport(transport, "idle-ttl");
    return { ended: true, idle: false };
  }
  transport.idleTimer = timerApi.setTimeout(() => {
    transport.idleTimer = null;
    if (transport.state !== "idle" || transport.leases.size > 0) return;
    endTransport(transport, "idle-ttl");
  }, remaining);
  // Idle reuse is an optimization, not a reason to keep the app/test process
  // alive after every consumer has gone away.
  transport.idleTimer?.unref?.();

  return { ended: false, idle: true };
}

function wakeFromIdle(transport) {
  if (transport.state !== "idle") return;
  removeIdleTransportLru(transport);
  clearIdleTimer(transport);
  transport.state = "live";
  transport.idleSince = null;
  transport.idleDeadlineAt = null;
}

function attachEndpointIndex(transport) {
  if (!transport.endpointKey) return;
  let set = transportIdsByEndpoint.get(transport.endpointKey);
  if (!set) {
    set = new Set();
    transportIdsByEndpoint.set(transport.endpointKey, set);
  }
  set.add(transport.id);
}

function allocateLeaseId(kind) {
  nextLeaseSeq += 1;
  return `${kind || "lease"}-${nextLeaseSeq}-${randomUUID().slice(0, 8)}`;
}

/**
 * Create a transport around an authenticated ssh2 Client.
 * Does not automatically create a lease — call borrowTransport next, or use
 * createConnectionRef which creates + borrows a shell lease for a session.
 */
function createTransport({
  conn,
  chainConnections = [],
  endpoint = null,
  idleTtlMs = defaultIdleTtlMs,
  meta = null,
} = {}) {
  if (!conn) throw new Error("createTransport requires conn");

  const normalized = normalizeEndpoint(endpoint);
  const transport = {
    id: randomUUID(),
    // Compat: existing code reads connRef.count / conn / chainConnections /
    // shellOpenQueue on the shared descriptor.
    count: 0,
    conn,
    chainConnections: Array.isArray(chainConnections) ? chainConnections : [],
    shellOpenQueue: undefined,
    leases: new Map(),
    endpoint: normalized,
    endpointKey: buildEndpointKey(normalized),
    state: "live",
    idleTtlMs: Number.isFinite(idleTtlMs) && idleTtlMs >= 0 ? idleTtlMs : defaultIdleTtlMs,
    idleTimer: null,
    idleSince: null,
    idleDeadlineAt: null,
    createdAt: nowFn(),
    pendingShellReconnectRisk: null,
    closedShellPids: new Set(),
    closedShellPidUnknown: false,
    shellCloseGeneration: 0,
    allowIdlePark: endpointAllowsIdlePark(
      normalized,
      typeof conn?._remoteVer === "string" ? conn._remoteVer : "",
    ),
    allowShellReuse: true,
    meta: meta || null,
    endedReason: null,
    _poolOnConnectionClose: null,
    _poolOnConnectionError: null,
  };
  if (transport.allowIdlePark === false && transport.endpointKey) {
    noIdleParkEndpointKeys.add(transport.endpointKey);
  }

  transportsById.set(transport.id, transport);
  attachEndpointIndex(transport);
  attachTransportLifecycle(transport);
  return transport;
}

/**
 * Borrow a lease on a transport. Wakes idle park if needed.
 * Requires a registry transport from createTransport / createConnectionRef
 * (must have a leases Map) — bare { count, conn } objects are not accepted.
 *
 * @param {object} transport
 * @param {{ kind?: string, leaseId?: string, holder?: object|null, meta?: object }} [options]
 */
function borrowTransport(transport, options = {}) {
  if (!transport || transport.state === "dead" || transport.state === "closing") {
    throw new Error("Cannot borrow a closed SSH transport");
  }
  if (!(transport.leases instanceof Map)) {
    throw new Error(
      "Cannot borrow: not a registry transport (use createConnectionRef / createTransport)",
    );
  }
  if (!isTransportSocketHealthy(transport)) {
    endTransport(transport, "unhealthy");
    throw new Error("SSH transport socket is not healthy");
  }

  wakeFromIdle(transport);

  const kind = options.kind && LEASE_KINDS[options.kind] ? options.kind : (options.kind || "shell");
  const leaseId = options.leaseId || allocateLeaseId(kind);
  if (transport.leases.has(leaseId) || leasesById.has(leaseId)) {
    throw new Error(`SSH transport lease already exists: ${leaseId}`);
  }

  const holder = options.holder ?? null;
  const lease = {
    id: leaseId,
    kind,
    holder,
    meta: options.meta || null,
    borrowedAt: nowFn(),
  };
  transport.leases.set(leaseId, lease);
  leasesById.set(leaseId, { transport, holder });
  transport.count = transport.leases.size;
  transport.state = "live";

  if (holder && typeof holder === "object") {
    holder.connRef = transport;
    holder._sshTransportLeaseId = leaseId;
  }

  return { transport, leaseId, lease };
}

/**
 * Move an existing lease from a temporary holder to the real session without
 * changing the lease count. Used when Copy Tab / reuse opens a shell while
 * pinned on a refHolder, then hands the pin to the live session object.
 *
 * @returns {boolean} true if the lease was rebound
 */
function transferConnectionRef(fromHolder, toHolder) {
  if (!fromHolder || !toHolder || fromHolder === toHolder) return false;
  const leaseId = fromHolder._sshTransportLeaseId;
  const transport = fromHolder.connRef;
  if (!leaseId || !transport?.leases) return false;
  const lease = transport.leases.get(leaseId);
  if (!lease) return false;

  lease.holder = toHolder;
  if (lease.kind === LEASE_KINDS.shell && toHolder?.stream) {
    lease.meta = { ...(lease.meta || {}), activeShellChannel: true };
  }
  leasesById.set(leaseId, { transport, holder: toHolder });

  fromHolder.connRef = null;
  fromHolder._sshTransportLeaseId = null;
  toHolder.connRef = transport;
  toHolder._sshTransportLeaseId = leaseId;
  return true;
}

/**
 * Return a lease by id or by holder object (compat with session/refHolder).
 * @returns {{ released: boolean, ended: boolean, idle: boolean, remaining: number }}
 */
function returnTransport(leaseIdOrHolder) {
  if (leaseIdOrHolder == null) {
    return { released: false, ended: false, idle: false, remaining: 0 };
  }

  let leaseId = null;
  let holder = null;

  if (typeof leaseIdOrHolder === "string") {
    leaseId = leaseIdOrHolder;
  } else if (typeof leaseIdOrHolder === "object") {
    holder = leaseIdOrHolder;
    leaseId = holder._sshTransportLeaseId || null;
    // Legacy: holder still points at transport but lease id was lost — try match.
    if (!leaseId && holder.connRef?.leases) {
      for (const [id, lease] of holder.connRef.leases) {
        if (lease.holder === holder) {
          leaseId = id;
          break;
        }
      }
    }
  }

  if (!leaseId) {
    return { released: false, ended: false, idle: false, remaining: 0 };
  }

  const entry = leasesById.get(leaseId);
  if (!entry) {
    if (holder) {
      holder.connRef = null;
      holder._sshTransportLeaseId = null;
    }
    return { released: false, ended: false, idle: false, remaining: 0 };
  }

  const { transport } = entry;
  const releasedLease = transport.leases.get(leaseId);
  leasesById.delete(leaseId);
  transport.leases.delete(leaseId);
  transport.count = transport.leases.size;

  if (
    releasedLease?.kind === LEASE_KINDS.shell
    && releasedLease.meta?.activeShellChannel === true
  ) {
    transport.shellCloseGeneration = (transport.shellCloseGeneration || 0) + 1;
    const releasedPid = String(releasedLease.holder?.shellPid || "");
    if (/^\d+$/.test(releasedPid)) transport.closedShellPids.add(releasedPid);
    else transport.closedShellPidUnknown = true;
    const hasActiveShell = [...transport.leases.values()].some(
      (lease) => lease.kind === LEASE_KINDS.shell && lease.meta?.activeShellChannel === true,
    );
    if (!hasActiveShell) {
    // A locally closed shell channel can outlive its lease briefly on the
    // server. Remember that provenance even when SFTP/forward leases keep the
    // transport live, so the next shell does not guess cwd from the old PID.
      transport.pendingShellReconnectRisk = {
        oldShellPids: [...transport.closedShellPids],
        hasUnknownOldShell: transport.closedShellPidUnknown,
      };
      transport.closedShellPids.clear();
      transport.closedShellPidUnknown = false;
      // TERM-SSHD cannot host a later interactive shell on this connection
      // even while SFTP/forward leases keep the socket live (#2923).
      if (!remoteAllowsIdleParkedShellReuse(
        typeof transport.conn?._remoteVer === "string" ? transport.conn._remoteVer : "",
      )) {
        transport.allowShellReuse = false;
      }
    }
  }

  if (entry.holder && typeof entry.holder === "object") {
    if (entry.holder.connRef === transport) entry.holder.connRef = null;
    entry.holder._sshTransportLeaseId = null;
  } else if (holder) {
    holder.connRef = null;
    holder._sshTransportLeaseId = null;
  }

  if (transport.leases.size > 0) {
    return {
      released: true,
      ended: false,
      idle: false,
      remaining: transport.leases.size,
    };
  }

  const park = scheduleIdleEnd(transport);
  return {
    released: true,
    ended: park.ended,
    idle: park.idle,
    remaining: 0,
  };
}

function consumePendingShellReconnectRisk(transport) {
  if (!transport?.pendingShellReconnectRisk) return false;
  const risk = transport.pendingShellReconnectRisk;
  transport.pendingShellReconnectRisk = null;
  return risk;
}

function discardTransport(transportOrId, reason = "discard") {
  const transport = typeof transportOrId === "string"
    ? transportsById.get(transportOrId)
    : transportOrId;
  if (!transport) return false;
  return endTransport(transport, reason);
}

function discardAllTransports(reason = "discard-all") {
  failAllPendingDials(reason);
  let n = 0;
  for (const transport of [...transportsById.values()]) {
    if (endTransport(transport, reason)) n += 1;
  }
  return n;
}

function findTransportById(id) {
  const transport = transportsById.get(id);
  if (!transport || !isTransportSocketHealthy(transport)) return null;
  if (transport.state === "idle") touchIdleTransportLru(transport);
  return transport;
}

/**
 * Find a healthy live or idle transport for an endpoint.
 * Prefers live transports with fewer leases, then idle.
 *
 * @param {object} endpoint
 * @param {{ kind?: "shell"|"channel" }} [opts]
 *   kind defaults to "channel" (SFTP/PF asymmetric agentForwarding). Shell
 *   open paths must pass kind: "shell" for exact ForwardAgent policy match.
 */
function findTransportByEndpoint(endpoint, opts = {}) {
  const kind = opts?.kind === "shell" ? "shell" : "channel";
  const key = buildEndpointKey(endpoint);
  if (!key) return null;
  const ids = transportIdsByEndpoint.get(key);
  if (!ids || ids.size === 0) return null;

  /** @type {object[]} */
  const candidates = [];
  for (const id of ids) {
    const transport = transportsById.get(id);
    if (!transport) continue;
    if (!isTransportSocketHealthy(transport)) {
      // Socket died under park/live without last-lease teardown — drop it so
      // "Until app quit" cannot pin unusable jump chains forever.
      if (transport.state !== "dead") {
        endTransport(transport, "unhealthy-lookup");
      } else {
        unregisterTransport(transport);
      }
      continue;
    }
    if (transport.state !== "live" && transport.state !== "idle") continue;
    // A previous reused shell on this conn died immediately (齐治 TERM-SSHD).
    // SFTP/forward can keep using the socket; new shells must dial fresh.
    if (kind === "shell" && transport.allowShellReuse === false) continue;
    // Same route key can still fail agent-forwarding policy.
    if (endpoint && transport.endpoint && !endpointAllowsReuse(endpoint, transport.endpoint, kind)) {
      continue;
    }
    candidates.push(transport);
  }
  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    // Prefer live over idle, then fewer leases.
    if (a.state !== b.state) return a.state === "live" ? -1 : 1;
    return a.leases.size - b.leases.size;
  });
  const selected = candidates[0];
  if (selected.state === "idle") touchIdleTransportLru(selected);
  return selected;
}

function getTransportStats() {
  let live = 0;
  let idle = 0;
  let leases = 0;
  for (const t of transportsById.values()) {
    if (t.state === "live") live += 1;
    else if (t.state === "idle") idle += 1;
    leases += t.leases.size;
  }
  return {
    transports: transportsById.size,
    pendingDials: [...pendingDialsByEndpoint.values()]
      .reduce((total, records) => total + records.size, 0),
    live,
    idle,
    leases,
    defaultIdleTtlMs,
  };
}

function setDefaultTransportIdleTtlMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return defaultIdleTtlMs;
  // Renderer re-sends the current TTL on every window mount; skip when
  // unchanged so idle deadlines are not repeatedly extended.
  if (ms === defaultIdleTtlMs) return defaultIdleTtlMs;
  defaultIdleTtlMs = ms;
  // Reschedule already-idle transports so a settings change takes effect without
  // waiting for a new borrow/return cycle. Preserve idleSince so remaining
  // lifetime is based on when the transport actually became idle.
  for (const transport of transportsById.values()) {
    transport.idleTtlMs = defaultIdleTtlMs;
    if (transport.state === "idle" && transport.leases.size === 0) {
      scheduleIdleEnd(transport, { preserveIdleSince: true, preserveLru: true });
    }
  }
  return defaultIdleTtlMs;
}

function getDefaultTransportIdleTtlMs() {
  return defaultIdleTtlMs;
}

/**
 * Test helpers: reset registry and optionally inject timers/clock.
 */
function resetSshTransportRegistryForTests(options = {}) {
  discardAllTransports("test-reset");
  transportsById.clear();
  transportIdsByEndpoint.clear();
  leasesById.clear();
  pendingDialsByEndpoint.clear();
  idleTransportsLru.clear();
  noIdleParkEndpointKeys.clear();
  nextLeaseSeq = 0;
  defaultIdleTtlMs = Number.isFinite(options.defaultIdleTtlMs)
    ? options.defaultIdleTtlMs
    : resolveEnvIdleTtlMs(DEFAULT_SSH_TRANSPORT_IDLE_TTL_MS);
  maxIdleTransports = Number.isFinite(options.maxIdleTransports)
    && options.maxIdleTransports >= 0
    ? Math.floor(options.maxIdleTransports)
    : DEFAULT_MAX_IDLE_SSH_TRANSPORTS;
  timerApi = {
    setTimeout: options.setTimeout || ((...args) => setTimeout(...args)),
    clearTimeout: options.clearTimeout || ((...args) => clearTimeout(...args)),
  };
  nowFn = options.now || (() => Date.now());
}

// ---------------------------------------------------------------------------
// Compatibility wrappers (pre-registry call sites)
// ---------------------------------------------------------------------------

/**
 * Attach a fresh reference-counted connection descriptor to the session that
 * established the connection. Called once, for the "owner" session, right after
 * its shell channel opens.
 *
 * @param {object} session - the owner session object stored in the sessions Map
 * @param {object} conn - the ssh2 Client for the established connection
 * @param {Array} chainConnections - jump-host connections that must be ended
 *   together with the transport (owned by the connection, not any one channel)
 * @returns {object} transport descriptor (still exposed as session.connRef)
 */
function createConnectionRef(session, conn, chainConnections) {
  const endpoint = session?._reuseEndpoint
    ? {
      hostId: session._reuseEndpoint.hostId,
      hostname: session._reuseEndpoint.hostname,
      port: session._reuseEndpoint.port,
      username: session._reuseEndpoint.username,
      protocol: session._reuseEndpoint.protocol,
      sftpSudo: session._reuseEndpoint.sftpSudo,
      jumpFingerprint: session._reuseEndpoint.jumpFingerprint,
      jumpHosts: session._reuseEndpoint.jumpHosts,
      proxy: session._reuseEndpoint.proxy,
      proxyFingerprint: session._reuseEndpoint.proxyFingerprint,
      authType: session._reuseEndpoint.authType,
      keyId: session._reuseEndpoint.keyId,
      certificate: session._reuseEndpoint.certificate,
      requiresMfa: session._reuseEndpoint.requiresMfa,
      verifyHostKeys: session._reuseEndpoint.verifyHostKeys,
      useSshAgent: session._reuseEndpoint.useSshAgent,
      agentForwarding: session._reuseEndpoint.agentForwarding,
      forwardingAgentFingerprint: session._reuseEndpoint.forwardingAgentFingerprint,
      keepaliveIntervalMs: session._reuseEndpoint.keepaliveIntervalMs,
      keepaliveCountMax: session._reuseEndpoint.keepaliveCountMax,
      authFingerprint: session._reuseEndpoint.authFingerprint,
    }
    : null;

  const transport = createTransport({
    conn,
    chainConnections,
    endpoint,
    idleTtlMs: defaultIdleTtlMs,
  });
  applyIdleParkPolicy(
    transport,
    session?.remoteSshVersion || (typeof conn?._remoteVer === "string" ? conn._remoteVer : ""),
  );

  borrowTransport(transport, {
    kind: LEASE_KINDS.shell,
    holder: session,
    // Unique per connection generation: same sessionId can reconnect while an
    // old lease is still draining (same-session reconnect path).
    meta: {
      source: "createConnectionRef",
      sessionId: session?.id || null,
      activeShellChannel: true,
    },
  });

  return transport;
}

/**
 * Register an additional session (a reused channel) against an existing
 * connection descriptor, incrementing its reference count.
 *
 * @param {object} session - the new session sharing the connection
 * @param {object} connRef - transport from createConnectionRef / createTransport
 */
function acquireConnectionRef(session, connRef) {
  if (!connRef) return;
  const kind = session?.__sshLeaseKind && LEASE_KINDS[session.__sshLeaseKind]
    ? session.__sshLeaseKind
    : LEASE_KINDS.shell;

  // If this holder already has a lease on this transport, no-op (idempotent).
  if (session?._sshTransportLeaseId && connRef.leases?.has(session._sshTransportLeaseId)) {
    return;
  }

  borrowTransport(connRef, {
    kind,
    holder: session,
    // Always allocate a unique lease id — stable session/sftp ids can collide
    // across reconnect generations while old leases drain.
    meta: {
      source: "acquireConnectionRef",
      holderId: session?.id || null,
      activeShellChannel: kind === LEASE_KINDS.shell && Boolean(session?.stream),
    },
  });
}

/**
 * Release this session's hold on its shared connection.
 *
 * Decrements the lease count. When it reaches zero the transport enters idle
 * park; TTL 0 keeps it parked until app quit, while a positive TTL reclaims it
 * when the deadline expires. The caller remains responsible
 * for closing this session's own shell stream/channel; this only governs the
 * *shared* transport.
 *
 * Safe to call multiple times for the same session — the lease is detached
 * after the first release so a later duplicate call is a no-op.
 *
 * @param {object} session - the session being torn down
 * @returns {boolean} true if the shared transport was ended by this call
 */
function releaseConnectionRef(session) {
  const result = returnTransport(session);
  return result.ended;
}

/**
 * Find a live, fully-connected session whose authenticated SSH connection can
 * host an additional shell channel. Used to satisfy a reuse request from a
 * duplicated tab.
 *
 * Returns null when the source session is gone, has no usable connection, is
 * not an interactive SSH shell session (e.g. SFTP-only or local sessions), or
 * authenticated to a *different* target than the one now requested, so the
 * caller can safely fall back to establishing a fresh connection.
 *
 * @param {Map} sessions - the shared sessions Map
 * @param {string} sourceSessionId - id of the session to reuse
 * @param {{ hostname: string, port?: number, username?: string }} [requestedTarget]
 * @returns {object|null} the reusable source session, or null
 */
function findReusableSession(sessions, sourceSessionId, requestedTarget) {
  if (!sessions || !sourceSessionId) return null;
  const source = sessions.get(sourceSessionId);
  if (!source) return null;
  // Must be an interactive SSH shell session with a connection we own a
  // reference to. `stream` + `connRef` are only set for shell sessions started
  // through startSession.cjs; SFTP/exec-only or local/telnet/serial sessions
  // won't have both, so they're skipped.
  if (!source.conn || !source.stream || !source.connRef) return null;
  // Registry-managed transports: refuse dead/closing.
  if (source.connRef.state === "dead" || source.connRef.state === "closing") return null;
  // Last interactive shell already left this conn and the daemon cannot host
  // another one (TERM-SSHD). The captured Copy Tab pin can still keep the
  // transport live; refuse so start() dials fresh instead of opening a
  // channel that will exit 0 immediately.
  if (source.connRef.allowShellReuse === false) return null;
  // ssh2 Client exposes no public "is connected" flag; rely on the descriptor
  // still being attached (it is nulled out on teardown) plus a non-destroyed
  // underlying socket when ssh2 exposes one.
  const sock = source.conn._sock;
  if (sock && sock.destroyed) return null;

  if (requestedTarget) {
    const ep = source._reuseEndpoint || source.connRef.endpoint;
    // No recorded endpoint -> can't prove it's the same target, so don't reuse.
    if (!ep) return null;
    // Shell reuse always requires exact ForwardAgent policy match.
    if (!endpointAllowsReuse(requestedTarget, ep, "shell")) return null;
  }

  return source;
}

/**
 * Resolve a transport for channel reuse: prefer an explicit source session,
 * otherwise any healthy transport for the endpoint (including idle park).
 * @param {{ sessions?: Map, sourceSessionId?: string, endpoint?: object, kind?: "shell"|"channel" }} opts
 */
function resolveTransportForReuse({
  sessions,
  sourceSessionId,
  endpoint,
  kind = "channel",
} = {}) {
  if (sourceSessionId && sessions) {
    const source = findReusableSession(
      sessions,
      sourceSessionId,
      endpoint || undefined,
    );
    if (source?.connRef && isTransportSocketHealthy(source.connRef)) {
      // findReusableSession already enforced shell agent-forwarding policy.
      if (kind === "shell" || !endpoint || endpointAllowsReuse(endpoint, source._reuseEndpoint || source.connRef.endpoint, kind)) {
        return source.connRef;
      }
    }
  }
  if (endpoint) {
    return findTransportByEndpoint(endpoint, { kind });
  }
  return null;
}

module.exports = {
  // Constants
  DEFAULT_SSH_TRANSPORT_IDLE_TTL_MS,
  DEFAULT_MAX_IDLE_SSH_TRANSPORTS,
  STORAGE_KEY_SSH_TRANSPORT_IDLE_TTL_MS,
  LEASE_KINDS,
  // New registry API
  createTransport,
  borrowTransport,
  returnTransport,
  discardTransport,
  discardAllTransports,
  findTransportById,
  findTransportByEndpoint,
  resolveTransportForReuse,
  beginTransportDial,
  waitForTransportDial,
  completeTransportDial,
  failTransportDial,
  getTransportStats,
  setDefaultTransportIdleTtlMs,
  getDefaultTransportIdleTtlMs,
  buildEndpointKey,
  buildConnectionReuseEndpoint,
  resolveConnectionKeepalivePolicy,
  normalizeEndpoint,
  sameEndpoint,
  endpointAllowsReuse,
  fingerprintAuth,
  digestAuthMaterial,
  resetSshTransportRegistryForTests,
  // Compat API
  createConnectionRef,
  acquireConnectionRef,
  releaseConnectionRef,
  transferConnectionRef,
  consumePendingShellReconnectRisk,
  findReusableSession,
  markEndpointNoIdlePark,
  endpointAllowsIdlePark,
  applyIdleParkPolicy,
};
