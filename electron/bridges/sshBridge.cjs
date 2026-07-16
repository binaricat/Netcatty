/**
 * SSH Bridge - Handles SSH connections, sessions, and related operations
 * Extracted from main.cjs for single responsibility
 */

const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const os = require("node:os");
const crypto = require("node:crypto");
const { exec } = require("node:child_process");
require("./boringSslDhCompat.cjs").installBoringSslDhCompat();
const { Client: SSHClient, utils: sshUtils } = require("ssh2");
const { NetcattyAgent } = require("./netcattyAgent.cjs");
const keyboardInteractiveHandler = require("./keyboardInteractiveHandler.cjs");
const passphraseHandler = require("./passphraseHandler.cjs");
const hostKeyVerifier = require("./hostKeyVerifier.cjs");
const { createProxySocket, runWhenProxyConnectionReady } = require("./proxyUtils.cjs");
const { attachX11Forwarding } = require("./x11Forwarding.cjs");
const { createPtyOutputBuffer } = require("./ptyOutputBuffer.cjs");
const {
  buildAuthHandler,
  createKeyboardInteractiveHandler,
  createOrderedStringAuthHandler,
  createAuthPhase,
  markAuthPhasePartialSuccess,
  canRepeatKeyboardInteractive,
  shouldSkipKiPasswordAutoFill,
  applyAuthToConnOpts,
  safeSend: authSafeSend,
  requestPassphrasesForEncryptedKeys,
  findAllDefaultPrivateKeys: findAllDefaultPrivateKeysFromHelper,
  getSshAgentSocket,
  getAvailableAgentSocket: getAvailableSystemAgentSocket,
  prepareSystemSshAgentForAuth,
  readFileNoFollow,
  expandIdentityFilePath,
  isAutoFillablePasswordChallenge,
  preparePrivateKeyForAuth,
  loadIdentityFileForAuth,
  loadFirstIdentityFileForAuth,
  hasUserConfiguredKey,
  isPasswordProvided,
  PassphraseCancelledError,
  isPassphraseCancelledError,
} = require("./sshAuthHelper.cjs");
const sessionLogStreamManager = require("./sessionLogStreamManager.cjs");
const { trackSessionIdlePrompt, looksLikeIdleAutoLogout } = require("./ai/shellUtils.cjs");
const { createZmodemSentry } = require("./zmodemHelper.cjs");
const tempDirBridge = require("./tempDirBridge.cjs");
const {
  buildAlgorithms,
  _resetAlgorithmSupportCacheForTests,
} = require("./sshAlgorithms.cjs");
const { enableSshNoDelay, enableTcpNoDelay } = require("./tcpNoDelay.cjs");
const { createTcpConnectLatencyProbe } = require("./tcpConnectLatency.cjs");
const {
  configureTerminalSessionDataEmitter,
} = require("./emitTerminalSessionData.cjs");

// Default SSH key names in priority order (preferred keys tried first)
const PREFERRED_KEY_NAMES = ["id_ed25519", "id_ecdsa", "id_rsa"];
// Match any private key file: id_* but not *.pub
const SSH_KEY_PATTERN = /^id_[\w-]+$/;
const {
  createStartSessionApi,
  resolveSshConnectionTimeouts,
} = require("./sshBridge/startSession.cjs");

function quoteShellArg(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function hasUsableProxy(proxy) {
  if (!proxy) return false;
  if (proxy.type === "command") return !!proxy.command?.trim();
  return !!(proxy.host && proxy.port);
}

/**
 * Quick check if file content looks like an SSH private key.
 * Rejects non-key files that happen to match the id_* filename pattern.
 */
function looksLikePrivateKey(content) {
  if (!content || typeof content !== "string") return false;
  const trimmed = content.trimStart();
  return trimmed.startsWith("-----BEGIN") ||
    trimmed.startsWith("openssh-key-v1") ||
    trimmed.startsWith("PuTTY-User-Key-File");
}

/**
 * Check if an SSH private key is encrypted (requires passphrase)
 * @param {string} keyContent - The content of the private key file
 * @returns {boolean} - True if the key is encrypted
 */
function isKeyEncrypted(keyContent) {
  // Check for PuTTY PPK encrypted format
  const ppkEncMatch = keyContent.match(/^Encryption:\s*(.+)$/m);
  if (ppkEncMatch && ppkEncMatch[1].trim() !== "none") {
    return true;
  }

  // Check for PKCS#8 encrypted format (-----BEGIN ENCRYPTED PRIVATE KEY-----)
  if (keyContent.includes("-----BEGIN ENCRYPTED PRIVATE KEY-----")) {
    return true;
  }

  // Check for legacy PEM format encryption (e.g., RSA PRIVATE KEY with encryption)
  if (keyContent.includes("Proc-Type:") && keyContent.includes("ENCRYPTED")) {
    return true;
  }

  // Check for OpenSSH format keys
  if (keyContent.includes("-----BEGIN OPENSSH PRIVATE KEY-----")) {
    try {
      // Extract the base64 content between the markers
      const base64Match = keyContent.match(
        /-----BEGIN OPENSSH PRIVATE KEY-----\s*([\s\S]*?)\s*-----END OPENSSH PRIVATE KEY-----/
      );
      if (base64Match) {
        const base64Content = base64Match[1].replace(/\s/g, "");
        const keyBuffer = Buffer.from(base64Content, "base64");

        // OpenSSH key format: "openssh-key-v1\0" followed by cipher name
        // If ciphername is "none", the key is not encrypted
        const authMagic = "openssh-key-v1\0";
        if (keyBuffer.toString("ascii", 0, authMagic.length) === authMagic) {
          // After magic, read ciphername (length-prefixed string)
          let offset = authMagic.length;
          const cipherNameLen = keyBuffer.readUInt32BE(offset);
          offset += 4;
          const cipherName = keyBuffer.toString("ascii", offset, offset + cipherNameLen);
          return cipherName !== "none";
        }
      }
    } catch {
      // If parsing fails, assume it might be encrypted to be safe
      return true;
    }
  }

  return false;
}

/**
 * Find default SSH private key from user's ~/.ssh directory
 * Skips encrypted keys that require a passphrase to allow password/keyboard-interactive auth
 * @returns {Promise<{ privateKey: string, keyPath: string, keyName: string } | null>}
 */
async function findDefaultPrivateKey() {
  const sshDir = path.join(os.homedir(), ".ssh");
  // Scan ~/.ssh/ for all files matching id_* (same as Tabby/OpenSSH),
  // with preferred key types tried first
  let allNames = [];
  try {
    const entries = await fs.promises.readdir(sshDir);
    allNames = entries.filter(f => SSH_KEY_PATTERN.test(f));
  } catch {
    return null;
  }
  // Sort: preferred keys first (in order), then rest alphabetically
  const preferred = PREFERRED_KEY_NAMES.filter(n => allNames.includes(n));
  const rest = allNames.filter(n => !PREFERRED_KEY_NAMES.includes(n)).sort();
  const sorted = [...preferred, ...rest];
  log("Searching for default SSH keys", { sshDir, found: sorted });

  for (const name of sorted) {
    const keyPath = path.join(sshDir, name);
    try {
      const privateKey = await readFileNoFollow(keyPath);
      if (!privateKey) continue;
      if (!looksLikePrivateKey(privateKey)) {
        log("Skipping non-key file", { keyPath, keyName: name });
        continue;
      }
      const encrypted = isKeyEncrypted(privateKey);
      log("Key file read", { keyPath, keyName: name, encrypted, keyLength: privateKey.length });
      if (encrypted) {
        log("Skipping encrypted default key", { keyPath, keyName: name });
        continue;
      }
      log("Found default key", { keyPath, keyName: name });
      return { privateKey, keyPath, keyName: name };
    } catch (e) {
      log("Failed to read default key", { keyPath, error: e.message });
      continue;
    }
  }
  log("No suitable default SSH key found");
  return null;
}

/**
 * Find ALL default SSH private keys from user's ~/.ssh directory
 * Returns all non-encrypted keys for fallback authentication
 * @returns {Promise<Array<{ privateKey: string, keyPath: string, keyName: string }>>}
 */
async function findAllDefaultPrivateKeys() {
  const sshDir = path.join(os.homedir(), ".ssh");
  let allNames = [];
  try {
    const entries = await fs.promises.readdir(sshDir);
    allNames = entries.filter(f => SSH_KEY_PATTERN.test(f));
  } catch {
    return [];
  }
  const preferred = PREFERRED_KEY_NAMES.filter(n => allNames.includes(n));
  const rest = allNames.filter(n => !PREFERRED_KEY_NAMES.includes(n)).sort();
  const sorted = [...preferred, ...rest];
  log("Searching for ALL default SSH keys", { sshDir, found: sorted });

  const promises = sorted.map(async (name) => {
    const keyPath = path.join(sshDir, name);
    try {
      const privateKey = await readFileNoFollow(keyPath);
      if (!privateKey) return null;
      if (!looksLikePrivateKey(privateKey)) {
        log("Skipping non-key file", { keyPath, keyName: name });
        return null;
      }
      const encrypted = isKeyEncrypted(privateKey);
      if (!encrypted) {
        log("Found default key for fallback", { keyPath, keyName: name });
        return { privateKey, keyPath, keyName: name };
      } else {
        log("Skipping encrypted key", { keyPath, keyName: name });
        return null;
      }
    } catch (e) {
      log("Failed to read key", { keyPath, error: e.message });
      return null;
    }
  });

  const results = await Promise.all(promises);
  const keys = results.filter(Boolean);
  log("Found default SSH keys", { count: keys.length, keyNames: keys.map(k => k.keyName) });
  return keys;
}

const WIN_SSH_AGENT_PIPE = "\\\\.\\pipe\\openssh-ssh-agent";

/**
 * Check if an SSH agent is available on Windows by connecting to the
 * well-known named pipe. fs.statSync is unreliable for named pipes (returns
 * EBUSY even when usable), so we use net.connect() as the authoritative check.
 * @returns {Promise<{ running: boolean, startupType: string | null, error: string | null }>}
 */
function checkWindowsSshAgent() {
  if (process.platform !== "win32") {
    return Promise.resolve({ running: true, startupType: null, error: null });
  }
  const net = require("net");
  return new Promise((resolve) => {
    const socket = net.connect(WIN_SSH_AGENT_PIPE);
    let settled = false;
    const finish = (ok, error) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch {}
      resolve({
        running: ok,
        startupType: ok ? "running" : "stopped",
        error: ok ? null : (error || "SSH Agent pipe not connectable"),
      });
    };
    socket.setTimeout(1000);
    socket.once("connect", () => finish(true, null));
    socket.once("timeout", () => finish(false, "SSH Agent pipe connect timeout"));
    socket.once("error", (err) => finish(false, err.message));
  });
}

