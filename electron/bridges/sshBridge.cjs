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
const { Client: SSHClient, utils: sshUtils } = require("ssh2");
const { NetcattyAgent } = require("./netcattyAgent.cjs");
const keyboardInteractiveHandler = require("./keyboardInteractiveHandler.cjs");
const passphraseHandler = require("./passphraseHandler.cjs");
const hostKeyVerifier = require("./hostKeyVerifier.cjs");
const { createProxySocket } = require("./proxyUtils.cjs");
const { attachX11Forwarding } = require("./x11Forwarding.cjs");
const { createPtyOutputBuffer } = require("./ptyOutputBuffer.cjs");
const {
  buildAuthHandler,
  createKeyboardInteractiveHandler,
  applyAuthToConnOpts,
  safeSend: authSafeSend,
  requestPassphrasesForEncryptedKeys,
  findAllDefaultPrivateKeys: findAllDefaultPrivateKeysFromHelper,
  getSshAgentSocket,
  readFileNoFollow,
  preparePrivateKeyForAuth,
  loadIdentityFileForAuth,
  loadFirstIdentityFileForAuth,
  PassphraseCancelledError,
  isPassphraseCancelledError,
} = require("./sshAuthHelper.cjs");
const sessionLogStreamManager = require("./sessionLogStreamManager.cjs");
const { trackSessionIdlePrompt, looksLikeIdleAutoLogout } = require("./ai/shellUtils.cjs");
const { createZmodemSentry } = require("./zmodemHelper.cjs");
const {
  buildAlgorithms,
  _resetAlgorithmSupportCacheForTests,
} = require("./sshAlgorithms.cjs");
const { enableSshNoDelay, enableTcpNoDelay } = require("./tcpNoDelay.cjs");

// Default SSH key names in priority order (preferred keys tried first)
const PREFERRED_KEY_NAMES = ["id_ed25519", "id_ecdsa", "id_rsa"];
// Match any private key file: id_* but not *.pub
const SSH_KEY_PATTERN = /^id_[\w-]+$/;

