/**
 * SSH Authentication Helper - Shared authentication logic for SSH connections
 * Used by sshBridge, sftpBridge, and portForwardingBridge
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { exec } = require("node:child_process");
const { utils: sshUtils } = require("ssh2");
const keyboardInteractiveHandler = require("./keyboardInteractiveHandler.cjs");
const passphraseHandler = require("./passphraseHandler.cjs");

// Default SSH key names in priority order
const PREFERRED_KEY_NAMES = ["id_ed25519", "id_ecdsa", "id_rsa"];
const SSH_KEY_PATTERN = /^id_[\w-]+$/;

class PassphraseCancelledError extends Error {
  constructor(keyPath) {
    super(`Passphrase entry cancelled for ${keyPath}`);
    this.name = "PassphraseCancelledError";
    this.code = "ERR_PASSPHRASE_CANCELLED";
    this.cancelled = true;
  }
}

function isPassphraseCancelledError(err) {
  return Boolean(err?.cancelled || err?.code === "ERR_PASSPHRASE_CANCELLED");
}

async function readFileNoFollow(filePath) {
  const lstat = await fs.promises.lstat(filePath);
  if (!lstat.isFile() && !lstat.isSymbolicLink()) return null;
  const fd = await fs.promises.open(filePath, "r", 0o0);
  try {
    return await fs.promises.readFile(fd, { encoding: "utf8" });
  } finally {
    await fd.close();
  }
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
  if (!keyContent || typeof keyContent !== "string") return false;

  // Check for PuTTY PPK encrypted format (Encryption: aes256-cbc, etc.)
  // PPK keys with "Encryption: none" are unencrypted
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

  // Check for DEK-Info header (legacy PEM encryption indicator)
  if (keyContent.includes("DEK-Info:")) return true;

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

function expandIdentityFilePath(keyPath) {
  return keyPath.startsWith("~/")
    ? path.join(os.homedir(), keyPath.slice(2))
    : keyPath;
}

function notifyPassphraseAuthFailed(sender, keyPath, resolvedPath, keyIds) {
  const keyPaths = resolvedPath && resolvedPath !== keyPath
    ? [keyPath, resolvedPath]
    : [keyPath];
  try {
    if (typeof sender?.isDestroyed === "function" && sender.isDestroyed()) return;
    const payload = { keyPaths };
    if (Array.isArray(keyIds) && keyIds.length > 0) {
      payload.keyIds = keyIds;
    }
    sender?.send?.("netcatty:passphrase-auth-failed", payload);
  } catch {
    // Sender may have gone away while authentication was in progress.
  }
}

async function preparePrivateKeyForAuth({
  sender,
  privateKey,
  keyPath,
  keyId,
  keyName,
  hostname,
  initialPassphrase,
  passphraseSignal,
  logPrefix = "[SSHAuth]",
}) {
  if (!privateKey) return null;

  if (!isKeyEncrypted(privateKey)) {
    return { privateKey, keyPath, keyName };
  }

  const promptKeyPath = keyPath || `SSH key for ${keyName || hostname || "connection"}`;
  const promptKeyName = keyName || path.basename(promptKeyPath);
  let passphraseInvalid = false;

  if (initialPassphrase) {
    const parsed = sshUtils.parseKey(privateKey, initialPassphrase);
    if (parsed && !(parsed instanceof Error)) {
      return { privateKey, keyPath, keyName, passphrase: initialPassphrase };
    }
    console.log(`${logPrefix} Stored passphrase failed for private key`, { keyPath: promptKeyPath });
    notifyPassphraseAuthFailed(sender, promptKeyPath, undefined, keyId ? [keyId] : undefined);
    passphraseInvalid = true;
  }

  while (true) {
    console.log(`${logPrefix} Private key is encrypted, requesting passphrase`, {
      keyPath: promptKeyPath,
      passphraseInvalid,
    });
    const result = await passphraseHandler.requestPassphrase(
      sender,
      promptKeyPath,
      promptKeyName,
      hostname,
      passphraseInvalid,
      { signal: passphraseSignal }
    );
    if (result?.cancelled) {
      throw new PassphraseCancelledError(promptKeyPath);
    }
    if (!result?.passphrase) {
      return null;
    }

    const parsed = sshUtils.parseKey(privateKey, result.passphrase);
    if (parsed && !(parsed instanceof Error)) {
      return { privateKey, keyPath, keyName, passphrase: result.passphrase };
    }

    console.log(`${logPrefix} Entered passphrase failed for private key`, { keyPath: promptKeyPath });
    notifyPassphraseAuthFailed(sender, promptKeyPath, undefined, keyId ? [keyId] : undefined);
    passphraseInvalid = true;
  }
}

async function loadIdentityFileForAuth({
  sender,
  keyPath,
  hostname,
  initialPassphrase,
  passphraseSignal,
  logPrefix = "[SSHAuth]",
}) {
  const resolvedPath = expandIdentityFilePath(keyPath);
  const privateKey = await fs.promises.readFile(resolvedPath, "utf8");
  const keyName = path.basename(resolvedPath);

  if (!isKeyEncrypted(privateKey)) {
    return { privateKey, keyPath: resolvedPath, keyName };
  }

  let passphraseInvalid = false;
  if (initialPassphrase) {
    const parsed = sshUtils.parseKey(privateKey, initialPassphrase);
    if (parsed && !(parsed instanceof Error)) {
      return { privateKey, keyPath: resolvedPath, keyName, passphrase: initialPassphrase };
    }
    console.log(`${logPrefix} Stored passphrase failed for identity file`, { keyPath: resolvedPath });
    notifyPassphraseAuthFailed(sender, keyPath, resolvedPath);
    passphraseInvalid = true;
  }

  while (true) {
    console.log(`${logPrefix} Identity file is encrypted, requesting passphrase`, {
      keyPath: resolvedPath,
      passphraseInvalid,
    });
    const result = await passphraseHandler.requestPassphrase(
      sender,
      resolvedPath,
      keyName,
      hostname,
      passphraseInvalid,
      { signal: passphraseSignal }
    );
    if (result?.cancelled) {
      throw new PassphraseCancelledError(resolvedPath);
    }
    if (!result?.passphrase) {
      return null;
    }

    const parsed = sshUtils.parseKey(privateKey, result.passphrase);
    if (parsed && !(parsed instanceof Error)) {
      return { privateKey, keyPath: resolvedPath, keyName, passphrase: result.passphrase };
    }

    console.log(`${logPrefix} Entered passphrase failed for identity file`, { keyPath: resolvedPath });
    notifyPassphraseAuthFailed(sender, keyPath, resolvedPath);
    passphraseInvalid = true;
  }
}

async function loadFirstIdentityFileForAuth({
  sender,
  identityFilePaths,
  hostname,
  initialPassphrase,
  passphraseSignal,
  logPrefix = "[SSHAuth]",
  onLoaded,
  onError,
}) {
  if (!Array.isArray(identityFilePaths) || identityFilePaths.length === 0) {
    return null;
  }

  for (const keyPath of identityFilePaths) {
    try {
      const identityFile = await loadIdentityFileForAuth({
        sender,
        keyPath,
        hostname,
        initialPassphrase,
        passphraseSignal,
        logPrefix,
      });
      if (!identityFile) {
        continue;
      }
      onLoaded?.(identityFile);
      return identityFile;
    } catch (err) {
      if (isPassphraseCancelledError(err)) {
        throw err;
      }
      onError?.(err, keyPath);
    }
  }

  return null;
}

/**
 * Find default SSH private key from user's ~/.ssh directory
 * Skips encrypted keys that require a passphrase
 * @returns {Promise<{ privateKey: string, keyPath: string, keyName: string } | null>}
 */