async function getAvailableAgentSocket() {
  if (process.platform === "win32") {
    const agentStatus = await checkWindowsSshAgent();
    log("Windows SSH Agent check", agentStatus);
    return agentStatus.running ? WIN_SSH_AGENT_PIPE : null;
  }

  return getSshAgentSocket();
}

const SSH_DEBUG_REDACTED_KEYS = new Set([
  "password",
  "passphrase",
  "privateKey",
  "key",
  "certificate",
]);
let sshDebugLoggingEnabled = process.env.NETCATTY_SSH_DEBUG === "1";
let sshDebugLogFilePath = tempDirBridge.getTempFilePath("netcatty-ssh.log");

function sanitizeSshDebugValue(value, key = "") {
  if (SSH_DEBUG_REDACTED_KEYS.has(key)) return "[redacted]";
  if (Array.isArray(value)) return value.map((item) => sanitizeSshDebugValue(item));
  if (value && typeof value === "object") {
    const result = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      result[entryKey] = sanitizeSshDebugValue(entryValue, entryKey);
    }
    return result;
  }
  return value;
}

function setSshDebugLoggingEnabled(enabled, options = {}) {
  sshDebugLoggingEnabled = !!enabled;
  if (typeof options.logFilePath === "string" && options.logFilePath.trim()) {
    sshDebugLogFilePath = options.logFilePath;
  }
}

function isSshDebugLoggingEnabled() {
  return sshDebugLoggingEnabled;
}

function getSshDebugLogFilePath() {
  return sshDebugLogFilePath;
}

function appendSshDiagnosticLog(msg, data, options = {}) {
  const enabled = Object.prototype.hasOwnProperty.call(options, "enabled")
    ? !!options.enabled
    : isSshDebugLoggingEnabled();
  if (!enabled) return;
  const safeData = data ? sanitizeSshDebugValue(data) : undefined;
  const line = `[${new Date().toISOString()}] ${msg} ${safeData ? JSON.stringify(safeData) : ""}\n`;
  try { fs.appendFileSync(sshDebugLogFilePath, line); } catch { }
  console.log("[SSH]", msg, safeData ? JSON.stringify(safeData, null, 2) : "");
}

const log = appendSshDiagnosticLog;
log.isEnabled = isSshDebugLoggingEnabled;

function createSshDiagnosticLogger(enabled) {
  const isEnabled = !!enabled;
  const logger = (msg, data) => appendSshDiagnosticLog(msg, data, { enabled: isEnabled });
  logger.isEnabled = () => isEnabled;
  return logger;
}

function shouldLogSshDebugMessage(msg) {
  if (typeof msg !== "string") return false;
  return /auth|publickey|keyboard|handshake|kex|newkeys|dh gex/i.test(msg);
}

function attachSshDebugLogger(connectOpts, logger = log) {
  if (typeof logger.isEnabled === "function" && !logger.isEnabled()) return;
  connectOpts.debug = (msg) => {
    if (shouldLogSshDebugMessage(msg)) {
      logger("ssh2 debug", { msg });
    }
  };
}

function logSshAlgorithms(label, algorithms, extra = {}, logger = log) {
  logger(`${label} algorithm configuration`, {
    ...extra,
    kex: algorithms.kex,
    cipher: algorithms.cipher,
    hmac: algorithms.hmac,
    serverHostKey: algorithms.serverHostKey,
  });
}

async function getSshDebugLogInfo() {
  let size = 0;
  let exists = false;
  try {
    const stat = await fs.promises.stat(sshDebugLogFilePath);
    exists = stat.isFile();
    size = stat.size;
  } catch {
    exists = false;
  }
  return {
    enabled: isSshDebugLoggingEnabled(),
    path: sshDebugLogFilePath,
    exists,
    size,
  };
}

async function openSshDebugLogDir() {
  if (!electronModule?.shell?.openPath) return { success: false, error: "shell unavailable" };
  try {
    await fs.promises.mkdir(path.dirname(sshDebugLogFilePath), { recursive: true });
    const error = await electronModule.shell.openPath(path.dirname(sshDebugLogFilePath));
    return error ? { success: false, error } : { success: true };
  } catch (err) {
    return { success: false, error: err?.message || String(err) };
  }
}

