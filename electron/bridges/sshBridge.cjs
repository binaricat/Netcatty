/**
 * SSH Bridge - Handles SSH connections, sessions, and related operations
 * Extracted from main.cjs for single responsibility
 */

const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { exec } = require("node:child_process");
const { Client: SSHClient, utils: sshUtils } = require("ssh2");
const { NetcattyAgent } = require("./netcattyAgent.cjs");
const keyboardInteractiveHandler = require("./keyboardInteractiveHandler.cjs");
const passphraseHandler = require("./passphraseHandler.cjs");
const { createProxySocket } = require("./proxyUtils.cjs");
const { 
  buildAuthHandler, 
  createKeyboardInteractiveHandler, 
  applyAuthToConnOpts,
  safeSend: authSafeSend,
  requestPassphrasesForEncryptedKeys,
  findAllDefaultPrivateKeys: findAllDefaultPrivateKeysFromHelper,
} = require("./sshAuthHelper.cjs");

// Default SSH key names in priority order
const DEFAULT_KEY_NAMES = ["id_ed25519", "id_ecdsa", "id_rsa"];

/**
 * Check if an SSH private key is encrypted (requires passphrase)
 * @param {string} keyContent - The content of the private key file
 * @returns {boolean} - True if the key is encrypted
 */