async function findDefaultPrivateKey() {
  const sshDir = path.join(os.homedir(), ".ssh");
  let allNames = [];
  try {
    const entries = await fs.promises.readdir(sshDir);
    allNames = entries.filter(f => SSH_KEY_PATTERN.test(f));
  } catch {
    return null;
  }
  const preferred = PREFERRED_KEY_NAMES.filter(n => allNames.includes(n));
  const rest = allNames.filter(n => !PREFERRED_KEY_NAMES.includes(n)).sort();
  const sorted = [...preferred, ...rest];

  for (const name of sorted) {
    const keyPath = path.join(sshDir, name);
    try {
      const privateKey = await readFileNoFollow(keyPath);
      if (!privateKey) continue;
      if (!looksLikePrivateKey(privateKey)) continue;
      if (isKeyEncrypted(privateKey)) continue;
      return { privateKey, keyPath, keyName: name };
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Find ALL default SSH private keys from user's ~/.ssh directory
* @param {Object} [options]
* @param {boolean} [options.includeEncrypted=false] - If true, include encrypted keys with isEncrypted flag
* @returns {Promise<Array<{ privateKey: string, keyPath: string, keyName: string, isEncrypted?: boolean }>>}
 */
async function findAllDefaultPrivateKeys(options = {}) {
  const { includeEncrypted = false } = options;
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

  const promises = sorted.map(async (name) => {
    const keyPath = path.join(sshDir, name);
    try {
      const privateKey = await readFileNoFollow(keyPath);
      if (!privateKey) return null;
      if (!looksLikePrivateKey(privateKey)) return null;
      const encrypted = isKeyEncrypted(privateKey);
      if (encrypted && !includeEncrypted) {
        return null;
      }
      return {
        privateKey,
        keyPath,
        keyName: name,
        ...(includeEncrypted ? { isEncrypted: encrypted } : {})
      };
    } catch {
      return null;
    }
  });

  const results = await Promise.all(promises);
  return results.filter(Boolean);
}

const WIN_SSH_AGENT_PIPE = "\\\\.\\pipe\\openssh-ssh-agent";

/**
 * Check if a Windows named pipe is connectable.
 * fs.statSync is unreliable for named pipes (returns EBUSY even when the
 * pipe is usable), so we attempt an actual net.connect() which is the
 * authoritative check.
 * @param {string} pipePath
 * @param {number} [timeoutMs=1000]
 * @returns {Promise<boolean>}
 */
function windowsPipeConnectable(pipePath, timeoutMs = 1000) {
  const net = require("net");
  return new Promise((resolve) => {
    const socket = net.connect(pipePath);
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch {}
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/**
 * Check if an SSH agent is available on Windows.
 * Probes the well-known named pipe via net.connect(). This supports any
 * agent that provides the pipe — Bitwarden, 1Password, gpg-agent, etc.
 * @returns {Promise<boolean>}
 */
function checkWindowsSshAgentRunning() {
  if (process.platform !== "win32") {
    return Promise.resolve(true);
  }
  return windowsPipeConnectable(WIN_SSH_AGENT_PIPE);
}

/**
 * Get ssh-agent socket path based on platform (synchronous, best-effort)
 * @returns {string|null}
 */
function getSshAgentSocket() {
  if (process.platform === "win32") {
    // On Windows, always return the pipe path; the caller should use
    // getAvailableAgentSocket() for a reliable async check.
    return "\\\\.\\pipe\\openssh-ssh-agent";
  }
  const agentSocket = process.env.SSH_AUTH_SOCK;
  if (!agentSocket) return null;

  try {
    const stats = fs.statSync(agentSocket);
    return typeof stats.isSocket === "function" && stats.isSocket()
      ? agentSocket
      : null;
  } catch {
    return null;
  }
}

/**
 * Get ssh-agent socket path with async validation (checks Windows service status)
 * @returns {Promise<string|null>}
 */
async function getAvailableAgentSocket() {
  if (process.platform === "win32") {
    const running = await checkWindowsSshAgentRunning();
    return running ? "\\\\.\\pipe\\openssh-ssh-agent" : null;
  }
  return getSshAgentSocket();
}

/**
 * Build authentication handler with default key fallback support
 * @param {Object} options
 * @param {string} [options.privateKey] - Explicitly configured private key
 * @param {string} [options.password] - Password for authentication
* @param {string} [options.passphrase] - Passphrase for encrypted private key
 * @param {Object} [options.agent] - SSH agent (NetcattyAgent or socket path)
 * @param {string} options.username - SSH username
 * @param {string} [options.logPrefix] - Log prefix for debugging
 * @returns {{ authHandler: Function|Array, privateKey: string|null, agent: string|Object|null, usedDefaultKeys: boolean }}
* @param {Array} [options.unlockedEncryptedKeys] - Array of unlocked encrypted keys with passphrases
 */
function buildAuthHandler(options) {
  const { privateKey, password, passphrase, agent, username, logPrefix = "[SSH]", unlockedEncryptedKeys = [], defaultKeys = [], sshAgentSocketOverride, onAuthAttempt } = options;

  // Determine what type of explicit auth the user configured
  const hasExplicitKey = !!privateKey;
  const hasExplicitPassword = !!password;
  const hasExplicitAgent = !!agent;
  const hasExplicitAuth = hasExplicitKey || hasExplicitPassword || hasExplicitAgent;

  // Determine if this is a password-only or key-only connection
  const isPasswordOnly = hasExplicitPassword && !hasExplicitKey && !hasExplicitAgent;
  const isKeyOnly = hasExplicitKey && !hasExplicitAgent;

  // Allow callers to pass in a pre-validated agent socket (e.g. from async
  // getAvailableAgentSocket). Fall back to synchronous getSshAgentSocket()
  // which on Windows always returns the pipe path without checking the service.
  const sshAgentSocket = sshAgentSocketOverride !== undefined ? sshAgentSocketOverride : getSshAgentSocket();

  // Only use system ssh-agent BEFORE user's auth when:
  // - User explicitly configured agent, OR
  // - No explicit auth is configured (pure fallback mode)
  // When user configured key/password, system agent should only be used AFTER as fallback
  const useAgentFirst = hasExplicitAgent || !hasExplicitAuth;

  // Determine effective agent
  const effectiveAgent = agent || (useAgentFirst ? sshAgentSocket : null);

  // Determine effective privateKey (user-provided takes priority)
  const effectivePrivateKey = privateKey || (!hasExplicitAuth && defaultKeys.length > 0 ? defaultKeys[0].privateKey : null);

  // Determine fallback keys (keys to try after user's primary auth fails)
  // - If user provided a key: all default keys are fallbacks
  // - If no explicit auth: first default key is primary, rest are fallbacks  
  // - If password-only or agent-only: all default keys are fallbacks (tried after primary)
  const fallbackKeys = hasExplicitKey
    ? defaultKeys
    : !hasExplicitAuth
      ? defaultKeys.slice(1)
      : defaultKeys;

  // Check if we need dynamic handler (have fallback options)
  const hasFallbackOptions = fallbackKeys.length > 0 ||
    (!hasExplicitAgent && sshAgentSocket) ||
    (isPasswordOnly && defaultKeys.length > 0);

  // If only simple auth methods and no fallback keys needed, use array-based handler
  if (hasExplicitAuth && !hasFallbackOptions) {
    const authMethods = ["none"]; // Always try none first per RFC 4252
    if (effectiveAgent) authMethods.push("agent");
    if (privateKey) authMethods.push("publickey");
    if (password) authMethods.push("password");
    authMethods.push("keyboard-interactive");

    return {
      authHandler: authMethods,
      privateKey: effectivePrivateKey,
      agent: effectiveAgent,
      usedDefaultKeys: false,
    };
  }

  // Build comprehensive authMethods array with all auth options
  // Order depends on what user explicitly configured:
  // - Password-only: password -> agent -> default keys -> keyboard-interactive
  // - Key-only: user key -> password -> agent -> default keys -> keyboard-interactive  
  // - Agent configured: agent -> user key -> password -> default keys -> keyboard-interactive
  // - No explicit auth: agent -> default keys -> keyboard-interactive
  const authMethods = [];

  if (isPasswordOnly) {
    // Password-only: respect user's explicit choice, no key/agent fallback
    authMethods.push({ type: "password", id: "password" });
  } else if (isKeyOnly) {
    // Key-only: user key first, then password (if any), then agent/default keys as fallback

    // 1. User-provided key first
    authMethods.push({
      type: "publickey",
      key: privateKey,
      passphrase: passphrase,
      id: "publickey-user"
    });

    // 2. Password (if configured alongside key)
    if (password) {
      authMethods.push({ type: "password", id: "password" });
    }

    // 3. System agent as fallback (AFTER user's key)
    if (sshAgentSocket) {
      authMethods.push({ type: "agent", id: "agent" });
    }

    // 4. Default keys as fallback
    for (const keyInfo of fallbackKeys) {
      authMethods.push({
        type: "publickey",
        key: keyInfo.privateKey,
        id: `publickey-default-${keyInfo.keyName}`
      });
    }
  } else {
    // Agent configured or no explicit auth: agent -> user key -> password -> default keys

    // 1. Agent (user-provided or system)
    if (effectiveAgent) {
      authMethods.push({ type: "agent", id: "agent" });
    }

    // 2. User-provided key
    if (privateKey) {
      authMethods.push({
        type: "publickey",
        key: privateKey,
        passphrase: passphrase,
        id: "publickey-user"
      });
    }

    // 3. Password (if configured)
    if (password) {
      authMethods.push({ type: "password", id: "password" });
    }

    // 4. Default keys as fallback
    for (const keyInfo of fallbackKeys) {
      authMethods.push({
        type: "publickey",
        key: keyInfo.privateKey,
        id: `publickey-default-${keyInfo.keyName}`
      });
    }

    // 5. If no user key provided, add first default key at the beginning (after agent)
    if (!privateKey && defaultKeys.length > 0) {
      const insertIndex = effectiveAgent ? 1 : 0;
      authMethods.splice(insertIndex, 0, {
        type: "publickey",
        key: defaultKeys[0].privateKey,
        id: `publickey-default-${defaultKeys[0].keyName}`
      });
    }
  }

  // Add unlocked encrypted default keys (user provided passphrases for these)
  for (const keyInfo of unlockedEncryptedKeys) {
    authMethods.push({
      type: "publickey",
      key: keyInfo.privateKey,
      passphrase: keyInfo.passphrase,
      id: `publickey-encrypted-${keyInfo.keyName}`
    });
  }

  // Keyboard-interactive as last resort
  authMethods.push({ type: "keyboard-interactive", id: "keyboard-interactive" });

  console.log(`${logPrefix} Auth methods configured`, {
    isPasswordOnly,
    hasUserKey: !!privateKey,
    hasPassword: !!password,
    hasAgent: !!effectiveAgent,
    methodCount: authMethods.length,
    methods: authMethods.map(m => m.id),
  });

  // Use dynamic authHandler to try all keys
  let authIndex = 0;
  let lastAttemptedLabel = null;
  const attemptedMethodIds = new Set();

  let triedNone = false;

  const authHandler = (methodsLeft, partialSuccess, callback) => {
    // Per RFC 4252, always try "none" first to discover available methods
    // and to support passwordless login (e.g. embedded devices).
    // This matches the behavior of OpenSSH and Tabby.
    if (methodsLeft === null && !triedNone) {
      triedNone = true;
      lastAttemptedLabel = "none (no credentials)";
      onAuthAttempt?.("none (no credentials)");
      return callback("none");
    }

    const availableMethods = methodsLeft || ["publickey", "password", "keyboard-interactive", "agent"];

    // Log rejection of previous method (authHandler is called again when server rejects)
    if (lastAttemptedLabel && !partialSuccess) {
      onAuthAttempt?.(`${lastAttemptedLabel} rejected`);
    }

    while (authIndex < authMethods.length) {
      const method = authMethods[authIndex];
      authIndex++;

      if (attemptedMethodIds.has(method.id)) continue;
      attemptedMethodIds.add(method.id);

      if (method.type === "agent" && (availableMethods.includes("publickey") || availableMethods.includes("agent"))) {
        console.log(`${logPrefix} Trying agent auth`);
        lastAttemptedLabel = "SSH agent";
        onAuthAttempt?.("SSH agent");
        return callback("agent");
      } else if (method.type === "publickey" && availableMethods.includes("publickey")) {
        console.log(`${logPrefix} Trying publickey auth:`, method.id);
        // Build a readable label for the key
        const keyLabel = method.id.startsWith("publickey-default-")
          ? `key ${method.id.replace("publickey-default-", "")}`
          : method.id.startsWith("publickey-encrypted-")
            ? `key ${method.id.replace("publickey-encrypted-", "")} (encrypted)`
            : method.id === "publickey-user"
              ? "configured key"
              : method.id;
        lastAttemptedLabel = keyLabel;
        onAuthAttempt?.(keyLabel);
        const pubkeyAuth = {
          type: "publickey",
          username,
          key: method.key,
        };
        if (method.passphrase) {
          pubkeyAuth.passphrase = method.passphrase;
        }
        return callback(pubkeyAuth);
      } else if (method.type === "password" && availableMethods.includes("password")) {
        console.log(`${logPrefix} Trying password auth`);
        lastAttemptedLabel = "password";
        onAuthAttempt?.("password");
        return callback({
          type: "password",
          username,
          password,
        });
      } else if (method.type === "keyboard-interactive" && availableMethods.includes("keyboard-interactive")) {
        lastAttemptedLabel = "keyboard-interactive";
        onAuthAttempt?.("keyboard-interactive");
        return callback("keyboard-interactive");
      }
    }
    onAuthAttempt?.("all methods exhausted");
    return callback(false);
  };

  // Determine the agent to return - if authMethods includes agent, we need to provide the socket
  // even if effectiveAgent is null (for fallback scenarios)
  const hasAgentInMethods = authMethods.some(m => m.type === "agent");
  const returnAgent = effectiveAgent || (hasAgentInMethods ? sshAgentSocket : null);

  return {
    authHandler,
    privateKey: effectivePrivateKey,
    agent: returnAgent,
    usedDefaultKeys: true,
  };
}

// OTP / MFA / token vocabulary. Matched FIRST — any hit here disqualifies the
// challenge from auto-fill even if it also contains a "password" keyword.
// Catches phrases like "One-time password", "动态密码", "动态口令",
// "一次性密码", "Verification code", "Duo passcode", "two-factor", etc.
// — all single-prompt shapes that look like password fields on the surface
// but actually want an OTP. Submitting the saved password into any of these
// burns an auth attempt and risks `pam_faillock` / `pam_tally2` lockout.
// (#969 PR review, second round.)
const OTP_PROMPT_PATTERN = new RegExp(
  [
    "one[\\s-]?time",
    "\\botp\\b",
    "verification",
    "passcode",
    "\\btoken\\b",
    "2fa",
    "two[\\s-]?factor",
    "multi[\\s-]?factor",
    "\\bmfa\\b",
    "second\\s+factor",
    "duo",
    // CJK — no word boundaries; substring match is intentional
    "动态",
    "一次性",
    "验证码",
    "验证信息",
    "令牌",
    "双因素",
    "多因素",
    "短信验证",
    "手机验证",
  ].join("|"),
  "i",
);

// Latin-script + CJK keywords for "this prompt is asking for a reusable
// password". Only consulted AFTER OTP_PROMPT_PATTERN clears, so phrases like
// "One-time password" or "动态密码" never reach this step.
//
// Custom-localized prompts that don't match these keywords fall through to
// the modal, which is the same behavior as before the auto-fill optimization
// — strictly no worse than the old "always prompt" baseline.
const PASSWORD_PROMPT_PATTERN = /passw(or)?d|密\s*码|口\s*令/i;

/**
 * Decide whether a keyboard-interactive challenge is "just a PAM-wrapped
 * password prompt" that we can answer with the saved host password without
 * bothering the user. PAM-based Linux servers commonly advertise only
 * `keyboard-interactive` (not `password`), so without this shortcut every
 * connection pops a second password dialog even when the host already has a
 * saved credential — see #969.
 *
 * Conservative criteria, matching OpenSSH and Tabby behavior:
 *   - exactly one prompt (multi-prompt is almost certainly real 2FA / MFA)
 *   - the prompt has `echo === false`
 *   - the prompt text does NOT contain any OTP / MFA vocabulary
 *   - the prompt text DOES contain a recognized password keyword (Latin
 *     "password" / "passwd", CJK "密码" / "口令")
 *   - we have a non-empty saved password
 *
 * Anything else falls through to the modal so the user can answer in person.
 */
function isAutoFillablePasswordChallenge(prompts, password) {
  if (typeof password !== "string" || password.length === 0) return false;
  if (!Array.isArray(prompts) || prompts.length !== 1) return false;
  const prompt = prompts[0];
  if (!prompt || prompt.echo !== false) return false;
  const promptText = typeof prompt.prompt === "string" ? prompt.prompt : "";
  if (OTP_PROMPT_PATTERN.test(promptText)) return false;
  return PASSWORD_PROMPT_PATTERN.test(promptText);
}

/**
 * Create a keyboard-interactive event handler
 * @param {Object} options
 * @param {Object} options.sender - Electron webContents sender
 * @param {string} options.sessionId - Session/connection ID
 * @param {string} options.hostname - Host being connected to
 * @param {string} [options.password] - Saved password; used both as the
 *   one-click fill button payload and as the auto-fill for the single-
 *   password-prompt fast path (#969).
 * @param {string} [options.logPrefix] - Log prefix for debugging
 * @param {Function} [options.onAutoFill] - Called when the saved password is
 *   auto-filled into the challenge (no modal shown). Lets callers emit a
 *   different progress message than the user-prompt flow.
 * @param {Function} [options.onPromptShown] - Called right before the modal
 *   IPC is sent to the renderer.
 * @param {Function} [options.onUserResponded] - Called when the renderer
 *   sends a response back (after the modal closed).
 * @returns {Function} - Event handler for 'keyboard-interactive' event
 */
function createKeyboardInteractiveHandler(options) {
  const {
    sender,
    sessionId,
    hostname,
    password,
    logPrefix = "[SSH]",
    onAutoFill,
    onPromptShown,
    onUserResponded,
  } = options;
  // ssh2 may re-invoke the keyboard-interactive event on auth failure with a
  // fresh challenge. If our first auto-fill attempt was wrong, falling back
  // to the modal on the retry lets the user correct it — and prevents a
  // tight loop where we keep submitting the same wrong password.
  let autoFilledOnce = false;

  return (name, instructions, instructionsLang, prompts, finish) => {
    console.log(`${logPrefix} ${hostname} keyboard-interactive auth requested`, {
      name,
      instructions,
      promptCount: prompts?.length || 0,
    });

    // If there are no prompts, just call finish with empty array
    if (!prompts || prompts.length === 0) {
      console.log(`${logPrefix} No prompts, finishing keyboard-interactive`);
      finish([]);
      return;
    }

    if (!autoFilledOnce && isAutoFillablePasswordChallenge(prompts, password)) {
      autoFilledOnce = true;
      console.log(`${logPrefix} Auto-filling saved password into single keyboard-interactive prompt`);
      try { onAutoFill?.(); } catch (err) { console.warn(`${logPrefix} onAutoFill callback threw`, err); }
      finish([password]);
      return;
    }

    // Forward prompts to user via IPC
    const requestId = keyboardInteractiveHandler.generateRequestId('ssh');
    keyboardInteractiveHandler.storeRequest(requestId, (userResponses) => {
      console.log(`${logPrefix} Received user responses, finishing keyboard-interactive`);
      try { onUserResponded?.(); } catch (err) { console.warn(`${logPrefix} onUserResponded callback threw`, err); }
      finish(userResponses);
    }, sender.id, sessionId);

    const promptsData = prompts.map((p) => ({
      prompt: p.prompt,
      echo: p.echo,
    }));

    console.log(`${logPrefix} Showing modal for ${promptsData.length} prompts`);
    try { onPromptShown?.(); } catch (err) { console.warn(`${logPrefix} onPromptShown callback threw`, err); }

    safeSend(sender, "netcatty:keyboard-interactive", {
      requestId,
      sessionId,
      name: name || hostname,
      instructions: instructions || "",
      prompts: promptsData,
      hostname: hostname,
      savedPassword: password || null,
    });
  };
}

const { safeSend } = require("./ipcUtils.cjs");

/**
 * Apply auth configuration to connection options
 * Convenience function that combines buildAuthHandler results with connOpts
 * @param {Object} connOpts - SSH connection options to modify
 * @param {Object} authConfig - Auth configuration from buildAuthHandler
 */
function applyAuthToConnOpts(connOpts, authConfig) {
  connOpts.authHandler = authConfig.authHandler;
  if (authConfig.privateKey) {
    connOpts.privateKey = authConfig.privateKey;
  }
  if (authConfig.agent) {
    connOpts.agent = authConfig.agent;
  }
}

/**
 * Request passphrases for encrypted default keys
 * Shows a modal for each encrypted key and collects passphrases
 * @param {Object} sender - Electron webContents sender
 * @param {string} [hostname] - Optional hostname for context
 * @returns {Promise<{ keys: Array<{ privateKey: string, keyPath: string, keyName: string, passphrase: string }>, cancelled: boolean }>}
 */
async function requestPassphrasesForEncryptedKeys(sender, hostname) {
  const allKeys = await findAllDefaultPrivateKeys({ includeEncrypted: true });
  const encryptedKeys = allKeys.filter(k => k.isEncrypted);

  if (encryptedKeys.length === 0) {
    return { keys: [], cancelled: false };
  }

  console.log(`[SSHAuth] Found ${encryptedKeys.length} encrypted default key(s), requesting passphrases`);

  const unlockedKeys = [];
  let wasCancelled = false;

  for (const keyInfo of encryptedKeys) {
    const result = await passphraseHandler.requestPassphrase(
      sender,
      keyInfo.keyPath,
      keyInfo.keyName,
      hostname
    );

    // Handle different response types
    if (!result) {
      // Timeout or error - continue with next key
      console.log(`[SSHAuth] No response for ${keyInfo.keyName}, continuing...`);
      continue;
    }

    if (result.cancelled) {
      // User clicked Cancel - stop the entire flow
      console.log(`[SSHAuth] User cancelled passphrase flow at ${keyInfo.keyName}`);
      wasCancelled = true;
      break;
    }

    if (result.skipped) {
      // User clicked Skip - continue with next key
      console.log(`[SSHAuth] User skipped passphrase for ${keyInfo.keyName}`);
      continue;
    }

    if (result.passphrase) {
      // User provided passphrase
      unlockedKeys.push({
        privateKey: keyInfo.privateKey,
        keyPath: keyInfo.keyPath,
        keyName: keyInfo.keyName,
        passphrase: result.passphrase,
      });
    }
  }

  return { keys: unlockedKeys, cancelled: wasCancelled };
}

module.exports = {
  PREFERRED_KEY_NAMES,
  SSH_KEY_PATTERN,
  looksLikePrivateKey,
  isKeyEncrypted,
  findDefaultPrivateKey,
  findAllDefaultPrivateKeys,
  getSshAgentSocket,
  getAvailableAgentSocket,
  buildAuthHandler,
  createKeyboardInteractiveHandler,
  isAutoFillablePasswordChallenge,
  applyAuthToConnOpts,
  safeSend,
  requestPassphrasesForEncryptedKeys,
  readFileNoFollow,
  expandIdentityFilePath,
  preparePrivateKeyForAuth,
  loadIdentityFileForAuth,
  loadFirstIdentityFileForAuth,
  PassphraseCancelledError,
  isPassphraseCancelledError,
};