// Session storage - shared reference passed from main
let sessions = null;
let electronModule = null;
let terminalOutputChannel = null;
let selectZmodemUploadFiles = null;
let selectZmodemDownloadDirectory = null;

// Authentication method cache - remembers successful auth methods per host
// Key format: "username@hostname:port"
// Value: { method: "password" | "publickey" | "publickey-default" }
// Cache persists until auth failure, then cleared to retry all methods
const authMethodCache = new Map();

// Per-session terminal encoding (default: utf-8)
const sessionEncodings = new Map();
// Per-session stateful iconv decoders (keyed by sessionId, value: { stdout, stderr })
const sessionDecoders = new Map();
const iconv = require("iconv-lite");
const { encodeTerminalInput, normalizeTerminalEncoding } = require("./terminalEncoding.cjs");

function getSessionDecoder(sessionId, stream) {
  let decoders = sessionDecoders.get(sessionId);
  if (!decoders) {
    decoders = { stdout: null, stderr: null };
    sessionDecoders.set(sessionId, decoders);
  }
  if (!decoders[stream]) {
    const enc = sessionEncodings.get(sessionId) || "utf-8";
    decoders[stream] = iconv.getDecoder(enc);
  }
  return decoders[stream];
}

function resetSessionDecoders(sessionId) {
  const enc = sessionEncodings.get(sessionId) || "utf-8";
  const decoders = { stdout: iconv.getDecoder(enc), stderr: iconv.getDecoder(enc) };
  sessionDecoders.set(sessionId, decoders);
}

function getAuthCacheKey(username, hostname, port) {
  return `${username}@${hostname}:${port || 22}`;
}

function getCachedAuthMethod(username, hostname, port) {
  const key = getAuthCacheKey(username, hostname, port);
  const cached = authMethodCache.get(key);
  if (cached) {
    log("Using cached auth method", { key, method: cached.method });
    return cached.method;
  }
  return null;
}

function setCachedAuthMethod(username, hostname, port, method) {
  const key = getAuthCacheKey(username, hostname, port);
  log("Caching successful auth method", { key, method });
  authMethodCache.set(key, { method });
}

function clearCachedAuthMethod(username, hostname, port) {
  const key = getAuthCacheKey(username, hostname, port);
  log("Clearing cached auth method", { key });
  authMethodCache.delete(key);
}

const { safeSend } = require("./ipcUtils.cjs");
const {
  createConnectionRef,
  acquireConnectionRef,
  releaseConnectionRef,
  findReusableSession,
} = require("./sshConnectionPool.cjs");

const zmodemOverwritePending = new Map(); // requestId -> (decision) => void

/**
 * Initialize the SSH bridge with dependencies
 */
function init(deps) {
  sessions = deps.sessions;
  electronModule = deps.electronModule;
  terminalOutputChannel = deps.terminalOutputChannel || null;
  selectZmodemUploadFiles = deps.selectZmodemUploadFiles || null;
  selectZmodemDownloadDirectory = deps.selectZmodemDownloadDirectory || null;
  configureTerminalSessionDataEmitter({
    getSession: (sessionId) => sessions?.get(sessionId),
    outputChannel: terminalOutputChannel,
  });
}

function openTerminalOutputSession(sessionId, webContents) {
  terminalOutputChannel?.openSession?.(sessionId, webContents);
}

function closeTerminalOutputSession(sessionId) {
  terminalOutputChannel?.closeSession?.(sessionId);
}

/**
 * Connect through a chain of jump hosts
 */