function isKeyEncrypted(keyContent) {
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
  log("Searching for default SSH keys", { sshDir, keyNames: DEFAULT_KEY_NAMES });
  for (const name of DEFAULT_KEY_NAMES) {
    const keyPath = path.join(sshDir, name);
    try {
      await fs.promises.access(keyPath, fs.constants.F_OK);
      const privateKey = await fs.promises.readFile(keyPath, "utf8");
      // Skip encrypted keys - they require a passphrase and would abort
      // authentication before password/keyboard-interactive can be tried
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
  log("Searching for ALL default SSH keys", { sshDir, keyNames: DEFAULT_KEY_NAMES });

  const promises = DEFAULT_KEY_NAMES.map(async (name) => {
    const keyPath = path.join(sshDir, name);
    try {
      await fs.promises.access(keyPath, fs.constants.F_OK);
      const privateKey = await fs.promises.readFile(keyPath, "utf8");
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

/**
 * Check if Windows SSH Agent service is running
 * @returns {Promise<{ running: boolean, startupType: string | null, error: string | null }>}
 */
function checkWindowsSshAgent() {
  return new Promise((resolve) => {
    if (process.platform !== "win32") {
      resolve({ running: true, startupType: null, error: null });
      return;
    }
    exec("sc query ssh-agent", (err, stdout) => {
      if (err) {
        resolve({ running: false, startupType: null, error: "SSH Agent service not found" });
        return;
      }
      const running = stdout.includes("RUNNING");
      const stopped = stdout.includes("STOPPED");
      resolve({
        running,
        startupType: stopped ? "stopped" : (running ? "running" : "unknown"),
        error: null,
      });
    });
  });
}

// Simple file logger for debugging
const logFile = path.join(require("os").tmpdir(), "netcatty-ssh.log");
const log = (msg, data) => {
  const line = `[${new Date().toISOString()}] ${msg} ${data ? JSON.stringify(data) : ""}\n`;
  try { fs.appendFileSync(logFile, line); } catch { }
  console.log("[SSH]", msg, data ? JSON.stringify(data, null, 2) : "");
};

// Session storage - shared reference passed from main
let sessions = null;
let electronModule = null;

// Authentication method cache - remembers successful auth methods per host
// Key format: "username@hostname:port"
// Value: { method: "password" | "publickey" | "publickey-default" }
// Cache persists until auth failure, then cleared to retry all methods
const authMethodCache = new Map();

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

function safeSend(sender, channel, payload) {
  try {
    if (!sender || sender.isDestroyed()) return;
    sender.send(channel, payload);
  } catch {
    // Ignore destroyed webContents during shutdown.
  }
}

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
  const connections = [];
  let currentSocket = null;

  const sendProgress = (hop, total, label, status) => {
    if (!sender.isDestroyed()) {
      sender.send("netcatty:chain:progress", { hop, total, label, status });
    }
  };

  try {
    const totalHops = jumpHosts.length;

    // Connect through each jump host
    for (let i = 0; i < jumpHosts.length; i++) {
      const jump = jumpHosts[i];
      const isFirst = i === 0;
      const isLast = i === jumpHosts.length - 1;
      const hopLabel = jump.label || `${jump.hostname}:${jump.port || 22}`;

      sendProgress(i + 1, totalHops + 1, hopLabel, 'connecting');

      const conn = new SSHClient();

      // Build connection options
      const connOpts = {
        host: jump.hostname,
        port: jump.port || 22,
        username: jump.username || 'root',
        readyTimeout: 120000, // 2 minutes to allow for keyboard-interactive (2FA/MFA)
        // Use user-configured keepalive interval from options (in seconds -> convert to ms)
        // If 0 or not provided, use 10000ms as default
        keepaliveInterval: options.keepaliveInterval && options.keepaliveInterval > 0 ? options.keepaliveInterval * 1000 : 10000,
        keepaliveCountMax: 3,
        // Enable keyboard-interactive authentication (required for 2FA/MFA)
        tryKeyboard: true,
        algorithms: {
          // Prioritize fastest ciphers (GCM modes are hardware-accelerated)
          cipher: [
            'aes128-gcm@openssh.com', 'aes256-gcm@openssh.com',
            'chacha20-poly1305@openssh.com',
            'aes128-ctr', 'aes192-ctr', 'aes256-ctr',
          ],
          // Prioritize modern key exchange algorithms for broad compatibility
          kex: [
            'curve25519-sha256', 'curve25519-sha256@libssh.org',
            'ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521',
            'diffie-hellman-group14-sha256',
            'diffie-hellman-group16-sha512', 'diffie-hellman-group18-sha512',
            'diffie-hellman-group-exchange-sha256',
          ],
          compress: ['none'],
        },
      };

      // Auth - support agent (certificate), key, password, and default key fallback
      const hasCertificate =
        typeof jump.certificate === "string" && jump.certificate.trim().length > 0;

      let authAgent = null;
      if (hasCertificate) {
        authAgent = new NetcattyAgent({
          mode: "certificate",
          webContents: event.sender,
          meta: {
            label: jump.keyId || jump.username || "",
            certificate: jump.certificate,
            privateKey: jump.privateKey,
            passphrase: jump.passphrase,
          },
        });
        connOpts.agent = authAgent;
      } else if (jump.privateKey) {
        connOpts.privateKey = jump.privateKey;
        if (jump.passphrase) connOpts.passphrase = jump.passphrase;
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
      });
      applyAuthToConnOpts(connOpts, authConfig);

      // If first hop and proxy is configured, connect through proxy
      if (isFirst && options.proxy) {
        currentSocket = await createProxySocket(options.proxy, jump.hostname, jump.port || 22);
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
        conn.on('ready', () => {
          console.log(`[Chain] Hop ${i + 1}/${totalHops}: ${hopLabel} connected`);
          sendProgress(i + 1, totalHops + 1, hopLabel, 'connected');
          resolve();
        });
        conn.on('error', (err) => {
          console.error(`[Chain] Hop ${i + 1}/${totalHops}: ${hopLabel} error:`, err.message);
          sendProgress(i + 1, totalHops + 1, hopLabel, 'error');
          reject(err);
        });
        conn.on('timeout', () => {
          console.error(`[Chain] Hop ${i + 1}/${totalHops}: ${hopLabel} timeout`);
          reject(new Error(`Connection timeout to ${hopLabel}`));
        });
        // Handle keyboard-interactive authentication for jump hosts (2FA/MFA)
        conn.on('keyboard-interactive', createKeyboardInteractiveHandler({
          sender,
          sessionId,
          hostname: hopLabel,
          password: jump.password,
          logPrefix: `[Chain] Hop ${i + 1}/${totalHops}`,
        }));
        console.log(`[Chain] Hop ${i + 1}/${totalHops}: Connecting to ${hopLabel}...`);
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
async function startSSHSession(event, options) {
  const sessionId =
    options.sessionId ||
    `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const cols = options.cols || 80;
  const rows = options.rows || 24;
  const sender = event.sender;

  const sendProgress = (hop, total, label, status) => {
    if (!sender.isDestroyed()) {
      sender.send("netcatty:chain:progress", { hop, total, label, status });
    }
  };

  try {
    const conn = new SSHClient();
    let chainConnections = [];
    let connectionSocket = null;

    // Determine if we have jump hosts
    const jumpHosts = options.jumpHosts || [];
    const hasJumpHosts = jumpHosts.length > 0;
    const hasProxy = !!options.proxy;
    const totalHops = jumpHosts.length + 1; // +1 for final target

    // Build base connection options for final target
    const connectOpts = {
      host: options.hostname,
      port: options.port || 22,
      username: options.username || "root",
      // `readyTimeout` covers the entire connection + authentication flow in ssh2.
      readyTimeout: 20000, // Fast failure for non-interactive auth
      // Use user-configured keepalive interval (in seconds -> convert to ms)
      // If 0 or not provided, use 10000ms as default
      keepaliveInterval: options.keepaliveInterval && options.keepaliveInterval > 0 ? options.keepaliveInterval * 1000 : 10000,
      keepaliveCountMax: 3,
      // Enable keyboard-interactive authentication (required for 2FA/MFA)
      tryKeyboard: true,
      algorithms: {
        // Prioritize fastest ciphers (GCM modes are hardware-accelerated)
        cipher: [
          'aes128-gcm@openssh.com', 'aes256-gcm@openssh.com',
          'chacha20-poly1305@openssh.com',
          'aes128-ctr', 'aes192-ctr', 'aes256-ctr',
        ],
        // Prioritize modern key exchange algorithms for broad compatibility
        kex: [
          'curve25519-sha256', 'curve25519-sha256@libssh.org',
          'ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521',
          'diffie-hellman-group14-sha256',
          'diffie-hellman-group16-sha512', 'diffie-hellman-group18-sha512',
          'diffie-hellman-group-exchange-sha256',
        ],
        compress: ['none'],
      },
    };

    // Authentication for final target
    const hasCertificate = typeof options.certificate === "string" && options.certificate.trim().length > 0;
    const effectivePassphrase = options.passphrase;

    console.log("[SSH] Auth configuration:", {
      hasCertificate,
      keySource: options.keySource,
      hasPublicKey: !!options.publicKey,
      hasPrivateKey: !!options.privateKey,
      hasPassword: !!options.password,
      hasEffectivePassphrase: !!effectivePassphrase,
    });

    log("Auth configuration", {
      hasCertificate,
      keySource: options.keySource,
      hasPublicKey: !!options.publicKey,
      hasPrivateKey: !!options.privateKey,
    });

    let authAgent = null;
    if (hasCertificate) {
      authAgent = new NetcattyAgent({
        mode: "certificate",
        webContents: event.sender,
        meta: {
          label: options.keyId || options.username || "",
          certificate: options.certificate,
          privateKey: options.privateKey,
          passphrase: effectivePassphrase,
        },
      });
      connectOpts.agent = authAgent;
    } else if (options.privateKey) {
      connectOpts.privateKey = options.privateKey;
      if (effectivePassphrase) {
        connectOpts.passphrase = effectivePassphrase;
      }
    }

    if (options.password && typeof options.password === "string" && options.password.trim().length > 0) {
      connectOpts.password = options.password;
    }

    // Always try to find default SSH keys for fallback authentication
    // This allows fallback even when password auth fails
    let defaultKeyInfo = null;
    let allDefaultKeys = [];
    let usedDefaultKeyAsPrimary = false;
    const defaultKey = await findDefaultPrivateKey();
    if (defaultKey) {
      defaultKeyInfo = defaultKey;
      log("Found default SSH key for fallback", { keyPath: defaultKey.keyPath, keyName: defaultKey.keyName });
    }
    // Also find ALL default keys for comprehensive fallback
    allDefaultKeys = await findAllDefaultPrivateKeys();

    // Use unlocked encrypted keys if provided (from retry after auth failure)
    // These are passed via _unlockedEncryptedKeys from startSSHSessionWrapper
    const unlockedEncryptedKeys = options._unlockedEncryptedKeys || [];
    if (unlockedEncryptedKeys.length > 0) {
      log("Using unlocked encrypted keys from retry", { 
        count: unlockedEncryptedKeys.length,
        keyNames: unlockedEncryptedKeys.map(k => k.keyName)
      });
    }

    // If no primary auth method configured, try ssh-agent first, then ALL default keys
    if (!connectOpts.privateKey && !connectOpts.password && !connectOpts.agent) {
      // First, try to use ssh-agent if available (this is what regular SSH does)
      const sshAgentSocket = process.platform === "win32" 
        ? "\\\\.\\pipe\\openssh-ssh-agent" 
        : process.env.SSH_AUTH_SOCK;
      
      if (sshAgentSocket) {
        log("No auth method configured, trying ssh-agent first", { agentSocket: sshAgentSocket });
        connectOpts.agent = sshAgentSocket;
      }
      
      // Mark that we need to try all default keys (handled in authMethods below)
      if (allDefaultKeys.length > 0) {
        log("Will try all default SSH keys as fallback", { count: allDefaultKeys.length, keyNames: allDefaultKeys.map(k => k.keyName) });
        // Set first key for connectOpts.privateKey (required for ssh2 to allow publickey auth)
        connectOpts.privateKey = allDefaultKeys[0].privateKey;
        usedDefaultKeyAsPrimary = true;
      } else {
        log("No default SSH key found in ~/.ssh directory");
      }
    }

    log("Final auth configuration", {
      hasPrivateKey: !!connectOpts.privateKey,
      hasPassword: !!connectOpts.password,
      hasAgent: !!connectOpts.agent,
      hasDefaultKeyFallback: !!defaultKeyInfo,
    });

    // Agent forwarding
    if (options.agentForwarding) {
      connectOpts.agentForward = true;
      if (!connectOpts.agent) {
        if (process.platform === "win32") {
          connectOpts.agent = "\\\\.\\pipe\\openssh-ssh-agent";
        } else {
          connectOpts.agent = process.env.SSH_AUTH_SOCK;
        }
      }
    }

    // Build authentication handler with fallback support
    // ssh2 authHandler can be a function that returns the next auth method to try

    // Check if we have a cached successful auth method for this host
    const cachedMethod = getCachedAuthMethod(connectOpts.username, options.hostname, options.port);

    // Track which method succeeded for caching
    let lastTriedMethod = null;

    if (authAgent) {
      const order = ["agent"];
      if (connectOpts.password) order.push("password");
      // Add default key fallback if available and no user key configured
      // Must also set connectOpts.privateKey for ssh2 to actually try publickey auth
      if (defaultKeyInfo && !options.privateKey) {
        connectOpts.privateKey = defaultKeyInfo.privateKey;
        order.push("publickey");
      }
      order.push("keyboard-interactive");
      connectOpts.authHandler = order;
      log("Auth order (agent mode)", { order });
    } else {
      // Build dynamic auth handler for fallback support
      const authMethods = [];

      // First try user-configured key if available (explicit user choice)
      if (connectOpts.privateKey && !usedDefaultKeyAsPrimary) {
        authMethods.push({ type: "publickey", key: connectOpts.privateKey, passphrase: connectOpts.passphrase, id: "publickey-user" });
      }

      // Then try agent if configured (try agent before password since it's usually faster)
      if (connectOpts.agent) {
        authMethods.push({ type: "agent", id: "agent" });
      }

      // Then try password if available (explicit user choice)
      if (connectOpts.password) {
        authMethods.push({ type: "password", id: "password" });
      }

      // Then try ALL default SSH keys as fallback (not just the first one!)
      // This is critical because different servers may have different keys in authorized_keys
      if (usedDefaultKeyAsPrimary && allDefaultKeys.length > 0) {
        for (const keyInfo of allDefaultKeys) {
          authMethods.push({ 
            type: "publickey", 
            key: keyInfo.privateKey, 
            isDefault: true, 
            id: `publickey-default-${keyInfo.keyName}` 
          });
        }
      } else if (defaultKeyInfo && !options.privateKey && !usedDefaultKeyAsPrimary) {
        // Single default key fallback (when user has configured other auth methods)
        authMethods.push({ type: "publickey", key: defaultKeyInfo.privateKey, isDefault: true, id: "publickey-default" });
      }

      // Add unlocked encrypted default keys (user provided passphrases for these)
      for (const keyInfo of unlockedEncryptedKeys) {
        authMethods.push({ 
          type: "publickey", 
          key: keyInfo.privateKey, 
          passphrase: keyInfo.passphrase,
          isDefault: true, 
          id: `publickey-encrypted-${keyInfo.keyName}` 
        });
      }

      // Finally try keyboard-interactive
      authMethods.push({ type: "keyboard-interactive", id: "keyboard-interactive" });

      log("Auth methods configured", {
        methods: authMethods.map(m => ({ type: m.type, id: m.id, isDefault: m.isDefault || false })),
        cachedMethod,
        usedDefaultKeyAsPrimary
      });

      // Reorder methods based on cached successful method
      if (cachedMethod) {
        const cachedIndex = authMethods.findIndex(m => m.id === cachedMethod);
        if (cachedIndex > 0) {
          const [cachedAuthMethod] = authMethods.splice(cachedIndex, 1);
          authMethods.unshift(cachedAuthMethod);
          log("Reordered auth methods based on cache", {
            methods: authMethods.map(m => m.id)
          });
        }
      }

      // Use dynamic authHandler if we have multiple auth options
      if (authMethods.length > 1) {
        let authIndex = 0;
        // Track methods that have been attempted (to avoid re-trying on failure)
        // This prevents reusing the same key when server requires multiple publickey auth steps
        // and also prevents re-attempting failed methods
        const attemptedMethodIds = new Set();
        // Track the first successful method for caching (not the last one in multi-step flows)
        let firstSuccessfulMethod = null;
        // Track if we've gone through a partialSuccess flow (multi-step auth)
        let hadPartialSuccess = false;

        connectOpts.authHandler = (methodsLeft, partialSuccess, callback) => {
          log("authHandler called", { methodsLeft, partialSuccess, authIndex, attemptedMethodIds: Array.from(attemptedMethodIds) });

          // methodsLeft can be null on first call (before server responds with available methods)
          // Include "agent" for SSH agent-based auth (used with agentForwarding)
          const availableMethods = methodsLeft || ["publickey", "password", "keyboard-interactive", "agent"];

          // Handle partialSuccess case (e.g., password succeeded but server requires additional auth like MFA)
          // When partialSuccess is true, we should try the remaining methods the server is asking for
          if (partialSuccess && methodsLeft && methodsLeft.length > 0) {
            hadPartialSuccess = true;
            // Record the first successful method (the one that triggered partialSuccess)
            if (lastTriedMethod && !firstSuccessfulMethod) {
              firstSuccessfulMethod = lastTriedMethod;
              log("Recorded first successful method for caching", { method: firstSuccessfulMethod });
            }
            // Mark the last tried method as attempted (it succeeded, so we shouldn't retry it)
            if (lastTriedMethod) {
              attemptedMethodIds.add(lastTriedMethod);
              log("Marked method as attempted (partial success)", { method: lastTriedMethod });
            }

            log("Partial success - server requires additional auth", { methodsLeft, attemptedMethodIds: Array.from(attemptedMethodIds) });

            // Find a method from our list that matches what the server wants
            // Skip methods that have already been attempted
            for (const serverMethod of methodsLeft) {
              // Map server method names to our method types
              const matchingMethod = authMethods.find(m => {
                // Skip already attempted methods
                if (attemptedMethodIds.has(m.id)) return false;
                if (serverMethod === "keyboard-interactive" && m.type === "keyboard-interactive") return true;
                if (serverMethod === "password" && m.type === "password") return true;
                if (serverMethod === "publickey" && (m.type === "publickey" || m.type === "agent")) return true;
                return false;
              });

              if (matchingMethod) {
                log("Found matching method for partial success", { serverMethod, matchingMethod: matchingMethod.id });
                // Mark as attempted BEFORE returning to prevent re-use on failure
                attemptedMethodIds.add(matchingMethod.id);
                lastTriedMethod = matchingMethod.id;

                if (matchingMethod.type === "keyboard-interactive") {
                  log("Trying keyboard-interactive auth (partial success)", { id: matchingMethod.id });
                  return callback("keyboard-interactive");
                } else if (matchingMethod.type === "password") {
                  log("Trying password auth (partial success)", { id: matchingMethod.id });
                  return callback({
                    type: "password",
                    username: connectOpts.username,
                    password: connectOpts.password,
                  });
                } else if (matchingMethod.type === "agent") {
                  const agentType = typeof connectOpts.agent === "string" ? "path" : "NetcattyAgent";
                  log("Trying agent auth (partial success)", { id: matchingMethod.id, agentType });
                  return callback("agent");
                } else if (matchingMethod.type === "publickey") {
                  log("Trying publickey auth (partial success)", { id: matchingMethod.id });
                  return callback({
                    type: "publickey",
                    username: connectOpts.username,
                    key: matchingMethod.key,
                    passphrase: matchingMethod.passphrase,
                  });
                }
              }
            }
            // No matching method found for partial success
            log("No matching method found for partial success requirements", { methodsLeft });
            return callback(false);
          }

          while (authIndex < authMethods.length) {
            const method = authMethods[authIndex];
            authIndex++;

            // Skip methods that have already been attempted (e.g., during partial success handling)
            if (attemptedMethodIds.has(method.id)) {
              log("Skipping already attempted method", { method: method.id });
              continue;
            }

            // Check if this method is still available on server
            // Note: "agent" uses "publickey" as the underlying method type
            const methodName = method.type === "password" ? "password" :
                method.type === "publickey" ? "publickey" :
                method.type === "agent" ? "publickey" : "keyboard-interactive";
            if (!availableMethods.includes(methodName) && !availableMethods.includes(method.type)) {
              log("Auth method not available on server, skipping", { method: method.id });
              continue;
            }

            // Mark as attempted BEFORE returning
            attemptedMethodIds.add(method.id);
            lastTriedMethod = method.id;

            if (method.type === "agent") {
              // Only log safe identifier, not the full agent object which may contain private keys
              const agentType = typeof connectOpts.agent === "string" ? "path" : "NetcattyAgent";
              log("Trying agent auth", { id: method.id, agentType });
              // Return "agent" string to use SSH agent for authentication
              return callback("agent");
            } else if (method.type === "publickey") {
              log("Trying publickey auth", { id: method.id, isDefault: method.isDefault || false });
              return callback({
                type: "publickey",
                username: connectOpts.username,
                key: method.key,
                passphrase: method.passphrase,
              });
            } else if (method.type === "password") {
              log("Trying password auth", { id: method.id });
              return callback({
                type: "password",
                username: connectOpts.username,
                password: connectOpts.password,
              });
            } else if (method.type === "keyboard-interactive") {
              log("Trying keyboard-interactive auth", { id: method.id });
              // Return string instead of object - ssh2 requires a prompt function
              // for keyboard-interactive objects. Returning the string lets ssh2
              // use its default handling and trigger the keyboard-interactive event.
              return callback("keyboard-interactive");
            }
          }

          log("All auth methods exhausted");
          return callback(false);
        };

        // Store method reference for success callback
        // For multi-step auth (partialSuccess), cache the first successful method, not the last
        // This ensures next connection starts with the correct first factor
        connectOpts._lastTriedMethodRef = () => {
          if (hadPartialSuccess && firstSuccessfulMethod) {
            log("Using first successful method for cache (multi-step auth)", { firstSuccessfulMethod });
            return firstSuccessfulMethod;
          }
          return lastTriedMethod;
        };
      }
    }

    // Handle chain/proxy connections
    if (hasJumpHosts) {
      // Pass fetched keys to chain connection to avoid re-reading files
      options._defaultKeys = allDefaultKeys;

      const chainResult = await connectThroughChain(
        event,
        options,
        jumpHosts,
        options.hostname,
        options.port || 22,
        sessionId
      );
      connectionSocket = chainResult.socket;
      chainConnections = chainResult.connections;

      connectOpts.sock = connectionSocket;
      delete connectOpts.host;
      delete connectOpts.port;

      sendProgress(totalHops, totalHops, options.hostname, 'connecting');
    } else if (hasProxy) {
      sendProgress(1, 1, options.hostname, 'connecting');
      connectionSocket = await createProxySocket(
        options.proxy,
        options.hostname,
        options.port || 22
      );
      connectOpts.sock = connectionSocket;
      delete connectOpts.host;
      delete connectOpts.port;
    }

    return new Promise((resolve, reject) => {
      const logPrefix = hasJumpHosts ? '[Chain]' : '[SSH]';
      conn.on("ready", () => {
        console.log(`${logPrefix} ${options.hostname} ready`);

        // Cache the successful auth method
        if (connectOpts._lastTriedMethodRef) {
          const successMethod = connectOpts._lastTriedMethodRef();
          if (successMethod) {
            setCachedAuthMethod(connectOpts.username, options.hostname, options.port, successMethod);
          }
        }

        if (hasJumpHosts || hasProxy) {
          sendProgress(totalHops, totalHops, options.hostname, 'connected');
        }

        conn.shell(
          {
            term: "xterm-256color",
            cols,
            rows,
          },
          {
            env: {
              LANG: resolveLangFromCharset(options.charset),
              COLORTERM: "truecolor",
              ...(options.env || {}),
            },
          },
          (err, stream) => {
            if (err) {
              conn.end();
              for (const c of chainConnections) {
                try { c.end(); } catch { }
              }
              reject(err);
              return;
            }

            const session = {
              conn,
              stream,
              chainConnections,
              webContentsId: event.sender.id,
            };
            sessions.set(sessionId, session);

            // Data buffering for reduced IPC overhead
            let dataBuffer = '';
            let flushTimeout = null;
            const FLUSH_INTERVAL = 8; // ms - flush every 8ms for ~120fps equivalent
            const MAX_BUFFER_SIZE = 16384; // 16KB - flush immediately if buffer gets too large

            const flushBuffer = () => {
              if (dataBuffer.length > 0) {
                const contents = event.sender;
                safeSend(contents, "netcatty:data", { sessionId, data: dataBuffer });
                dataBuffer = '';
              }
              flushTimeout = null;
            };

            const bufferData = (data) => {
              dataBuffer += data;
              // Immediate flush for large chunks
              if (dataBuffer.length >= MAX_BUFFER_SIZE) {
                if (flushTimeout) {
                  clearTimeout(flushTimeout);
                  flushTimeout = null;
                }
                flushBuffer();
              } else if (!flushTimeout) {
                // Schedule flush
                flushTimeout = setTimeout(flushBuffer, FLUSH_INTERVAL);
              }
            };

            stream.on("data", (data) => {
              bufferData(data.toString("utf8"));
            });

            stream.stderr?.on("data", (data) => {
              bufferData(data.toString("utf8"));
            });

            stream.on("close", () => {
              // Flush any remaining data before close
              if (flushTimeout) {
                clearTimeout(flushTimeout);
              }
              flushBuffer();
              const contents = event.sender;
              safeSend(contents, "netcatty:exit", { sessionId, exitCode: 0 });
              sessions.delete(sessionId);
              conn.end();
              for (const c of chainConnections) {
                try { c.end(); } catch { }
              }
            });

            // Run startup command if specified
            if (options.startupCommand) {
              setTimeout(() => {
                stream.write(`${options.startupCommand}\n`);
              }, 300);
            }

            resolve({ sessionId });
          }
        );
      });

      conn.on("error", (err) => {
        const contents = event.sender;

        const isAuthError = err.message?.toLowerCase().includes('authentication') ||
          err.message?.toLowerCase().includes('auth') ||
          err.message?.toLowerCase().includes('password') ||
          err.level === 'client-authentication';

        // Clear cached auth method on auth failure so next attempt tries all methods
        if (isAuthError) {
          clearCachedAuthMethod(connectOpts.username, options.hostname, options.port);
          console.log(`${logPrefix} ${options.hostname} auth failed:`, err.message);
          safeSend(contents, "netcatty:auth:failed", {
            sessionId,
            error: err.message,
            hostname: options.hostname
          });
        } else {
          console.error(`${logPrefix} ${options.hostname} error:`, err.message);
        }

        safeSend(contents, "netcatty:exit", { sessionId, exitCode: 1, error: err.message });
        sessions.delete(sessionId);
        for (const c of chainConnections) {
          try { c.end(); } catch { }
        }
        reject(err);
      });

      conn.on("timeout", () => {
        console.error(`${logPrefix} ${options.hostname} connection timeout`);
        const err = new Error(`Connection timeout to ${options.hostname}`);
        const contents = event.sender;
        safeSend(contents, "netcatty:exit", { sessionId, exitCode: 1, error: err.message });
        sessions.delete(sessionId);
        for (const c of chainConnections) {
          try { c.end(); } catch { }
        }
        reject(err);
      });

      conn.on("close", () => {
        const contents = event.sender;
        safeSend(contents, "netcatty:exit", { sessionId, exitCode: 0 });
        sessions.delete(sessionId);
        for (const c of chainConnections) {
          try { c.end(); } catch { }
        }
      });

      // Handle keyboard-interactive authentication (2FA/MFA)
      conn.on("keyboard-interactive", (name, instructions, instructionsLang, prompts, finish) => {
        console.log(`${logPrefix} ${options.hostname} keyboard-interactive auth requested`, {
          name,
          instructions,
          promptCount: prompts?.length || 0,
          prompts: prompts?.map(p => ({ prompt: p.prompt, echo: p.echo })),
        });

        // If there are no prompts, just call finish with empty array
        if (!prompts || prompts.length === 0) {
          console.log(`${logPrefix} No prompts, finishing keyboard-interactive`);
          finish([]);
          return;
        }

        // Forward ALL prompts to user - no auto-fill to avoid semantic detection issues
        // (Prompt text is admin-customizable and may not contain expected keywords)
        const requestId = keyboardInteractiveHandler.generateRequestId('ssh');

        keyboardInteractiveHandler.storeRequest(requestId, (userResponses) => {
          console.log(`${logPrefix} Received user responses, finishing keyboard-interactive`);
          finish(userResponses);
        }, sender.id, sessionId);

        const promptsData = prompts.map((p) => ({
          prompt: p.prompt,
          echo: p.echo,
        }));

        console.log(`${logPrefix} Showing modal for ${promptsData.length} prompts`);

        safeSend(sender, "netcatty:keyboard-interactive", {
          requestId,
          sessionId,
          name: name || "",
          instructions: instructions || "",
          prompts: promptsData,
          hostname: options.hostname,
          savedPassword: options.password || null, // Pass saved password for optional fill button
        });
      });


      // Enable keyboard-interactive authentication in authHandler
      // Note: If authHandler is a function (for fallback support), keyboard-interactive
      // is already included in the auth methods list
      if (Array.isArray(connectOpts.authHandler)) {
        // Add keyboard-interactive after the existing methods
        if (!connectOpts.authHandler.includes("keyboard-interactive")) {
          connectOpts.authHandler.push("keyboard-interactive");
        }
      } else if (typeof connectOpts.authHandler !== "function") {
        // Create authHandler with keyboard-interactive support
        // This path is taken when usedDefaultKeyAsPrimary=true (only keyboard-interactive in authMethods)
        // Using array format is more reliable - ssh2 uses connectOpts credentials directly
        const authMethods = [];
        // Try agent FIRST (this is what regular SSH does - it checks ssh-agent before key files)
        if (connectOpts.agent) authMethods.push("agent");
        if (connectOpts.privateKey) authMethods.push("publickey");
        if (connectOpts.password) authMethods.push("password");
        authMethods.push("keyboard-interactive");
        connectOpts.authHandler = authMethods;
        log("Using simple array authHandler", { authMethods, usedDefaultKeyAsPrimary });
      }
      // If authHandler is a function, it already handles keyboard-interactive

      // Increase timeout to allow for keyboard-interactive auth
      connectOpts.readyTimeout = 120000; // 2 minutes for 2FA input

      // Enable debug logging for ssh2 to diagnose auth issues
      connectOpts.debug = (msg) => {
        // Only log auth-related messages to avoid noise
        if (msg.includes('Auth') || msg.includes('auth') || msg.includes('publickey') || msg.includes('keyboard')) {
          log("ssh2 debug", { msg });
        }
      };

      console.log(`${logPrefix} Connecting to ${options.hostname}...`);
      conn.connect(connectOpts);
    });
  } catch (err) {
    console.error("[Chain] SSH chain connection error:", err.message);
    const contents = event.sender;
    safeSend(contents, "netcatty:exit", { sessionId, exitCode: 1, error: err.message });
    throw err;
  }
}

/**
 * Execute a one-off command via SSH
 */
async function execCommand(event, payload) {
  const enableKeyboardInteractive = !!payload.enableKeyboardInteractive;
  const baseTimeoutMs = payload.timeout || 10000;
  const timeoutMs = enableKeyboardInteractive ? Math.max(baseTimeoutMs, 120000) : baseTimeoutMs;
  const sender = event.sender;
  const sessionId = payload.sessionId || `exec-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const defaultKeys = enableKeyboardInteractive ? await findAllDefaultPrivateKeysFromHelper() : [];

  return new Promise((resolve, reject) => {
    const conn = new SSHClient();
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      conn.end();
      reject(new Error("SSH exec timeout"));
    }, timeoutMs);

    conn
      .on("ready", () => {
        conn.exec(payload.command, (err, stream) => {
          if (err) {
            clearTimeout(timer);
            settled = true;
            conn.end();
            return reject(err);
          }
          stream
            .on("data", (data) => {
              stdout += data.toString();
            })
            .stderr.on("data", (data) => {
              stderr += data.toString();
            })
            .on("close", (code) => {
              if (settled) return;
              clearTimeout(timer);
              settled = true;
              conn.end();
              resolve({ stdout, stderr, code: code ?? (stderr ? 1 : 0) });
            });
        });
      })
      .on("error", (err) => {
        if (settled) return;
        clearTimeout(timer);
        settled = true;
        reject(err);
      })
      .on("end", () => {
        if (settled) return;
        clearTimeout(timer);
        settled = true;
        if (stderr || stdout) {
          resolve({ stdout, stderr, code: 0 });
        } else {
          reject(new Error("SSH connection closed unexpectedly"));
        }
      });

    const hasCertificate = typeof payload.certificate === "string" && payload.certificate.trim().length > 0;

    const connectOpts = {
      host: payload.hostname,
      port: payload.port || 22,
      username: payload.username,
      readyTimeout: enableKeyboardInteractive ? Math.max(timeoutMs, 120000) : timeoutMs,
      keepaliveInterval: 0,
    };

    let authAgent = null;
    if (hasCertificate) {
      authAgent = new NetcattyAgent({
        mode: "certificate",
        webContents: event.sender,
        meta: {
          label: payload.keyId || payload.username || "",
          certificate: payload.certificate,
          privateKey: payload.privateKey,
          passphrase: payload.passphrase,
        },
      });
      connectOpts.agent = authAgent;
    } else if (payload.privateKey) {
      connectOpts.privateKey = payload.privateKey;
      if (payload.passphrase) connectOpts.passphrase = payload.passphrase;
    }

    if (payload.password) connectOpts.password = payload.password;

    if (enableKeyboardInteractive) {
      connectOpts.tryKeyboard = true;

      const authConfig = buildAuthHandler({
        privateKey: connectOpts.privateKey,
        password: connectOpts.password,
        passphrase: connectOpts.passphrase,
        agent: connectOpts.agent,
        username: connectOpts.username,
        logPrefix: "[SSH Exec]",
        defaultKeys,
      });

      applyAuthToConnOpts(connectOpts, authConfig);

      conn.on("keyboard-interactive", createKeyboardInteractiveHandler({
        sender,
        sessionId,
        hostname: payload.hostname,
        password: payload.password,
        logPrefix: "[SSH Exec]",
      }));
    } else if (authAgent) {
      const order = ["agent"];
      if (connectOpts.password) order.push("password");
      connectOpts.authHandler = order;
    }

    conn.connect(connectOpts);
  });
}

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
      if (!options._unlockedEncryptedKeys || options._unlockedEncryptedKeys.length === 0) {
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
              throw retryErr;
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
    throw err;
  }
}

/**
 * Get current working directory from an active SSH session
 * This sends 'pwd' to the existing shell stream and captures the output
 * using unique markers to identify the command output boundaries
 */
async function getSessionPwd(event, payload) {
  const { sessionId } = payload;
  const session = sessions.get(sessionId);

  if (!session || !session.stream || !session.conn) {
    return { success: false, error: 'Session not found or not connected' };
  }

  return new Promise((resolve) => {
    const stream = session.stream;
    const marker = `__PWD_${Date.now()}__`;
    const timeout = setTimeout(() => {
      stream.removeListener('data', onData);
      resolve({ success: false, error: 'Timeout getting pwd' });
    }, 3000);

    let buffer = '';

    const onData = (data) => {
      const str = data.toString();
      buffer += str;

      // We need to find the ACTUAL output markers, not the command echo
      // The command echo looks like: echo '__PWD_xxx__S' && pwd && echo '__PWD_xxx__E'
      // The actual output looks like: __PWD_xxx__S\n/path/to/dir\n__PWD_xxx__E
      // 
      // We look for the marker at the START of a line (after newline) to avoid the echo
      const startMarkerRegex = new RegExp(`(?:^|[\\r\\n])${marker}S[\\r\\n]+`);
      const endMarkerRegex = new RegExp(`[\\r\\n]${marker}E(?:[\\r\\n]|$)`);

      const startMatch = buffer.match(startMarkerRegex);
      const endMatch = buffer.match(endMarkerRegex);

      if (startMatch && endMatch) {
        const startIdx = buffer.indexOf(startMatch[0]) + startMatch[0].length;
        const endIdx = buffer.indexOf(endMatch[0]);

        if (startIdx <= endIdx) {
          clearTimeout(timeout);
          stream.removeListener('data', onData);

          const pwdOutput = buffer.slice(startIdx, endIdx).trim();
          console.log('[getSessionPwd] pwdOutput:', JSON.stringify(pwdOutput));

          // The pwd output should be a valid absolute path
          if (pwdOutput && pwdOutput.startsWith('/')) {
            console.log('[getSessionPwd] Success, cwd:', pwdOutput);
            resolve({ success: true, cwd: pwdOutput });
          } else {
            console.log('[getSessionPwd] Failed - invalid path:', pwdOutput);
            resolve({ success: false, error: 'Invalid pwd output' });
          }
        }
      }
    };

    stream.on('data', onData);

    // Send pwd command with short unique markers
    // Using 'S' and 'E' as suffixes to make markers shorter
    // After the command, send ANSI escape sequences to clear the output lines:
    // \x1b[1A = move cursor up 1 line, \x1b[2K = clear entire line
    // Clear 4 lines: the command echo, START marker, pwd output, and END marker
    const clearLines = '\\x1b[1A\\x1b[2K\\x1b[1A\\x1b[2K\\x1b[1A\\x1b[2K\\x1b[1A\\x1b[2K';
    stream.write(` echo '${marker}S' && pwd && echo '${marker}E' && printf '${clearLines}'\n`);
  });
}

/**
 * Get server stats (CPU, Memory, Disk) from an active SSH session
 * Only works for Linux servers
 */
async function getServerStats(event, payload) {
  const { sessionId } = payload;
  const session = sessions.get(sessionId);

  if (!session || !session.conn) {
    return { success: false, error: 'Session not found or not connected' };
  }

  const conn = session.conn;

  // Command to get CPU (overall + per-core), Memory, Disk, and Network stats
  // This command is designed to work across most Linux distributions
  // Note: Using semicolons and avoiding comments for single-line execution
  // CPU: Output raw values (total and idle) instead of percentage - we calculate delta on backend
  const statsCommand = [
    // Get number of CPU cores
    `cores=$(nproc 2>/dev/null || grep -c "^processor" /proc/cpuinfo 2>/dev/null || echo "1")`,
    // Get raw CPU values from /proc/stat: "total idle" for overall CPU
    // We output raw values and calculate delta-based percentage on the backend
    `cpuraw=$(awk '/^cpu / {total=0; for(i=2;i<=NF;i++) total+=$i; printf "%d %d", total, $5}' /proc/stat 2>/dev/null || echo "")`,
    // Get raw per-core CPU values from /proc/stat: "total:idle,total:idle,..."
    `percoreraw=$(awk '/^cpu[0-9]/ {total=0; for(i=2;i<=NF;i++) total+=$i; printf "%d:%d,", total, $5}' /proc/stat 2>/dev/null | sed 's/,$//' || echo "")`,
    // Get memory details from /proc/meminfo (total, free, buffers, cached in KB)
    `meminfo=$(awk '/^MemTotal:/{t=$2} /^MemFree:/{f=$2} /^Buffers:/{b=$2} /^Cached:/{c=$2} /^SReclaimable:/{s=$2} END{printf "%d %d %d %d", t/1024, f/1024, b/1024, (c+s)/1024}' /proc/meminfo 2>/dev/null || echo "")`,
    // Get top 10 processes by memory - with BusyBox fallback
    // GNU ps: ps -eo pid,%mem,comm --sort=-%mem
    // BusyBox fallback: ps -o pid,vsz,comm and sort manually (BusyBox ps doesn't have %mem, use vsz instead)
    `procs=$(ps -eo pid,%mem,comm --sort=-%mem 2>/dev/null | awk 'NR>1 && NR<=11 {gsub(/;/, "_", $3); printf "%s;%.1f;%s,", $1, $2, $3}' | sed 's/,$//' || ps -o pid,vsz,comm 2>/dev/null | awk 'NR>1 {gsub(/;/, "_", $3); print $2, $1, $3}' | sort -rn | head -10 | awk -v total=$(awk '/^MemTotal:/{print $2}' /proc/meminfo) '{if(total>0) pct=$1*100/total; else pct=0; printf "%s;%.1f;%s,", $2, pct, $3}' | sed 's/,$//' || echo "")`,
    // Get all mounted disk info - with BusyBox fallback
    // GNU df: df -BG (block size in GB)
    // BusyBox fallback: df and calculate from 1K blocks, or df -h and parse units
    `disks=$(df -BG 2>/dev/null | awk 'NR>1 && $1 ~ /^\\/dev/ {gsub(/G/,"",$2); gsub(/G/,"",$3); gsub(/%/,"",$5); printf "%s:%s:%s:%s,", $6, $3, $2, $5}' | sed 's/,$//' || df 2>/dev/null | awk 'NR>1 && $1 ~ /^\\/dev/ {total=$2/1048576; used=$3/1048576; pct=$5; gsub(/%/,"",pct); printf "%s:%.0f:%.0f:%s,", $6, used, total, pct}' | sed 's/,$//' || echo "")`,
    // Get network interface stats from /proc/net/dev (interface:rx_bytes:tx_bytes), excluding lo and virtual interfaces
    `net=$(cat /proc/net/dev 2>/dev/null | awk 'NR>2 {gsub(/^[ \\t]+/, ""); split($0, a, ":"); iface=a[1]; if(iface != "lo" && iface !~ /^veth/ && iface !~ /^docker/ && iface !~ /^br-/) {split(a[2], b); printf "%s:%s:%s,", iface, b[1], b[9]}}' | sed 's/,$//' || echo "")`,
    // Output all stats (using CPURAW and PERCORERAW instead of CPU and PERCORE)
    `echo "CPURAW:$cpuraw|CORES:$cores|PERCORERAW:$percoreraw|MEMINFO:$meminfo|PROCS:$procs|DISKS:$disks|NET:$net"`
  ].join('; ');

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve({ success: false, error: 'Timeout getting server stats' });
    }, 5000);

    conn.exec(statsCommand, (err, stream) => {
      if (err) {
        clearTimeout(timeout);
        resolve({ success: false, error: err.message });
        return;
      }

      let stdout = '';
      let stderr = '';

      stream.on('data', (data) => {
        stdout += data.toString();
      });

      stream.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      stream.on('close', () => {
        clearTimeout(timeout);

        // Parse the output
        const output = stdout.trim();
        const parts = output.split('|');

        let cpuRawTotal = null;
        let cpuRawIdle = null;
        let cpuPerCoreRaw = [];  // Array of { total, idle }
        let cpuCores = null;
        let memTotal = null;
        let memFree = null;
        let memBuffers = null;
        let memCached = null;
        let memUsed = null;
        let topProcesses = [];  // Array of { pid, memPercent, command }
        let disks = [];  // Array of { mountPoint, used, total, percent }
        let networkInterfaces = [];  // Array of { name, rxBytes, txBytes }

        for (const part of parts) {
          if (part.startsWith('CPURAW:')) {
            const rawParts = part.substring(7).trim().split(/\s+/);
            if (rawParts.length >= 2) {
              cpuRawTotal = parseInt(rawParts[0], 10);
              cpuRawIdle = parseInt(rawParts[1], 10);
            }
          } else if (part.startsWith('CORES:')) {
            const coreStr = part.substring(6).trim();
            const val = parseInt(coreStr, 10);
            if (!isNaN(val) && val > 0) cpuCores = val;
          } else if (part.startsWith('PERCORERAW:')) {
            const coreStr = part.substring(11).trim();
            if (coreStr && coreStr !== '') {
              cpuPerCoreRaw = coreStr.split(',').map(v => {
                const coreParts = v.trim().split(':');
                if (coreParts.length >= 2) {
                  const total = parseInt(coreParts[0], 10);
                  const idle = parseInt(coreParts[1], 10);
                  if (!isNaN(total) && !isNaN(idle)) {
                    return { total, idle };
                  }
                }
                return null;
              }).filter(v => v !== null);
            }
          } else if (part.startsWith('MEMINFO:')) {
            const memParts = part.substring(8).trim().split(/\s+/);
            if (memParts.length >= 4) {
              const total = parseInt(memParts[0], 10);
              const free = parseInt(memParts[1], 10);
              const buffers = parseInt(memParts[2], 10);
              const cached = parseInt(memParts[3], 10);
              if (!isNaN(total)) memTotal = total;
              if (!isNaN(free)) memFree = free;
              if (!isNaN(buffers)) memBuffers = buffers;
              if (!isNaN(cached)) memCached = cached;
              // Calculate used memory (excluding buffers/cache)
              if (memTotal !== null && memFree !== null && memBuffers !== null && memCached !== null) {
                memUsed = memTotal - memFree - memBuffers - memCached;
                if (memUsed < 0) memUsed = 0;
              }
            }
          } else if (part.startsWith('PROCS:')) {
            const procsStr = part.substring(6).trim();
            if (procsStr && procsStr !== '') {
              const procEntries = procsStr.split(',');
              for (const entry of procEntries) {
                const procParts = entry.split(';');  // Using ; as delimiter
                if (procParts.length >= 3) {
                  const pid = procParts[0];
                  const memPercent = parseFloat(procParts[1]);
                  const command = procParts.slice(2).join(';');  // Command might contain semicolons
                  if (!isNaN(memPercent)) {
                    topProcesses.push({ pid, memPercent, command });
                  }
                }
              }
            }
          } else if (part.startsWith('DISKS:')) {
            const disksStr = part.substring(6).trim();
            if (disksStr && disksStr !== '') {
              const diskEntries = disksStr.split(',');
              for (const entry of diskEntries) {
                const diskParts = entry.split(':');
                if (diskParts.length >= 4) {
                  const mountPoint = diskParts[0];
                  const used = parseInt(diskParts[1], 10);
                  const total = parseInt(diskParts[2], 10);
                  const percent = parseInt(diskParts[3], 10);
                  if (!isNaN(used) && !isNaN(total) && !isNaN(percent)) {
                    disks.push({ mountPoint, used, total, percent });
                  }
                }
              }
            }
          } else if (part.startsWith('NET:')) {
            const netStr = part.substring(4).trim();
            if (netStr && netStr !== '') {
              const netEntries = netStr.split(',');
              for (const entry of netEntries) {
                const netParts = entry.split(':');
                if (netParts.length >= 3) {
                  const name = netParts[0];
                  const rxBytes = parseInt(netParts[1], 10);
                  const txBytes = parseInt(netParts[2], 10);
                  if (!isNaN(rxBytes) && !isNaN(txBytes)) {
                    networkInterfaces.push({ name, rxBytes, txBytes });
                  }
                }
              }
            }
          }
        }

        // Calculate network speed based on previous reading
        const now = Date.now();
        const prevNet = session.prevNetStats || { interfaces: [], timestamp: 0 };
        const timeDelta = (now - prevNet.timestamp) / 1000; // seconds

        let netRxSpeed = 0;  // bytes per second
        let netTxSpeed = 0;  // bytes per second
        const netInterfaces = [];

        if (timeDelta > 0 && prevNet.interfaces.length > 0) {
          for (const iface of networkInterfaces) {
            const prevIface = prevNet.interfaces.find(p => p.name === iface.name);
            if (prevIface) {
              const rxDelta = iface.rxBytes - prevIface.rxBytes;
              const txDelta = iface.txBytes - prevIface.txBytes;
              // Only count positive deltas (handles counter reset)
              const rxSpeed = rxDelta > 0 ? Math.round(rxDelta / timeDelta) : 0;
              const txSpeed = txDelta > 0 ? Math.round(txDelta / timeDelta) : 0;
              netRxSpeed += rxSpeed;
              netTxSpeed += txSpeed;
              netInterfaces.push({
                name: iface.name,
                rxBytes: iface.rxBytes,
                txBytes: iface.txBytes,
                rxSpeed,
                txSpeed,
              });
            } else {
              netInterfaces.push({
                name: iface.name,
                rxBytes: iface.rxBytes,
                txBytes: iface.txBytes,
                rxSpeed: 0,
                txSpeed: 0,
              });
            }
          }
        } else {
          // First reading - no speed data yet
          for (const iface of networkInterfaces) {
            netInterfaces.push({
              name: iface.name,
              rxBytes: iface.rxBytes,
              txBytes: iface.txBytes,
              rxSpeed: 0,
              txSpeed: 0,
            });
          }
        }

        // Store current reading for next calculation
        session.prevNetStats = {
          interfaces: networkInterfaces,
          timestamp: now,
        };

        // Calculate CPU usage based on delta from previous reading
        const prevCpu = session.prevCpuStats || { total: 0, idle: 0, perCore: [], timestamp: 0 };
        let cpu = null;
        let cpuPerCore = [];

        if (cpuRawTotal !== null && cpuRawIdle !== null && prevCpu.total > 0) {
          const totalDelta = cpuRawTotal - prevCpu.total;
          const idleDelta = cpuRawIdle - prevCpu.idle;
          if (totalDelta > 0) {
            // CPU% = 100 - (idleDelta / totalDelta * 100)
            cpu = Math.round(100 - (idleDelta / totalDelta * 100));
            // Clamp to valid range
            if (cpu < 0) cpu = 0;
            if (cpu > 100) cpu = 100;
          }
        }

        // Calculate per-core CPU usage from deltas
        if (cpuPerCoreRaw.length > 0 && prevCpu.perCore.length > 0) {
          cpuPerCore = cpuPerCoreRaw.map((core, index) => {
            const prevCore = prevCpu.perCore[index];
            if (prevCore) {
              const totalDelta = core.total - prevCore.total;
              const idleDelta = core.idle - prevCore.idle;
              if (totalDelta > 0) {
                let usage = Math.round(100 - (idleDelta / totalDelta * 100));
                if (usage < 0) usage = 0;
                if (usage > 100) usage = 100;
                return usage;
              }
            }
            return 0;
          });
        } else if (cpuPerCoreRaw.length > 0) {
          // First reading - no delta data yet, return zeros
          cpuPerCore = cpuPerCoreRaw.map(() => 0);
        }

        // Store current CPU reading for next calculation
        session.prevCpuStats = {
          total: cpuRawTotal || 0,
          idle: cpuRawIdle || 0,
          perCore: cpuPerCoreRaw,
          timestamp: now,
        };

        // For backward compatibility, extract root disk info
        const rootDisk = disks.find(d => d.mountPoint === '/');
        const diskPercent = rootDisk ? rootDisk.percent : null;
        const diskUsed = rootDisk ? rootDisk.used : null;
        const diskTotal = rootDisk ? rootDisk.total : null;

        resolve({
          success: true,
          stats: {
            cpu,           // CPU usage percentage (0-100)
            cpuCores,      // Number of CPU cores
            cpuPerCore,    // Per-core CPU usage array
            memTotal,      // Total memory in MB
            memUsed,       // Used memory in MB (excluding buffers/cache)
            memFree,       // Free memory in MB
            memBuffers,    // Buffers in MB
            memCached,     // Cached in MB
            topProcesses,  // Top 10 processes by memory
            diskPercent,   // Disk usage percentage for root partition (backward compat)
            diskUsed,      // Disk used in GB for root partition (backward compat)
            diskTotal,     // Total disk in GB for root partition (backward compat)
            disks,         // Array of all mounted disks
            netRxSpeed,    // Total network receive speed (bytes/sec)
            netTxSpeed,    // Total network transmit speed (bytes/sec)
            netInterfaces, // Per-interface network stats
          },
        });
      });
    });
  });
}

/**
 * Register IPC handlers for SSH operations
 */
function registerHandlers(ipcMain) {
  ipcMain.handle("netcatty:start", startSSHSessionWrapper);
  ipcMain.handle("netcatty:ssh:exec", execCommand);
  ipcMain.handle("netcatty:ssh:pwd", getSessionPwd);
  ipcMain.handle("netcatty:ssh:stats", getServerStats);
  ipcMain.handle("netcatty:key:generate", generateKeyPair);
  ipcMain.handle("netcatty:ssh:check-agent", async () => {
    return await checkWindowsSshAgent();
  });
  ipcMain.handle("netcatty:ssh:get-default-keys", async () => {
    const sshDir = path.join(os.homedir(), ".ssh");
    const keys = [];
    for (const name of DEFAULT_KEY_NAMES) {
      const keyPath = path.join(sshDir, name);
      try {
        await fs.promises.access(keyPath, fs.constants.F_OK);
        keys.push({ name, path: keyPath });
      } catch {
        // ignore missing keys
      }
    }
    return keys;
  });
  // Register the shared keyboard-interactive response handler
  keyboardInteractiveHandler.registerHandler(ipcMain);
  // Register the passphrase response handler
  passphraseHandler.registerHandler(ipcMain);
}

module.exports = {
  init,
  registerHandlers,
  createProxySocket,
  startSSHSession,
  execCommand,
  getSessionPwd,
  getServerStats,
  generateKeyPair,
  checkWindowsSshAgent,
  findDefaultPrivateKey,
  findAllDefaultPrivateKeys,
  isKeyEncrypted,
  findAllDefaultPrivateKeys,
  isKeyEncrypted,
};