function quoteShellArg(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
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

const DEBUG_SSH = process.env.NETCATTY_SSH_DEBUG === "1";

// Debug logger (disabled by default)
const logFile = DEBUG_SSH
  ? path.join(require("os").tmpdir(), "netcatty-ssh.log")
  : null;
const log = (msg, data) => {
  if (!DEBUG_SSH) return;
  const line = `[${new Date().toISOString()}] ${msg} ${data ? JSON.stringify(data) : ""}\n`;
  try { fs.appendFileSync(logFile, line); } catch { }
  console.log("[SSH]", msg, data ? JSON.stringify(data, null, 2) : "");
};

function shouldLogSshDebugMessage(msg) {
  if (typeof msg !== "string") return false;
  return /auth|publickey|keyboard|handshake|kex|newkeys|dh gex/i.test(msg);
}

function attachSshDebugLogger(connectOpts) {
  if (!DEBUG_SSH) return;
  connectOpts.debug = (msg) => {
    if (shouldLogSshDebugMessage(msg)) {
      log("ssh2 debug", { msg });
    }
  };
}

function logSshAlgorithms(label, algorithms, extra = {}) {
  log(`${label} algorithm configuration`, {
    ...extra,
    kex: algorithms.kex,
    cipher: algorithms.cipher,
    hmac: algorithms.hmac,
    serverHostKey: algorithms.serverHostKey,
  });
}

// Session storage - shared reference passed from main
let sessions = null;
let electronModule = null;

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

// Normalize charset inputs (often provided as bare encodings like "UTF-8")
// into a usable LANG locale for remote shells.
function resolveLangFromCharset(charset) {
  if (!charset) return "en_US.UTF-8";
  const trimmed = String(charset).trim();
  if (/^utf-?8$/i.test(trimmed) || /^utf8$/i.test(trimmed)) {
    return "en_US.UTF-8";
  }
  return trimmed;
}

const { safeSend } = require("./ipcUtils.cjs");

const zmodemOverwritePending = new Map(); // requestId -> (decision) => void

/**
 * Initialize the SSH bridge with dependencies
 */
function init(deps) {
  sessions = deps.sessions;
  electronModule = deps.electronModule;
}

/**
 * Connect through a chain of jump hosts
 */
async function connectThroughChain(event, options, jumpHosts, targetHost, targetPort, sessionId) {
  const sender = event.sender;
  const connections = options?._connectionsRef || [];
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
      // Build connection options
      const connOpts = {
        host: jump.hostname,
        port: jump.port || 22,
        username: jump.username || 'root',
        readyTimeout: 120000, // 2 minutes to allow for keyboard-interactive (2FA/MFA)
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
      attachSshDebugLogger(connOpts);
      logSshAlgorithms("Jump host", connOpts.algorithms, {
        hostname: jump.hostname,
        port: jump.port || 22,
        legacyAlgorithms: !!(jump.legacyAlgorithms ?? options.legacyAlgorithms),
        skipEcdsaHostKey: !!jump.skipEcdsaHostKey,
        hasAlgorithmOverrides: !!jump.algorithmOverrides,
      });

      // Auth - support agent (certificate), key, password, and default key fallback
      const hasCertificate =
        typeof jump.certificate === "string" && jump.certificate.trim().length > 0;

      const identityFile = !jump.privateKey
        ? await loadFirstIdentityFileForAuth({
          sender,
          identityFilePaths: jump.identityFilePaths,
          hostname: hopLabel,
          initialPassphrase: jump.passphrase,
          passphraseSignal: options._passphraseSignal,
          logPrefix: `[Chain] Hop ${i + 1}:`,
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
      const inlineKey = jump.privateKey
        ? await preparePrivateKeyForAuth({
          sender,
          privateKey: jump.privateKey,
          keyId: jump.keyId,
          keyName: jump.keyId || jump.label || jump.username,
          hostname: hopLabel,
          initialPassphrase: jump.passphrase,
          passphraseSignal: options._passphraseSignal,
          logPrefix: `[Chain] Hop ${i + 1}:`,
        })
        : null;
      const effectivePrivateKey = inlineKey?.privateKey || identityFile?.privateKey;
      const effectivePassphrase = inlineKey?.passphrase || identityFile?.passphrase;

      let authAgent = null;
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
          sendProgress(i + 1, totalHops + 1, hopLabel, 'auth-attempt', 'passphrase required');
          const keyLabel = jump.label || hopLabel;
          const result = await passphraseHandler.requestPassphrase(
            sender,
            `SSH key for ${keyLabel}`,
            keyLabel,
            hopLabel,
            false,
            { signal: options._passphraseSignal }
          );
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
      const defaultKeys = options._defaultKeys || await findAllDefaultPrivateKeys();

      // Build auth handler using shared helper
      // Pass unlocked encrypted keys from options so jump hosts can use them for retry
      const authConfig = buildAuthHandler({
        privateKey: connOpts.privateKey,
        password: connOpts.password,
        passphrase: connOpts.passphrase,
        agent: connOpts.agent,
        username: connOpts.username,
        logPrefix: `[Chain] Hop ${i + 1}`,
        unlockedEncryptedKeys: options._unlockedEncryptedKeys || [],
        defaultKeys,
        onAuthAttempt: (method) => {
          sendProgress(i + 1, totalHops + 1, hopLabel, 'auth-attempt', method);
        },
      });
      applyAuthToConnOpts(connOpts, authConfig);

      // If first hop and proxy is configured, connect through proxy
      const hasUsableJumpProxy = !!(jump.proxy?.host && jump.proxy?.port);
      const effectiveHopProxy = isFirst ? ((hasUsableJumpProxy ? jump.proxy : null) || options.proxy) : null;
      if (effectiveHopProxy) {
        currentSocket = await createProxySocket(effectiveHopProxy, jump.hostname, jump.port || 22, {
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
        conn.once('handshake', () => {
          console.log(`[Chain] Hop ${i + 1}/${totalHops}: ${hopLabel} handshake complete`);
          sendProgress(i + 1, totalHops + 1, hopLabel, 'authenticating');
        });
        conn.once('ready', () => {
          console.log(`[Chain] Hop ${i + 1}/${totalHops}: ${hopLabel} connected`);
          sendProgress(i + 1, totalHops + 1, hopLabel, 'connected');
          if (options?._tunnelRef) {
            options._tunnelRef.pendingConn = null;
            options._tunnelRef.chainConnections = connections;
          }
          resolve();
        });
        conn.once('error', (err) => {
          console.error(`[Chain] Hop ${i + 1}/${totalHops}: ${hopLabel} error:`, err.message);
          sendProgress(i + 1, totalHops + 1, hopLabel, 'error', err.message);
          reject(err);
        });
        conn.once('timeout', () => {
          console.error(`[Chain] Hop ${i + 1}/${totalHops}: ${hopLabel} timeout`);
          const errMsg = `Connection timeout to ${hopLabel}`;
          sendProgress(i + 1, totalHops + 1, hopLabel, 'error', errMsg);
          reject(new Error(errMsg));
        });
        // Handle keyboard-interactive authentication for jump hosts (2FA/MFA)
        conn.on('keyboard-interactive', createKeyboardInteractiveHandler({
          sender,
          sessionId,
          hostname: hopLabel,
          password: jump.password,
          logPrefix: `[Chain] Hop ${i + 1}/${totalHops}`,
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
        conn.once('connect', () => enableSshNoDelay(conn));
        if (connOpts.sock) enableTcpNoDelay(connOpts.sock);
        conn.connect(connOpts);
      });

      connections.push(conn);

      // Determine next target
      let nextHost, nextPort;
      if (isLast) {
        // Last jump host, forward to final target
        nextHost = targetHost;
        nextPort = targetPort;
      } else {
        // Forward to next jump host
        const nextJump = jumpHosts[i + 1];
        nextHost = nextJump.hostname;
        nextPort = nextJump.port || 22;
      }

      // Create forward stream to next hop
      console.log(`[Chain] Hop ${i + 1}/${totalHops}: Forwarding from ${hopLabel} to ${nextHost}:${nextPort}...`);
      sendProgress(i + 1, totalHops + 1, hopLabel, 'forwarding');
      currentSocket = await new Promise((resolve, reject) => {
        conn.forwardOut('127.0.0.1', 0, nextHost, nextPort, (err, stream) => {
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
const { createStartSessionApi } = require("./sshBridge/startSession.cjs");
const startSessionApi = createStartSessionApi({
  get sessions() { return sessions; },
  get electronModule() { return electronModule; },
  SSHClient, sshUtils, NetcattyAgent, keyboardInteractiveHandler, passphraseHandler, hostKeyVerifier,
  fs, path, os, net, crypto, Buffer, process, console, setTimeout, clearTimeout,
  createProxySocket, attachX11Forwarding, createPtyOutputBuffer, sessionLogStreamManager,
  trackSessionIdlePrompt, looksLikeIdleAutoLogout, createZmodemSentry, enableSshNoDelay, enableTcpNoDelay,
  iconv, getSessionDecoder, resetSessionDecoders, sessionEncodings, sessionDecoders,
  connectThroughChain, getAvailableAgentSocket, getCachedAuthMethod, setCachedAuthMethod, clearCachedAuthMethod,
  attachSshDebugLogger, logSshAlgorithms, resolveLangFromCharset, safeSend, zmodemOverwritePending,
  shouldLogSshDebugMessage, log,
  buildAlgorithms, randomUUID, findDefaultPrivateKey, findAllDefaultPrivateKeys,
  preparePrivateKeyForAuth, loadFirstIdentityFileForAuth, createKeyboardInteractiveHandler,
  get probeReceiveConflicts() { return probeReceiveConflicts; },
  get removeRemoteFiles() { return removeRemoteFiles; },
  get restoreRemoteModes() { return restoreRemoteModes; },
});
const { startSSHSession } = startSessionApi;
const { createExecCommandApi } = require("./sshBridge/execCommand.cjs");
const execCommandApi = createExecCommandApi({
  SSHClient, NetcattyAgent, randomUUID, console, setTimeout, clearTimeout, Error,
  findAllDefaultPrivateKeysFromHelper, preparePrivateKeyForAuth, loadIdentityFileForAuth,
  isPassphraseCancelledError, buildAlgorithms, buildAuthHandler, applyAuthToConnOpts,
  createKeyboardInteractiveHandler,
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
async function startSSHSessionWrapper(event, options) {
  try {
    return await startSSHSession(event, options);
  } catch (err) {
    const isAuthError = err.message?.toLowerCase().includes('authentication') ||
      err.message?.toLowerCase().includes('auth') ||
      err.level === 'client-authentication';

    if (isAuthError) {
      // Check if there are encrypted default keys we haven't tried yet
      // Only offer retry if no unlocked keys were provided in this attempt
      const hasJumpHosts = options.jumpHosts && options.jumpHosts.length > 0;
      const isPasswordOnly = !hasJumpHosts && !options.agentForwarding && !!options.password && !options.privateKey && !options.certificate;
      if (!isPasswordOnly && (!options._unlockedEncryptedKeys || options._unlockedEncryptedKeys.length === 0)) {
        const allKeysWithEncrypted = await findAllDefaultPrivateKeysFromHelper({ includeEncrypted: true });
        const encryptedKeys = allKeysWithEncrypted.filter(k => k.isEncrypted);

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
              const isRetryAuthError = retryErr.message?.toLowerCase().includes('authentication') ||
                retryErr.message?.toLowerCase().includes('auth') ||
                retryErr.level === 'client-authentication';

              if (isRetryAuthError) {
                const authError = new Error(retryErr.message);
                authError.level = 'client-authentication';
                authError.isAuthError = true;
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

      // Re-throw with a clean error to avoid Electron printing full stack trace
      // The frontend will handle this as a normal auth failure for fallback
      const authError = new Error(err.message);
      authError.level = 'client-authentication';
      authError.isAuthError = true;
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
const { createSessionOpsApi } = require("./sshBridge/sessionOps.cjs");
const sessionOpsApi = createSessionOpsApi({
  get sessions() { return sessions; },
  get electronModule() { return electronModule; },
  fs, path, os, exec, randomUUID, iconv, Buffer, process, console, setTimeout, clearTimeout,
  getSessionDecoder, resetSessionDecoders, sessionEncodings, resolveLangFromCharset, safeSend,
  quoteShellArg, log,
  getServerStats: undefined,
});
const {
  getSessionRemoteInfo,
  getSessionDistroInfo,
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
function registerHandlers(ipcMain) {
  ipcMain.handle("netcatty:start", startSSHSessionWrapper);
  ipcMain.handle("netcatty:ssh:exec", execCommand);
  ipcMain.handle("netcatty:ssh:pwd", getSessionPwd);
  ipcMain.handle("netcatty:ssh:remoteInfo", getSessionRemoteInfo);
  ipcMain.handle("netcatty:ssh:distroInfo", getSessionDistroInfo);
  ipcMain.handle("netcatty:ssh:listdir", listSessionDir);
  ipcMain.handle("netcatty:ssh:stats", getServerStats);
  ipcMain.handle("netcatty:key:generate", generateKeyPair);
  ipcMain.handle("netcatty:ssh:setEncoding", setSessionEncoding);
  ipcMain.handle("netcatty:ssh:check-agent", async () => {
    return await checkWindowsSshAgent();
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

module.exports = {
  init,
  registerHandlers,
  connectThroughChain,
  buildAlgorithms,
  _resetAlgorithmSupportCacheForTests,
  _shouldLogSshDebugMessage: shouldLogSshDebugMessage,
};