async function connectThroughChain(event, options, jumpHosts, targetHost, targetPort, sessionId) {
  const targetConnectionTimeouts = resolveSshConnectionTimeouts(options);
  const sender = event.sender;
  const connections = options?._connectionsRef || [];
  const sshDiagnosticLogger = options?._sshDiagnosticLogger || log;
  const keyboardInteractiveScope = options?._keyboardInteractiveScope || "terminal";
  let currentSocket = null;

  const sendProgress = (hop, total, label, status, error) => {
    if (!sender.isDestroyed()) {
      sender.send("netcatty:chain:progress", { sessionId, hop, total, label, status, error });
    }
  };

  try {
    const totalHops = jumpHosts.length;

    // Connect through each jump host
    for (let i = 0; i < jumpHosts.length; i++) {
      const jump = jumpHosts[i];
      const isFirst = i === 0;
      const isLast = i === jumpHosts.length - 1;
      const hopLabel = jump.label || (jump.hostname.includes(':') && !jump.hostname.startsWith('[') ? `[${jump.hostname}]:${jump.port || 22}` : `${jump.hostname}:${jump.port || 22}`);

      sendProgress(i + 1, totalHops + 1, hopLabel, 'connecting');

      const conn = new SSHClient();
      if (options?._tunnelRef) {
        options._tunnelRef.pendingConn = conn;
        options._tunnelRef.chainConnections = connections;
      }

      // Per-hop keepalive. Each jump entry already carries its own resolved
      // interval/countMax (see resolveHostKeepalive in domain/host.ts), so
      // a chain with a router as the bastion and a cloud host at the end
      // can have keepalive=0 on the bastion and the cloud-friendly values
      // on the final target — without one stepping on the other. We fall
      // back to the target-call options for backward compat with older
      // serializers that don't populate the per-hop fields yet.
      const hopInterval = jump.keepaliveInterval ?? options.keepaliveInterval ?? 0;
      const hopCountMax = jump.keepaliveCountMax ?? options.keepaliveCountMax ?? 10;
      const hopConnectionTimeouts = resolveSshConnectionTimeouts(jump);
      // Build connection options
      const connOpts = {
        host: jump.hostname,
        port: jump.port || 22,
        username: jump.username || 'root',
        timeout: hopConnectionTimeouts.tcpConnectTimeoutMs,
        // ssh2 starts readyTimeout before TCP connects. The auth-ready timer
        // below starts explicitly from the connection event instead.
        readyTimeout: 0,
        keepaliveInterval: hopInterval > 0 ? hopInterval * 1000 : 0,
        keepaliveCountMax: hopInterval > 0 ? hopCountMax : 0,
        // Enable keyboard-interactive authentication (required for 2FA/MFA)
        tryKeyboard: true,
        // Per-hop algorithm settings. Two distinct semantics:
        //
        // - `legacyAlgorithms` is *append-only* — it widens the offered
        //   list — so falling back to the target's setting when the hop
        //   didn't override is safe and matches the historic chain-wide
        //   behavior (a user with a single old leaf only needs to flip
        //   the toggle on the leaf).
        //
        // - `skipEcdsaHostKey` and `algorithmOverrides` *narrow* the
        //   offered list (the first removes every `ecdsa-sha2-*`, the
        //   second replaces a category outright). Propagating those to
        //   a bastion that doesn't need them can lock the hop to
        //   algorithms it doesn't accept — e.g. an Ed25519-only bastion
        //   would still negotiate while ECDSA was offered, but breaks
        //   when the leaf's ECDSA skip is applied to it. Treat both as
        //   strictly per-host: an unset hop value uses the hop's default
        //   offer, not the leaf's narrower setting.
        algorithms: buildAlgorithms(
          jump.legacyAlgorithms ?? options.legacyAlgorithms,
          {
            skipEcdsaHostKey: jump.skipEcdsaHostKey,
            algorithmOverrides: jump.algorithmOverrides,
          },
        ),
      };
      connOpts.hostVerifier = hostKeyVerifier.createHostVerifier({
        sender,
        sessionId,
        hostname: jump.hostname,
        port: jump.port || 22,
        knownHosts: options.knownHosts,
        verifyHostKeys: jump.verifyHostKeys ?? options.verifyHostKeys,
      });
      attachSshDebugLogger(connOpts, sshDiagnosticLogger);
      logSshAlgorithms("Jump host", connOpts.algorithms, {
        hostname: jump.hostname,
        port: jump.port || 22,
        legacyAlgorithms: !!(jump.legacyAlgorithms ?? options.legacyAlgorithms),
        skipEcdsaHostKey: !!jump.skipEcdsaHostKey,
        hasAlgorithmOverrides: !!jump.algorithmOverrides,
      }, sshDiagnosticLogger);

      // Auth - support agent (certificate), key, password, and default key fallback
      const hasCertificate =
        typeof jump.certificate === "string" && jump.certificate.trim().length > 0;

      const systemAuthAgent = hasCertificate
        ? null
        : await prepareSystemSshAgentForAuth(jump, `[Chain] Hop ${i + 1}:`);

      const identityFile = !jump.privateKey && !systemAuthAgent
        ? await loadFirstIdentityFileForAuth({
          sender,
          identityFilePaths: jump.identityFilePaths,
          hostname: hopLabel,
          initialPassphrase: jump.passphrase,
          passphraseSignal: options._passphraseSignal,
          logPrefix: `[Chain] Hop ${i + 1}:`,
          onPassphrasePromptShown: () => sendProgress(
            i + 1, totalHops + 1, hopLabel, "auth-attempt", "waiting for user input...",
          ),
          onPassphrasePromptResolved: () => sendProgress(
            i + 1, totalHops + 1, hopLabel, "auth-attempt", "user responded",
          ),
          onLoaded: (loaded) => {
            if (loaded.passphrase) {
              sendProgress(i + 1, totalHops + 1, hopLabel, 'auth-attempt', 'passphrase required');
            }
            console.log(`[Chain] Hop ${i + 1}: loaded identity file ${loaded.keyPath}`);
          },
          onError: (err, keyPath) => {
            console.warn(`[Chain] Hop ${i + 1}: failed to read identity file ${keyPath}:`, err.message);
          },
        })
        : null;
      const inlineKey = jump.privateKey && !systemAuthAgent
        ? await preparePrivateKeyForAuth({
          sender,
          privateKey: jump.privateKey,
          keyId: jump.keyId,
          keyName: jump.keyId || jump.label || jump.username,
          hostname: hopLabel,
          initialPassphrase: jump.passphrase,
          passphraseSignal: options._passphraseSignal,
          logPrefix: `[Chain] Hop ${i + 1}:`,
          onPassphrasePromptShown: () => sendProgress(
            i + 1, totalHops + 1, hopLabel, "auth-attempt", "waiting for user input...",
          ),
          onPassphrasePromptResolved: () => sendProgress(
            i + 1, totalHops + 1, hopLabel, "auth-attempt", "user responded",
          ),
        })
        : null;
      const effectivePrivateKey = inlineKey?.privateKey || identityFile?.privateKey;
      const effectivePassphrase = inlineKey?.passphrase || identityFile?.passphrase;

      let authAgent = null;
      if (systemAuthAgent) {
        connOpts.agent = systemAuthAgent;
      }
      if (hasCertificate) {
        authAgent = new NetcattyAgent({
          mode: "certificate",
          webContents: event.sender,
          meta: {
            label: jump.keyId || jump.username || "",
            certificate: jump.certificate,
            privateKey: effectivePrivateKey,
            passphrase: effectivePassphrase,
          },
        });
        connOpts.agent = authAgent;
      } else if (effectivePrivateKey) {
        connOpts.privateKey = effectivePrivateKey;
        if (effectivePassphrase) {
          connOpts.passphrase = effectivePassphrase;
        } else if (jump.privateKey && isKeyEncrypted(jump.privateKey)) {
          // Key is encrypted but no passphrase provided — prompt the user
          console.log(`[Chain] Hop ${i + 1}: key is encrypted, requesting passphrase`);
          sendProgress(i + 1, totalHops + 1, hopLabel, 'auth-attempt', 'waiting for user input...');
          const keyLabel = jump.label || hopLabel;
          const result = await passphraseHandler.requestPassphrase(
            sender,
            `SSH key for ${keyLabel}`,
            keyLabel,
            hopLabel,
            false,
            { signal: options._passphraseSignal }
          );
          sendProgress(i + 1, totalHops + 1, hopLabel, 'auth-attempt', 'user responded');
          if (result?.passphrase) {
            connOpts.passphrase = result.passphrase;
          } else {
            // No passphrase (cancelled/skipped/timeout) — remove the encrypted
            // key so buildAuthHandler won't try it and stall auth.
            delete connOpts.privateKey;
            if (result?.cancelled) {
              throw new PassphraseCancelledError(hopLabel);
            }
          }
        }
      }

      if (jump.password) connOpts.password = jump.password;

      // Get default keys (either from options if pre-fetched, or fetch them now)
      const defaultKeys = systemAuthAgent && jump.identitiesOnly
        ? []
        : options._defaultKeys || await findAllDefaultPrivateKeys();

      // Build auth handler using shared helper
      // Pass unlocked encrypted keys from options so jump hosts can use them for retry
      const fallbackAgentSocket = jump.useSshAgent === false
        ? null
        : jump.useSshAgent === true
          ? undefined
          : await getAvailableAgentSocket();
      const authConfig = buildAuthHandler({
        authMethod: jump.authMethod,
        privateKey: connOpts.privateKey,
        password: connOpts.password,
        passphrase: connOpts.passphrase,
        agent: connOpts.agent,
        username: connOpts.username,
        logPrefix: `[Chain] Hop ${i + 1}`,
        unlockedEncryptedKeys: systemAuthAgent && jump.identitiesOnly
          ? []
          : options._unlockedEncryptedKeys || [],
        defaultKeys,
        sshAgentSocketOverride: fallbackAgentSocket,
        allowAgentFallback: jump.useSshAgent !== false,
        onAuthAttempt: (method) => {
          sendProgress(i + 1, totalHops + 1, hopLabel, 'auth-attempt', method);
        },
      });
      applyAuthToConnOpts(connOpts, authConfig);
      const hopAuthPhase = authConfig.authPhase || createAuthPhase();

      // If first hop and proxy is configured, connect through proxy
      const hasUsableJumpProxy = hasUsableProxy(jump.proxy);
      const effectiveHopProxy = isFirst ? ((hasUsableJumpProxy ? jump.proxy : null) || options.proxy) : null;
      if (effectiveHopProxy) {
        currentSocket = await createProxySocket(effectiveHopProxy, jump.hostname, jump.port || 22, {
          timeoutMs: hopConnectionTimeouts.tcpConnectTimeoutMs,
          onSocket: (socket) => {
            if (options?._tunnelRef) {
              options._tunnelRef.pendingConn = socket;
              options._tunnelRef.chainConnections = connections;
            }
          },
        });
        if (options?._tunnelRef) {
          options._tunnelRef.pendingConn = null;
          options._tunnelRef.chainConnections = connections;
        }
        connOpts.sock = currentSocket;
        delete connOpts.host;
        delete connOpts.port;
      } else if (!isFirst && currentSocket) {
        // Tunnel through previous hop
        connOpts.sock = currentSocket;
        delete connOpts.host;
        delete connOpts.port;
      }

      // Connect this hop
      await new Promise((resolve, reject) => {
        let settled = false;
        let authReadyTimer = null;
        let authBanner = "";
        const clearAuthReadyTimer = () => {
          if (authReadyTimer) {
            clearTimeout(authReadyTimer);
            authReadyTimer = null;
          }
        };
        conn.once('handshake', () => {
          if (settled) return;
          console.log(`[Chain] Hop ${i + 1}/${totalHops}: ${hopLabel} handshake complete`);
          sendProgress(i + 1, totalHops + 1, hopLabel, 'authenticating');
        });
        conn.once('ready', () => {
          if (settled) return;
          settled = true;
          clearAuthReadyTimer();
          console.log(`[Chain] Hop ${i + 1}/${totalHops}: ${hopLabel} connected`);
          sendProgress(i + 1, totalHops + 1, hopLabel, 'connected');
          if (options?._tunnelRef) {
            options._tunnelRef.pendingConn = null;
            options._tunnelRef.chainConnections = connections;
          }
          resolve();
        });
        conn.once('error', (err) => {
          if (settled) return;
          settled = true;
          clearAuthReadyTimer();
          console.error(`[Chain] Hop ${i + 1}/${totalHops}: ${hopLabel} error:`, err.message);
          sendProgress(i + 1, totalHops + 1, hopLabel, 'error', err.message);
          if (isChainAuthError(err)) {
            err.isJumpHostAuthError = true;
            err.jumpHostIndex = i;
            err.jumpHostLabel = hopLabel;
            err.jumpHostHostname = jump.hostname;
            err.message = `Jump host authentication failed for "${hopLabel}": ${err.message}`;
          }
          reject(err);
        });
        conn.once('timeout', () => {
          if (settled) return;
          settled = true;
          clearAuthReadyTimer();
          console.error(`[Chain] Hop ${i + 1}/${totalHops}: ${hopLabel} timeout`);
          const errMsg = `Connection timeout to ${hopLabel}`;
          sendProgress(i + 1, totalHops + 1, hopLabel, 'error', errMsg);
          try { conn.destroy(); } catch { }
          reject(new Error(errMsg));
        });
        conn.once('close', () => {
          if (settled) return;
          settled = true;
          clearAuthReadyTimer();
          const errMsg = `Connection to ${hopLabel} closed before authentication completed`;
          sendProgress(i + 1, totalHops + 1, hopLabel, 'error', errMsg);
          reject(new Error(errMsg));
        });
        conn.on('banner', (message) => {
          authBanner = String(message || "").trim();
        });
        // Handle keyboard-interactive authentication for jump hosts (2FA/MFA)
        conn.on('keyboard-interactive', createKeyboardInteractiveHandler({
          sender,
          sessionId,
          hostId: jump.hostId,
          hostname: hopLabel,
          password: jump.password,
          logPrefix: `[Chain] Hop ${i + 1}/${totalHops}`,
          scope: keyboardInteractiveScope,
          getAuthBanner: () => authBanner,
          shouldSkipAutoFill: () => shouldSkipKiPasswordAutoFill(hopAuthPhase),
          onAutoFill: () => sendProgress(
            i + 1, totalHops + 1, hopLabel, 'auth-attempt', 'using saved password',
          ),
          onPromptShown: () => sendProgress(
            i + 1, totalHops + 1, hopLabel, 'auth-attempt', 'waiting for user input...',
          ),
          onUserResponded: () => sendProgress(
            i + 1, totalHops + 1, hopLabel, 'auth-attempt', 'user responded',
          ),
        }));
        console.log(`[Chain] Hop ${i + 1}/${totalHops}: Connecting to ${hopLabel}...`);
        conn.once('connect', () => {
          runWhenProxyConnectionReady(conn._sock, () => {
            try { conn._sock?.setTimeout?.(0); } catch { }
            clearAuthReadyTimer();
            authReadyTimer = setTimeout(
              () => conn.emit('timeout'),
              hopConnectionTimeouts.authReadyTimeoutMs,
            );
            authReadyTimer.unref?.();
            sendProgress(i + 1, totalHops + 1, hopLabel, 'tcp-connected');
            enableSshNoDelay(conn);
          });
        });
        if (connOpts.sock) enableTcpNoDelay(connOpts.sock);
        conn.connect(connOpts);
      });

      connections.push(conn);

      // Determine next target
      let nextHost, nextPort, nextConnectionTimeouts;
      if (isLast) {
        // Last jump host, forward to final target
        nextHost = targetHost;
        nextPort = targetPort;
        nextConnectionTimeouts = targetConnectionTimeouts;
      } else {
        // Forward to next jump host
        const nextJump = jumpHosts[i + 1];
        nextHost = nextJump.hostname;
        nextPort = nextJump.port || 22;
        nextConnectionTimeouts = resolveSshConnectionTimeouts(nextJump);
      }

      // Create forward stream to next hop
      console.log(`[Chain] Hop ${i + 1}/${totalHops}: Forwarding from ${hopLabel} to ${nextHost}:${nextPort}...`);
      sendProgress(i + 1, totalHops + 1, hopLabel, 'forwarding');
      currentSocket = await new Promise((resolve, reject) => {
        const forwardTimeoutMs = options?._forwardTimeoutMs
          || nextConnectionTimeouts.tcpConnectTimeoutMs;
        let settled = false;
        const timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          const errMsg = `Connection timeout from ${hopLabel} to ${nextHost}:${nextPort}`;
          console.error(`[Chain] Hop ${i + 1}/${totalHops}: forwardOut from ${hopLabel} to ${nextHost}:${nextPort} TIMEOUT`);
          sendProgress(i + 1, totalHops + 1, hopLabel, 'error', errMsg);
          try { conn.destroy(); } catch { }
          reject(new Error(errMsg));
        }, forwardTimeoutMs);
        if (!options?._forwardTimeoutMs) timeout.unref?.();
        conn.forwardOut('127.0.0.1', 0, nextHost, nextPort, (err, stream) => {
          if (settled) {
            try { stream?.destroy?.(); } catch { }
            return;
          }
          settled = true;
          clearTimeout(timeout);
          if (err) {
            console.error(`[Chain] Hop ${i + 1}/${totalHops}: forwardOut from ${hopLabel} to ${nextHost}:${nextPort} FAILED:`, err.message);
            reject(err);
            return;
          }
          console.log(`[Chain] Hop ${i + 1}/${totalHops}: forwardOut from ${hopLabel} to ${nextHost}:${nextPort} SUCCESS`);
          resolve(stream);
        });
      });
    }

    // Return the final forwarded stream and all connections for cleanup
    return {
      socket: currentSocket,
      connections,
      sendProgress
    };
  } catch (err) {
    if (options?._tunnelRef) {
      options._tunnelRef.pendingConn = null;
      options._tunnelRef.chainConnections = connections;
    }
    // Cleanup on error
    for (const conn of connections) {
      try { conn.end(); } catch { }
    }
    throw err;
  }
}

/**
 * Start an SSH session
 */
const startSessionApi = createStartSessionApi({
  get sessions() { return sessions; },
  get electronModule() { return electronModule; },
  SSHClient, sshUtils, NetcattyAgent, keyboardInteractiveHandler, passphraseHandler, hostKeyVerifier,
  fs, path, os, net, crypto, Buffer, process, console, setTimeout, clearTimeout,
  createProxySocket, attachX11Forwarding, createPtyOutputBuffer, sessionLogStreamManager,
  trackSessionIdlePrompt, looksLikeIdleAutoLogout, createZmodemSentry, enableSshNoDelay, enableTcpNoDelay,
  iconv, getSessionDecoder, resetSessionDecoders, sessionEncodings, sessionDecoders, encodeTerminalInput,
  normalizeTerminalEncoding,
  connectThroughChain, getAvailableAgentSocket, getCachedAuthMethod, setCachedAuthMethod, clearCachedAuthMethod,
  attachSshDebugLogger, logSshAlgorithms, safeSend, zmodemOverwritePending,
  shouldLogSshDebugMessage, log, createSshDiagnosticLogger,
  buildAlgorithms, randomUUID, findDefaultPrivateKey, findAllDefaultPrivateKeys,
  openTerminalOutputSession, closeTerminalOutputSession,
  get selectZmodemUploadFiles() { return selectZmodemUploadFiles; },
  get selectZmodemDownloadDirectory() { return selectZmodemDownloadDirectory; },
  preparePrivateKeyForAuth, loadFirstIdentityFileForAuth, prepareSystemSshAgentForAuth, hasUserConfiguredKey, isPasswordProvided, createKeyboardInteractiveHandler, createOrderedStringAuthHandler, createAuthPhase, markAuthPhasePartialSuccess, canRepeatKeyboardInteractive, shouldSkipKiPasswordAutoFill,
  createConnectionRef, acquireConnectionRef, releaseConnectionRef, findReusableSession,
  get probeReceiveConflicts() { return probeReceiveConflicts; },
  get removeRemoteFiles() { return removeRemoteFiles; },
  get restoreRemoteModes() { return restoreRemoteModes; },
});
const { startSSHSession } = startSessionApi;
const { createExecCommandApi } = require("./sshBridge/execCommand.cjs");
const execCommandApi = createExecCommandApi({
  SSHClient, NetcattyAgent, randomUUID, console, setTimeout, clearTimeout, Error,
  findAllDefaultPrivateKeysFromHelper, preparePrivateKeyForAuth, loadIdentityFileForAuth,
  prepareSystemSshAgentForAuth, getAvailableAgentSocket,
  isPassphraseCancelledError, buildAlgorithms, buildAuthHandler, applyAuthToConnOpts,
  createKeyboardInteractiveHandler, shouldSkipKiPasswordAutoFill, resolveSshConnectionTimeouts,
});
const { execCommand } = execCommandApi;

/**
 * Generate SSH key pair
 */
async function generateKeyPair(event, options) {
  const { type, bits, comment } = options;

  try {
    let keyType;
    let keyBits = bits;

    switch (type) {
      case 'ED25519':
        keyType = 'ed25519';
        keyBits = undefined;
        break;
      case 'ECDSA':
        keyType = 'ecdsa';
        keyBits = bits || 256;
        break;
      case 'RSA':
      default:
        keyType = 'rsa';
        keyBits = bits || 4096;
        break;
    }

    const result = sshUtils.generateKeyPairSync(keyType, {
      bits: keyBits,
      comment: comment || 'netcatty-generated-key',
    });

    const privateKey = result.private;
    const publicKey = result.public;

    return {
      success: true,
      privateKey,
      publicKey,
    };
  } catch (err) {
    console.error('Key generation failed:', err);
    return {
      success: false,
      error: err.message || 'Key generation failed',
    };
  }
}

/**
 * Wrapper for SSH session handler to suppress noisy auth error stack traces
 * Auth failures are expected when fallback to password is available
 */
function isAuthFailureMessage(message) {
  const normalized = message?.toLowerCase() || '';
  return normalized.includes('all configured authentication methods failed') ||
    normalized.includes('authentication failed') ||
    normalized.includes('too many authentication failures') ||
    /permission denied\s*\(/.test(normalized) ||
    normalized.includes('no authentication methods available');
}

function isStartAuthError(err) {
  return err?.level === 'client-authentication' ||
    isAuthFailureMessage(err?.message);
}

function isChainAuthError(err) {
  return err?.level === 'client-authentication' ||
    isAuthFailureMessage(err?.message);
}

function canHopUseEncryptedDefaultKeys(hop) {
  if (hop.authMethod === "password" || hop.authMethod === "key" || hop.authMethod === "certificate") {
    return false;
  }
  return !(hop.useSshAgent === true && hop.identitiesOnly === true);
}

function canRetryWithEncryptedDefaultKeys(options) {
  if (options._unlockedEncryptedKeys?.length) return false;
  return canHopUseEncryptedDefaultKeys(options) || (options.jumpHosts || []).some(canHopUseEncryptedDefaultKeys);
}

function resolveFailedAuthHop(options, err) {
  if (!err?.isJumpHostAuthError) return options;
  const jumpHosts = options.jumpHosts || [];
  if (Number.isInteger(err.jumpHostIndex) && err.jumpHostIndex >= 0) {
    return jumpHosts[err.jumpHostIndex] || null;
  }
  const matchingJumps = jumpHosts.filter((jump) => (
    (err.jumpHostHostname && jump.hostname === err.jumpHostHostname)
    || (err.jumpHostLabel && jump.label === err.jumpHostLabel)
  ));
  return matchingJumps.length === 1 ? matchingJumps[0] : null;
}

function canFailedHopRetryWithEncryptedDefaultKeys(options, err) {
  const failedHop = resolveFailedAuthHop(options, err);
  return Boolean(failedHop && canHopUseEncryptedDefaultKeys(failedHop));
}

function isStrictAgentAuthFailure(options, err) {
  if (!err?.isJumpHostAuthError) {
    return options.useSshAgent === true && options.identitiesOnly === true;
  }
  const jumpHosts = options.jumpHosts || [];
  if (Number.isInteger(err.jumpHostIndex) && err.jumpHostIndex >= 0) {
    const failedJump = jumpHosts[err.jumpHostIndex];
    return failedJump?.useSshAgent === true && failedJump.identitiesOnly === true;
  }
  const matchingJumps = jumpHosts.filter((jump) => (
    (err.jumpHostHostname && jump.hostname === err.jumpHostHostname)
    || (err.jumpHostLabel && jump.label === err.jumpHostLabel)
  ));
  const failedJump = matchingJumps.length === 1 ? matchingJumps[0] : undefined;
  return failedJump?.useSshAgent === true && failedJump.identitiesOnly === true;
}

function canReuseExistingSession(options) {
  if (!options.sourceSessionId || options.x11Forwarding) return false;
  return Boolean(findReusableSession(sessions, options.sourceSessionId, {
    hostname: options.hostname,
    port: options.port || 22,
    username: options.username || "root",
  }));
}

function sendFinalStartFailureExit(event, options, err) {
  const sessionId = options.sessionId;
  if (!sessionId || event.sender?.isDestroyed?.()) return;
  safeSend(event.sender, "netcatty:exit", {
    sessionId,
    exitCode: 1,
    error: err?.message || String(err),
    reason: "error",
  });
}

async function startSSHSessionWrapper(event, options) {
  let retryableEncryptedKeys = [];
  let loadedRetryableEncryptedKeys = false;
  let shouldSuppressInitialAuthExit = false;
  const canRetryEncryptedDefaults = canRetryWithEncryptedDefaultKeys(options);
  const canRetryKeyboardInteractiveFirst = Boolean(options.password && !options._skipPasswordMethod);
  const mayReuseExistingSession = canRetryEncryptedDefaults && canReuseExistingSession(options);
  const loadRetryableEncryptedKeys = async () => {
    const allKeysWithEncrypted = await findAllDefaultPrivateKeysFromHelper({ includeEncrypted: true });
    retryableEncryptedKeys = allKeysWithEncrypted.filter(k => k.isEncrypted);
    loadedRetryableEncryptedKeys = true;
    return retryableEncryptedKeys;
  };

  if (canRetryEncryptedDefaults && !mayReuseExistingSession) {
    await loadRetryableEncryptedKeys();
    shouldSuppressInitialAuthExit = retryableEncryptedKeys.length > 0 || canRetryKeyboardInteractiveFirst;
  } else if (mayReuseExistingSession) {
    // Let Copy Tab reuse an authenticated transport without waiting on key
    // discovery. If reuse falls back to a fresh connection and auth fails, the
    // catch path below lazily loads encrypted keys before deciding final failure.
    shouldSuppressInitialAuthExit = true;
  } else if (canRetryKeyboardInteractiveFirst) {
    shouldSuppressInitialAuthExit = true;
  }

  try {
    return await startSSHSession(event, {
      ...options,
      _suppressPreShellAuthExit: shouldSuppressInitialAuthExit,
    });
  } catch (err) {
    const isAuthError = isStartAuthError(err);

    if (isAuthError) {
      let authErrorSource = err;

      if (canRetryKeyboardInteractiveFirst && err.retryKeyboardInteractiveFirst) {
        console.log('[SSH] Password auth removed keyboard-interactive; retrying with keyboard-interactive first...');
        try {
          return await startSSHSession(event, {
            ...options,
            _skipPasswordMethod: true,
            _suppressPreShellAuthExit: shouldSuppressInitialAuthExit,
          });
        } catch (retryErr) {
          const isRetryAuthError = isStartAuthError(retryErr);
          if (isRetryAuthError) {
            authErrorSource = retryErr;
            console.log('[SSH] Keyboard-interactive-first retry failed authentication; checking remaining auth fallbacks...');
          } else {
            const connError = new Error(retryErr.message);
            connError.level = retryErr.level || 'client-socket';
            connError.code = retryErr.code;
            throw connError;
          }
        }
      }

      // Check if there are encrypted default keys we haven't tried yet
      // Only offer retry if no unlocked keys were provided in this attempt
      if (
        canRetryEncryptedDefaults
        && canFailedHopRetryWithEncryptedDefaultKeys(options, authErrorSource)
        && !isStrictAgentAuthFailure(options, authErrorSource)
      ) {
        const encryptedKeys = loadedRetryableEncryptedKeys
          ? retryableEncryptedKeys
          : await loadRetryableEncryptedKeys();

        if (encryptedKeys.length > 0) {
          console.log('[SSH] Auth failed, found encrypted default keys. Requesting passphrases for retry...');

          // Request passphrases from user
          const passphraseResult = await requestPassphrasesForEncryptedKeys(
            event.sender,
            options.hostname
          );

          // If user cancelled, don't retry even if some keys were unlocked
          if (passphraseResult.cancelled) {
            console.log('[SSH] User cancelled passphrase flow, not retrying');
          } else if (passphraseResult.keys.length > 0) {
            console.log('[SSH] User unlocked keys, retrying connection...', {
              count: passphraseResult.keys.length,
              keyNames: passphraseResult.keys.map(k => k.keyName)
            });

            // Retry connection with unlocked keys
            // Wrap in try-catch to ensure consistent error handling for retry failures
            try {
              return await startSSHSession(event, {
                ...options,
                _unlockedEncryptedKeys: passphraseResult.keys,
              });
            } catch (retryErr) {
              // Only purge cached passphrases if the error is specifically
              // a passphrase/key-parsing failure, not a generic auth rejection.
              const retryMsg = (retryErr.message || '').toLowerCase();
              const isPassphraseError = retryMsg.includes('bad passphrase') ||
                retryMsg.includes('integrity check failed') ||
                retryMsg.includes('cannot parse privatekey');
              if (isPassphraseError) {
                try {
                  const failedKeyPaths = passphraseResult.keys.map(k => k.keyPath);
                  event.sender.send('netcatty:passphrase-auth-failed', { keyPaths: failedKeyPaths });
                } catch (_) { /* sender may be destroyed */ }
              }

              // Re-wrap retry errors the same way as initial errors
              const isRetryAuthError = isStartAuthError(retryErr);

              if (isRetryAuthError) {
                const authError = new Error(retryErr.message);
                authError.level = 'client-authentication';
                authError.isAuthError = true;
                if (retryErr.isJumpHostAuthError) {
                  authError.isJumpHostAuthError = true;
                  authError.jumpHostIndex = retryErr.jumpHostIndex;
                  authError.jumpHostLabel = retryErr.jumpHostLabel;
                  authError.jumpHostHostname = retryErr.jumpHostHostname;
                }
                throw authError;
              }
              // Wrap non-auth retry errors as connection errors to prevent crash
              const connError = new Error(retryErr.message);
              connError.level = retryErr.level || 'client-socket';
              connError.code = retryErr.code;
              throw connError;
            }
          } else {
            console.log('[SSH] User did not unlock any keys, not retrying');
          }
        }
      }

      if (shouldSuppressInitialAuthExit) {
        sendFinalStartFailureExit(event, options, authErrorSource);
      }

      // Re-throw with a clean error to avoid Electron printing full stack trace
      // The frontend will handle this as a normal auth failure for fallback
      const authError = new Error(authErrorSource.message);
      authError.level = 'client-authentication';
      authError.isAuthError = true;
      if (authErrorSource.isJumpHostAuthError) {
        authError.isJumpHostAuthError = true;
        authError.jumpHostIndex = authErrorSource.jumpHostIndex;
        authError.jumpHostLabel = authErrorSource.jumpHostLabel;
        authError.jumpHostHostname = authErrorSource.jumpHostHostname;
      }
      throw authError;
    }

    // Non-auth errors (e.g. ECONNRESET, ETIMEDOUT) — wrap in a clean Error
    // so Electron's ipcMain.handle can serialize it back to the renderer
    // instead of it becoming an uncaught exception that crashes the app.
    // See: https://github.com/nicely-gg/netcatty/issues/482
    const connError = new Error(err.message);
    connError.level = err.level || 'client-socket';
    connError.code = err.code;
    throw connError;
  }
}

/**
 * Get current working directory from an active SSH session
 * This sends 'pwd' to the existing shell stream and captures the output
 * using unique markers to identify the command output boundaries
 */
/**
 * Return metadata about an already-connected session that was captured at
 * connect time. Currently exposes the SSH server identification string
 * (the `software` portion of the SSH-2.0 banner) so the renderer can
 * classify network devices from the banner without running any additional
 * exec channels.
 */
// Companion stats connection for Mosh sessions (issue #1198). Mosh runs over
// UDP and has no ssh2 connection, so getServerStats cannot open an exec
// channel. This helper lazily establishes a best-effort, non-interactive
// SSH connection reusing the handshake credentials and assigns it to
// session.conn so the existing stats path works unchanged.
const { createSystemKnownHostsApi } = require("./sshBridge/systemKnownHosts.cjs");
// Lets the Mosh stats companion trust a host whose key is already recorded in
// the user's system OpenSSH known_hosts (the trust source the Mosh handshake's
// system `ssh` actually uses), in addition to Netcatty's in-app vault.
const { isHostKeyTrustedBySystem } = createSystemKnownHostsApi({
  fs, path, os, crypto, log,
});

const { createMoshStatsConnectionApi } = require("./sshBridge/moshStatsConnection.cjs");
const { ensureMoshStatsConnection, ensureEtStatsConnection } = createMoshStatsConnectionApi({
  get sessions() { return sessions; },
  SSHClient, sshUtils, NetcattyAgent, buildAlgorithms, getSshAgentSocket, prepareSystemSshAgentForAuth,
  readFileNoFollow, expandIdentityFilePath, isAutoFillablePasswordChallenge,
  hostKeyVerifier, isHostKeyTrustedBySystem, log,
});

const { createSessionOpsApi } = require("./sshBridge/sessionOps.cjs");
const measureTcpConnectLatency = createTcpConnectLatencyProbe({ net });
const sessionOpsApi = createSessionOpsApi({
  get sessions() { return sessions; },
  get electronModule() { return electronModule; },
  fs, path, os, exec, randomUUID, iconv, Buffer, process, console, setTimeout, clearTimeout,
  getSessionDecoder, resetSessionDecoders, sessionEncodings, normalizeTerminalEncoding,
  safeSend,
  quoteShellArg, log, ensureMoshStatsConnection, ensureEtStatsConnection,
  measureTcpConnectLatency,
  execOnEtSession: (...args) => require("./terminalBridge.cjs").execOnEtSession(...args),
  getServerStats: undefined,
});
const {
  getSessionRemoteInfo,
  getSessionDistroInfo,
  readRemoteHistory,
  getSessionPwd,
  probeReceiveConflicts,
  removeRemoteFiles,
  restoreRemoteModes,
  listSessionDir,
  getServerStats,
  setSessionEncoding,
} = sessionOpsApi;

/**
 * Register IPC handlers for SSH operations
 */
function registerWorkerHandle(ipcMain, terminalWorkerManager, channel) {
  ipcMain.handle(channel, (event, payload) => {
    return terminalWorkerManager.request(channel, payload, {
      webContentsId: event?.sender?.id,
    });
  });
}

function registerHandlers(ipcMain, options = {}) {
  const terminalWorkerManager = options.terminalWorkerManager || null;
  if (terminalWorkerManager) {
    [
      "netcatty:start",
      "netcatty:ssh:exec",
      "netcatty:ssh:pwd",
      "netcatty:ssh:remoteInfo",
      "netcatty:ssh:distroInfo",
      "netcatty:ssh:readRemoteHistory",
      "netcatty:ssh:listdir",
      "netcatty:ssh:stats",
      "netcatty:ssh:setEncoding",
      "netcatty:keyboard-interactive:respond",
      "netcatty:passphrase:respond",
      "netcatty:host-key:respond",
    ].forEach((channel) => registerWorkerHandle(ipcMain, terminalWorkerManager, channel));
    ipcMain.on("netcatty:zmodem:overwrite-response", (event, payload) => {
      terminalWorkerManager.send("netcatty:zmodem:overwrite-response", payload, {
        webContentsId: event?.sender?.id,
      });
    });
  } else {
    ipcMain.handle("netcatty:start", startSSHSessionWrapper);
    ipcMain.handle("netcatty:ssh:exec", execCommand);
    ipcMain.handle("netcatty:ssh:pwd", getSessionPwd);
    ipcMain.handle("netcatty:ssh:remoteInfo", getSessionRemoteInfo);
    ipcMain.handle("netcatty:ssh:distroInfo", getSessionDistroInfo);
    ipcMain.handle("netcatty:ssh:readRemoteHistory", readRemoteHistory);
    ipcMain.handle("netcatty:ssh:listdir", listSessionDir);
    ipcMain.handle("netcatty:ssh:stats", getServerStats);
    ipcMain.handle("netcatty:ssh:setEncoding", setSessionEncoding);
    ipcMain.on("netcatty:zmodem:overwrite-response", (_event, payload) => {
      const resolve = zmodemOverwritePending.get(payload?.requestId);
      if (resolve) { zmodemOverwritePending.delete(payload.requestId); resolve(payload); }
    });
    // Register the shared keyboard-interactive response handler
    keyboardInteractiveHandler.registerHandler(ipcMain);
    // Register the passphrase response handler
    passphraseHandler.registerHandler(ipcMain);
    // Register the SSH host key verification response handler
    hostKeyVerifier.registerHandler(ipcMain);
  }
  ipcMain.handle("netcatty:key:generate", generateKeyPair);
  ipcMain.handle("netcatty:sshDebugLog:info", getSshDebugLogInfo);
  ipcMain.handle("netcatty:sshDebugLog:openDir", openSshDebugLogDir);
  ipcMain.handle("netcatty:ssh:check-agent", async (_event, options = {}) => {
    const identityAgent = typeof options === "string" ? options : options.identityAgent;
    if (process.platform === "win32" && !identityAgent) {
      return await checkWindowsSshAgent();
    }
    const socketPath = await getAvailableSystemAgentSocket(identityAgent, typeof options === "string" ? {} : options);
    return {
      running: Boolean(socketPath),
      startupType: socketPath ? "running" : "stopped",
      error: socketPath ? null : "SSH Agent socket not connectable",
    };
  });
  ipcMain.handle("netcatty:ssh:get-default-keys", async () => {
    const sshDir = path.join(os.homedir(), ".ssh");
    const keys = [];
    try {
      const entries = await fs.promises.readdir(sshDir);
      const names = entries.filter(f => SSH_KEY_PATTERN.test(f));
      // Preferred first, then rest alphabetically
      const preferred = PREFERRED_KEY_NAMES.filter(n => names.includes(n));
      const rest = names.filter(n => !PREFERRED_KEY_NAMES.includes(n)).sort();
      for (const name of [...preferred, ...rest]) {
        keys.push({ name, path: path.join(sshDir, name) });
      }
    } catch {
      // ~/.ssh doesn't exist
    }
    return keys;
  });
}

module.exports = {
  init,
  registerHandlers,
  connectThroughChain,
  buildAlgorithms,
  _resetAlgorithmSupportCacheForTests,
  _appendSshDiagnosticLog: appendSshDiagnosticLog,
  _createSshDiagnosticLogger: createSshDiagnosticLogger,
  _getSshDebugLogFilePath: getSshDebugLogFilePath,
  _setSshDebugLoggingEnabled: setSshDebugLoggingEnabled,
  _shouldLogSshDebugMessage: shouldLogSshDebugMessage,
  // Exposed for the default-key dedupe characterization test (the connect path
  // derives the preferred default key from findAllDefaultPrivateKeys()[0]).
  _findDefaultPrivateKey: findDefaultPrivateKey,
  _findAllDefaultPrivateKeys: findAllDefaultPrivateKeys,
  _isStrictAgentAuthFailure: isStrictAgentAuthFailure,
  _canRetryWithEncryptedDefaultKeys: canRetryWithEncryptedDefaultKeys,
  _canFailedHopRetryWithEncryptedDefaultKeys: canFailedHopRetryWithEncryptedDefaultKeys,
  ensureMoshStatsConnection,
};
