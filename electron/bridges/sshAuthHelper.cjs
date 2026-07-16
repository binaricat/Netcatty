/**
 * SSH Authentication Helper - Shared authentication logic for SSH connections
 * Used by sshBridge, sftpBridge, and portForwardingBridge
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { exec } = require("node:child_process");
const { utils: sshUtils } = require("ssh2");
const { prepareSystemSshAgent } = require("./systemSshAgent.cjs");
const keyboardInteractiveHandler = require("./keyboardInteractiveHandler.cjs");
const passphraseHandler = require("./passphraseHandler.cjs");
const {
  normalizePrivateKeyForSsh2,
  repairMalformedPem,
  PrivateKeyPassphraseError,
} = require("./privateKeyNormalizer.cjs");

// Default SSH key names in priority order
const PREFERRED_KEY_NAMES = ["id_ed25519", "id_ecdsa", "id_rsa"];
const SSH_KEY_PATTERN = /^id_[\w-]+$/;

function orderSshIdentityNames(names) {
  const uniqueNames = [...new Set(names)];
  const preferred = PREFERRED_KEY_NAMES.filter((name) => uniqueNames.includes(name));
  const rest = uniqueNames.filter((name) => !PREFERRED_KEY_NAMES.includes(name)).sort();
  return [...preferred, ...rest];
}

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
      // Repair mangled framing (lost or escaped newlines) first, so the cipher
      // name can be read from the base64 blob even when the key was flattened.
      const source = repairMalformedPem(keyContent) || keyContent;
      // Extract the base64 content between the markers
      const base64Match = source.match(
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

/**
 * Resolve a private key (and optional passphrase) into a form ssh2 can parse.
 * PKCS#8 keys, which ssh2 rejects, are transparently converted to a legacy PEM
 * (see privateKeyNormalizer.cjs).
 *
 * @returns {{ privateKey: string, passphrase: string|undefined } | null}
 *   The usable key, or null when the passphrase is wrong / the key can't be parsed.
 * @throws {UnsupportedPrivateKeyError} When a PKCS#8 key has no convertible legacy form.
 */
function resolveKeyForAuth(privateKey, passphrase) {
  let normalized;
  try {
    normalized = normalizePrivateKeyForSsh2(privateKey, passphrase);
  } catch (err) {
    if (err instanceof PrivateKeyPassphraseError) return null;
    throw err;
  }
  const parsed = sshUtils.parseKey(normalized.privateKey, normalized.passphrase);
  if (parsed && !(parsed instanceof Error)) {
    return { privateKey: normalized.privateKey, passphrase: normalized.passphrase };
  }
  return null;
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
  onPassphrasePromptShown,
  onPassphrasePromptResolved,
}) {
  if (!privateKey) return null;

  if (!isKeyEncrypted(privateKey)) {
    const resolved = resolveKeyForAuth(privateKey, undefined);
    return { privateKey: resolved ? resolved.privateKey : privateKey, keyPath, keyName };
  }

  const promptKeyPath = keyPath || `SSH key for ${keyName || hostname || "connection"}`;
  const promptKeyName = keyName || path.basename(promptKeyPath);
  let passphraseInvalid = false;

  if (initialPassphrase) {
    const resolved = resolveKeyForAuth(privateKey, initialPassphrase);
    if (resolved) {
      return { privateKey: resolved.privateKey, keyPath, keyName, passphrase: resolved.passphrase };
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
    onPassphrasePromptShown?.();
    const result = await passphraseHandler.requestPassphrase(
      sender,
      promptKeyPath,
      promptKeyName,
      hostname,
      passphraseInvalid,
      { signal: passphraseSignal }
    );
    onPassphrasePromptResolved?.();
    if (result?.cancelled) {
      throw new PassphraseCancelledError(promptKeyPath);
    }
    if (!result?.passphrase) {
      return null;
    }

    const resolved = resolveKeyForAuth(privateKey, result.passphrase);
    if (resolved) {
      return { privateKey: resolved.privateKey, keyPath, keyName, passphrase: resolved.passphrase };
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
  onPassphrasePromptShown,
  onPassphrasePromptResolved,
}) {
  const resolvedPath = expandIdentityFilePath(keyPath);
  const privateKey = await fs.promises.readFile(resolvedPath, "utf8");
  const keyName = path.basename(resolvedPath);

  if (!isKeyEncrypted(privateKey)) {
    const resolved = resolveKeyForAuth(privateKey, undefined);
    return { privateKey: resolved ? resolved.privateKey : privateKey, keyPath: resolvedPath, keyName };
  }

  let passphraseInvalid = false;
  if (initialPassphrase) {
    const resolved = resolveKeyForAuth(privateKey, initialPassphrase);
    if (resolved) {
      return { privateKey: resolved.privateKey, keyPath: resolvedPath, keyName, passphrase: resolved.passphrase };
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
    onPassphrasePromptShown?.();
    const result = await passphraseHandler.requestPassphrase(
      sender,
      resolvedPath,
      keyName,
      hostname,
      passphraseInvalid,
      { signal: passphraseSignal }
    );
    onPassphrasePromptResolved?.();
    if (result?.cancelled) {
      throw new PassphraseCancelledError(resolvedPath);
    }
    if (!result?.passphrase) {
      return null;
    }

    const resolved = resolveKeyForAuth(privateKey, result.passphrase);
    if (resolved) {
      return { privateKey: resolved.privateKey, keyPath: resolvedPath, keyName, passphrase: resolved.passphrase };
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
  onPassphrasePromptShown,
  onPassphrasePromptResolved,
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
        onPassphrasePromptShown,
        onPassphrasePromptResolved,
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
  const sorted = orderSshIdentityNames(allNames);

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
  const sorted = orderSshIdentityNames(allNames);

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

function isWindowsNamedPipe(agentPath) {
  return /^[/\\][/\\]\.[/\\]pipe[/\\].+/.test(agentPath);
}

function ssh2AgentConnectable(agentPath, options = {}) {
  const createAgentImpl = options.createAgentImpl || require("ssh2/lib/agent.js").createAgent;
  const timeoutMs = options.timeoutMs ?? 1000;
  return new Promise((resolve) => {
    let settled = false;
    let stream = null;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stream) {
        stream.removeAllListeners();
        stream.destroy();
      }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      createAgentImpl(agentPath).getStream((error, agentStream) => {
        if (settled) {
          agentStream?.destroy?.();
          return;
        }
        if (error || !agentStream) return finish(false);
        stream = agentStream;
        let response = Buffer.alloc(0);
        stream.on("data", (chunk) => {
          response = Buffer.concat([response, chunk]);
          if (response.length < 5) return;
          const payloadLength = response.readUInt32BE(0);
          if (payloadLength < 1 || payloadLength > 1024 * 1024) return finish(false);
          if (response.length < payloadLength + 4) return;
          finish(response[4] === 12 || response[4] === 5);
        });
        stream.once("error", () => finish(false));
        stream.once("end", () => finish(false));
        stream.once("close", () => finish(false));
        stream.write(Buffer.from([0, 0, 0, 1, 11]));
      });
    } catch {
      finish(false);
    }
  });
}

function cygwinAgentConnectable(agentPath, options = {}) {
  const timeoutMs = options.timeoutMs ?? 1000;
  const readFile = options.readFileImpl || require("node:fs").promises.readFile;
  const createConnection = options.createConnectionImpl || require("node:net").createConnection;
  const descriptorPattern = /^!<socket >(\d+) s ([A-Z0-9]{8}-[A-Z0-9]{8}-[A-Z0-9]{8}-[A-Z0-9]{8})/;
  const resolveCygwinPath = options.resolveCygwinPathImpl || ((value) => new Promise((resolve, reject) => {
    require("node:child_process").execFile(
      "cygpath",
      ["-w", value],
      { timeout: timeoutMs, windowsHide: true },
      (error, stdout) => {
        const converted = String(stdout || "").trim();
        if (error || !converted) reject(error || new Error("cygpath returned an empty path"));
        else resolve(converted);
      },
    );
  }));

  return new Promise((resolve) => {
    let settled = false;
    let activeSocket = null;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (activeSocket) {
        activeSocket.removeAllListeners();
        activeSocket.destroy();
      }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);

    const negotiate = (port, secret, credentials, keepOpen) => new Promise((resolveNegotiation, rejectNegotiation) => {
      const socket = activeSocket = createConnection({ host: "127.0.0.1", port });
      let state = "secret";
      let response = Buffer.alloc(0);
      const fail = (error) => {
        socket.removeAllListeners();
        socket.destroy();
        rejectNegotiation(error instanceof Error ? error : new Error("Cygwin agent negotiation failed"));
      };
      socket.once("connect", () => socket.write(secret));
      socket.once("error", fail);
      socket.once("end", () => fail(new Error("Cygwin agent ended during negotiation")));
      socket.once("close", () => fail(new Error("Cygwin agent closed during negotiation")));
      socket.on("data", (chunk) => {
        response = Buffer.concat([response, chunk]);
        const needed = state === "secret" ? 16 : 12;
        if (response.length < needed) return;
        const value = response.subarray(0, needed);
        response = response.subarray(needed);
        if (state === "secret") {
          state = "credentials";
          socket.write(credentials);
          return;
        }
        socket.removeAllListeners();
        if (!keepOpen) {
          socket.destroy();
          activeSocket = null;
        }
        resolveNegotiation({ credentials: value, socket: keepOpen ? socket : null, buffered: response });
      });
    });

    const readDescriptor = async () => {
      try {
        return await readFile(agentPath, "utf8");
      } catch {
        const convertedPath = await resolveCygwinPath(agentPath);
        return readFile(convertedPath, "utf8");
      }
    };

    readDescriptor().then(async (contents) => {
      if (settled) return;
      const match = descriptorPattern.exec(String(contents));
      if (!match) return finish(false);
      const port = Number(match[1]);
      const secret = Buffer.from(match[2].replace(/-/g, ""), "hex");
      for (let offset = 0; offset < secret.length; offset += 4) {
        secret.writeUInt32LE(secret.readUInt32BE(offset), offset);
      }
      try {
        const first = await negotiate(port, secret, Buffer.alloc(12), false);
        if (settled) return;
        const retryCredentials = Buffer.from(first.credentials);
        retryCredentials.writeUInt32LE(options.processId ?? process.pid, 0);
        const second = await negotiate(port, secret, retryCredentials, true);
        if (settled || !second.socket) return;
        activeSocket = second.socket;
        let response = second.buffered;
        const inspectResponse = () => {
          if (response.length < 5) return;
          const payloadLength = response.readUInt32BE(0);
          if (payloadLength < 1 || payloadLength > 1024 * 1024) return finish(false);
          if (response.length < payloadLength + 4) return;
          finish(response[4] === 12 || response[4] === 5);
        };
        activeSocket.on("data", (chunk) => {
          response = Buffer.concat([response, chunk]);
          inspectResponse();
        });
        activeSocket.once("error", () => finish(false));
        activeSocket.once("end", () => finish(false));
        activeSocket.once("close", () => finish(false));
        activeSocket.write(Buffer.from([0, 0, 0, 1, 11]));
        inspectResponse();
      } catch {
        finish(false);
      }
    }).catch(() => finish(false));
  });
}

function socketAgentConnectable(agentPath, options = {}) {
  const createConnection = options.createConnectionImpl || require("node:net").createConnection;
  const timeoutMs = options.timeoutMs ?? 1000;
  return new Promise((resolve) => {
    let settled = false;
    let socket = null;
    let response = Buffer.alloc(0);
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket) {
        socket.removeAllListeners();
        socket.destroy();
      }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      socket = createConnection(agentPath);
      socket.once("connect", () => {
        // SSH_AGENTC_REQUEST_IDENTITIES: uint32 payload length + byte 11.
        socket.write(Buffer.from([0, 0, 0, 1, 11]));
      });
      socket.on("data", (chunk) => {
        response = Buffer.concat([response, chunk]);
        if (response.length < 5) return;
        const payloadLength = response.readUInt32BE(0);
        if (payloadLength < 1 || payloadLength > 1024 * 1024) return finish(false);
        if (response.length < payloadLength + 4) return;
        const responseType = response[4];
        // SSH_AGENT_IDENTITIES_ANSWER (12), or SSH_AGENT_FAILURE (5).
        finish(responseType === 12 || responseType === 5);
      });
      socket.once("error", () => finish(false));
      socket.once("end", () => finish(false));
      socket.once("close", () => finish(false));
    } catch {
      finish(false);
    }
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
function resolveIdentityAgentPath(rawPath, context = {}) {
  if (typeof rawPath !== "string" || rawPath.trim() === "") return null;
  const value = rawPath.trim().replace(/^["']|["']$/g, "");
  if (value.toLowerCase() === "none") return null;
  if (value === "SSH_AUTH_SOCK") return process.env.SSH_AUTH_SOCK || null;
  const localHostname = context.localHostname || os.hostname();
  const hostname = context.hostname || "";
  const port = String(context.port || 22);
  const username = context.username || "";
  const proxyJump = context.proxyJump || "";
  const tokenValues = {
    "%": "%",
    d: os.homedir(),
    h: hostname,
    i: String(context.uid ?? (typeof process.getuid === "function" ? process.getuid() : "")),
    j: proxyJump,
    k: context.hostKeyAlias || hostname,
    L: context.shortLocalHostname || localHostname.split(".")[0],
    l: localHostname,
    n: context.originalHostname || hostname,
    p: port,
    r: username,
    u: context.localUsername || os.userInfo().username,
  };
  tokenValues.C = createHash("sha1")
    .update(`${localHostname}${hostname}${port}${username}${proxyJump}`)
    .digest("hex");
  const expanded = value
    .replace(/%([%CdhijkLlnpru])/g, (match, token) => tokenValues[token] ?? match)
    .replace(/^~(?=$|[\\/])/, os.homedir())
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name) => process.env[name] ?? "")
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name) => process.env[name] ?? "");
  return expanded || null;
}

function getSshAgentSocket(identityAgent, context = {}) {
  const configuredSocket = resolveIdentityAgentPath(identityAgent, context);
  if (identityAgent && !configuredSocket) return null;
  if (process.platform === "win32") {
    // On Windows, always return the pipe path; the caller should use
    // getAvailableAgentSocket() for a reliable async check.
    return configuredSocket || WIN_SSH_AGENT_PIPE;
  }
  const agentSocket = configuredSocket || process.env.SSH_AUTH_SOCK;
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
async function getAvailableAgentSocket(identityAgent, injected = {}) {
  const configuredSocket = resolveIdentityAgentPath(identityAgent, injected);
  if (identityAgent && !configuredSocket) return null;
  const platform = injected.platform || process.platform;
  if (platform === "win32") {
    const socketPath = configuredSocket || WIN_SSH_AGENT_PIPE;
    const running = isWindowsNamedPipe(socketPath)
      ? await (injected.windowsPipeConnectable || windowsPipeConnectable)(socketPath)
      : socketPath === "pageant"
        ? await (injected.ssh2AgentConnectable || ssh2AgentConnectable)(socketPath)
        : await (injected.cygwinAgentConnectable || cygwinAgentConnectable)(socketPath);
    return running ? socketPath : null;
  }
  const socketPath = getSshAgentSocket(configuredSocket, injected);
  if (!socketPath) return null;
  const running = await (injected.socketAgentConnectable || socketAgentConnectable)(socketPath);
  return running ? socketPath : null;
}

async function getNativeOpenSshAgentSocket(identityAgent, injected = {}) {
  const socketPath = await getAvailableAgentSocket(identityAgent, injected);
  const platform = injected.platform || process.platform;
  if (platform === "win32" && socketPath && !isWindowsNamedPipe(socketPath)) {
    const error = new Error(
      "This SSH agent is available only to Netcatty's built-in SSH client. Mosh and EternalTerminal require a Windows named-pipe agent.",
    );
    error.code = "ERR_SSH_AGENT_NATIVE_UNSUPPORTED";
    throw error;
  }
  return socketPath;
}

async function prepareSystemSshAgentForAuth(options, logPrefix = "[SSHAuth]") {
  if (options?.useSshAgent !== true) return null;
  const socketPath = await getAvailableAgentSocket(options.identityAgent, {
    hostname: options.hostname,
    port: options.port,
    username: options.username,
  });
  if (!socketPath) {
    const error = new Error("System SSH agent is unavailable. Start or unlock it, or configure a valid agent socket.");
    error.code = "ERR_SSH_AGENT_UNAVAILABLE";
    throw error;
  }
  return prepareSystemSshAgent({
    socketPath,
    identityFilePaths: options.identityFilePaths,
    identitiesOnly: options.identitiesOnly,
    addKeysToAgent: options.addKeysToAgent,
    useKeychain: options.useKeychain,
    agentPublicKeys: options.agentPublicKeys,
    hostname: options.hostname,
    port: options.port,
    username: options.username,
  }, {
    log: (message, details) => console.log(`${logPrefix} ${message}`, details ?? ""),
  });
}

/**
 * True when the session options carry an explicit user key choice — either
 * inline private key material or identity file paths from a Keychain reference
 * key (issue #1614).
 * @param {Object} options
 * @param {string} [options.privateKey]
 * @param {string[]} [options.identityFilePaths]
 * @returns {boolean}
 */
function hasUserConfiguredKey(options) {
  if (typeof options?.privateKey === "string" && options.privateKey.trim().length > 0) {
    return true;
  }
  return Array.isArray(options?.identityFilePaths) && options.identityFilePaths.length > 0;
}

/**
 * True when a password string should be attached to SSH connect options.
 * Whitespace-only passwords are valid SSH secrets (issue #2036) — do not trim.
 * @param {unknown} password
 * @returns {boolean}
 */
function isPasswordProvided(password) {
  return typeof password === "string" && password.length > 0;
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
/**
 * Append the SSH password method (always password-first).
 * Keyboard-interactive is added separately as last-resort fallback so dual-
 * method servers still reach multi-round PAM/EDR after password fails or only
 * partially succeeds (#2150 / #2217).
 *
 * skipPasswordMethod (2FA_RETRY): omit the password method so the full
 * conversation happens over keyboard-interactive; the saved host password can
 * still autofill the first password-looking KI prompt.
 *
 * @param {Array} authMethods
 * @param {{ hasPassword: boolean, skipPasswordMethod?: boolean, asObjects?: boolean }} opts
 */
function appendPasswordAuthMethods(authMethods, { hasPassword, skipPasswordMethod = false, asObjects = false } = {}) {
  if (!hasPassword || skipPasswordMethod) return;
  if (asObjects) {
    authMethods.push({ type: "password", id: "password" });
  } else {
    authMethods.push("password");
  }
}

function ensureKeyboardInteractiveMethod(authMethods, { asObjects = false } = {}) {
  if (asObjects) {
    if (!authMethods.some((method) => method.type === "keyboard-interactive")) {
      authMethods.push({ type: "keyboard-interactive", id: "keyboard-interactive" });
    }
    return;
  }
  if (!authMethods.includes("keyboard-interactive")) {
    authMethods.push("keyboard-interactive");
  }
}

function buildAuthHandler(options) {
  const {
    privateKey,
    password,
    passphrase,
    agent,
    username,
    logPrefix = "[SSH]",
    unlockedEncryptedKeys = [],
    defaultKeys = [],
    sshAgentSocketOverride,
    onAuthAttempt,
    skipPasswordMethod = false,
  } = options;

  // Determine what type of explicit auth the user configured
  const hasExplicitKey = !!privateKey;
  const hasExplicitPassword = !!password;
  const hasExplicitAgent = !!agent;
  const hasExplicitAuth = hasExplicitKey || hasExplicitPassword || hasExplicitAgent;
  const isAutomatic = options.authMethod === "auto";
  const isExplicitPasswordMode = options.authMethod === "password";
  const isSelectedKeyMode = options.authMethod === "key" || options.authMethod === "certificate";
  const eligibleUnlockedEncryptedKeys = isExplicitPasswordMode || isSelectedKeyMode
    ? []
    : unlockedEncryptedKeys;

  // Determine if this is a password-only or key-only connection
  const isPasswordOnly = isExplicitPasswordMode
    || (!isAutomatic && hasExplicitPassword && !hasExplicitKey && !hasExplicitAgent);
  const isKeyOnly = !isPasswordOnly && hasExplicitKey && !hasExplicitAgent;
  const allowAgentFallback = options.allowAgentFallback !== false
    && !isPasswordOnly
    && !isSelectedKeyMode;

  // Allow callers to pass in a pre-validated agent socket (e.g. from async
  // getAvailableAgentSocket). Fall back to synchronous getSshAgentSocket()
  // which on Windows always returns the pipe path without checking the service.
  const sshAgentSocket = allowAgentFallback
    ? (sshAgentSocketOverride !== undefined ? sshAgentSocketOverride : getSshAgentSocket())
    : null;

  // Only use system ssh-agent BEFORE user's auth when:
  // - User explicitly configured agent, OR
  // - No explicit auth is configured (pure fallback mode)
  // When user configured key/password, system agent should only be used AFTER as fallback
  const useAgentFirst = hasExplicitAgent || isAutomatic || !hasExplicitAuth;

  // Determine effective agent
  const effectiveAgent = isPasswordOnly ? null : agent || (useAgentFirst ? sshAgentSocket : null);

  // Determine effective privateKey (user-provided takes priority). Explicit
  // key/certificate selection must fail closed when the selected material is
  // unavailable instead of silently substituting an unrelated default key.
  const mayUseDefaultKeyAsPrimary = isAutomatic || (!isSelectedKeyMode && !hasExplicitAuth);
  const effectivePrivateKey = isPasswordOnly
    ? null
    : privateKey || (mayUseDefaultKeyAsPrimary && defaultKeys.length > 0 ? defaultKeys[0].privateKey : null);

  // Determine fallback keys (keys to try after user's primary auth fails)
  // - If user provided a key: all default keys are fallbacks
  // - If no explicit auth: first default key is primary, rest are fallbacks
  // - If password-only: no default-key fallback (issue #266 / #2079)
  // - If agent-only: all default keys are fallbacks (tried after primary)
  const fallbackKeys = isPasswordOnly || isSelectedKeyMode
    ? []
    : isAutomatic
      ? defaultKeys
    : hasExplicitKey
      ? defaultKeys
      : !hasExplicitAuth
        ? defaultKeys.slice(1)
        : defaultKeys;

  // Check if we need dynamic handler (have fallback options).
  // Password-only never treats default keys as fallbacks — only unlocked
  // encrypted keys (jump-chain retry) and keyboard-interactive remain.
  // Callers that pass onAuthAttempt still get progress callbacks on the
  // simple ordered path (createOrderedStringAuthHandler) so jump/SFTP UIs
  // keep showing auth attempts after #2079 (Codex review P2).
  const hasFallbackOptions = fallbackKeys.length > 0 ||
    (!hasExplicitAgent && !isPasswordOnly && sshAgentSocket) ||
    eligibleUnlockedEncryptedKeys.length > 0;

  // Simple explicit auth with no fallback keys: preserve the old ordered
  // method list, but use a function handler so we can observe partialSuccess
  // for second-factor keyboard-interactive (#2150). Plain string arrays hide
  // that signal from us and leave authPhase stuck at false.
  if (hasExplicitAuth && !hasFallbackOptions) {
    const authMethods = ["none"]; // Always try none first per RFC 4252
    if (effectiveAgent) authMethods.push("agent");
    if (!isPasswordOnly && privateKey) authMethods.push("publickey");
    appendPasswordAuthMethods(authMethods, {
      hasPassword: !!password,
      skipPasswordMethod,
      asObjects: false,
    });
    ensureKeyboardInteractiveMethod(authMethods, { asObjects: false });

    const authPhase = createAuthPhase();
    return {
      authHandler: createOrderedStringAuthHandler(authMethods, authPhase, onAuthAttempt),
      privateKey: effectivePrivateKey,
      agent: effectiveAgent,
      usedDefaultKeys: false,
      authPhase,
    };
  }

  // Build comprehensive authMethods array with all auth options
  // Order depends on what user explicitly configured:
  // - Password-only: password -> keyboard-interactive (no default-key fallback)
    // - Key-only: user key -> password -> agent -> default keys -> keyboard-interactive
  // - Agent configured: agent -> user key -> password -> default keys -> keyboard-interactive
  // - No explicit auth: agent -> default keys -> keyboard-interactive
  const authMethods = [];

  if (isPasswordOnly) {
    // Password-only: respect user's explicit choice, no key/agent fallback.
    // Matches startSSHSession (issue #2079) and avoids #266 passphrase prompts.
    appendPasswordAuthMethods(authMethods, {
      hasPassword: !!password,
      skipPasswordMethod,
      asObjects: true,
    });
  } else if (isAutomatic) {
    // Automatic: mirror the familiar OpenSSH-style order. Try local key
    // sources first, then use a saved password as the final non-interactive
    // fallback before keyboard-interactive prompts.
    if (effectiveAgent) {
      authMethods.push({ type: "agent", id: "agent" });
    }
    if (privateKey) {
      authMethods.push({
        type: "publickey",
        key: privateKey,
        passphrase,
        id: "publickey-user"
      });
    }
    for (const keyInfo of fallbackKeys) {
      authMethods.push({
        type: "publickey",
        key: keyInfo.privateKey,
        id: `publickey-default-${keyInfo.keyName}`
      });
    }
    appendPasswordAuthMethods(authMethods, {
      hasPassword: !!password,
      skipPasswordMethod,
      asObjects: true,
    });
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
    appendPasswordAuthMethods(authMethods, {
      hasPassword: !!password,
      skipPasswordMethod,
      asObjects: true,
    });

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
    appendPasswordAuthMethods(authMethods, {
      hasPassword: !!password,
      skipPasswordMethod,
      asObjects: true,
    });

    // 4. Default keys as fallback
    for (const keyInfo of fallbackKeys) {
      authMethods.push({
        type: "publickey",
        key: keyInfo.privateKey,
        id: `publickey-default-${keyInfo.keyName}`
      });
    }

    // 5. If no user key provided, add first default key at the beginning (after agent)
    if (!isSelectedKeyMode && !privateKey && defaultKeys.length > 0) {
      const insertIndex = effectiveAgent ? 1 : 0;
      authMethods.splice(insertIndex, 0, {
        type: "publickey",
        key: defaultKeys[0].privateKey,
        id: `publickey-default-${defaultKeys[0].keyName}`
      });
    }
  }

  // Add unlocked encrypted default keys (user provided passphrases for these)
  for (const keyInfo of eligibleUnlockedEncryptedKeys) {
    authMethods.push({
      type: "publickey",
      key: keyInfo.privateKey,
      passphrase: keyInfo.passphrase,
      id: `publickey-encrypted-${keyInfo.keyName}`
    });
  }

  // Keyboard-interactive as last-resort fallback for PAM/EDR multi-round auth.
  ensureKeyboardInteractiveMethod(authMethods, { asObjects: true });

  console.log(`${logPrefix} Auth methods configured`, {
    isAutomatic,
    isPasswordOnly,
    hasUserKey: !!privateKey,
    hasPassword: !!password,
    hasAgent: !!effectiveAgent,
    skipPasswordMethod: !!skipPasswordMethod,
    methodCount: authMethods.length,
    methods: authMethods.map(m => m.id),
  });

  // Use dynamic authHandler to try all keys
  let lastAttemptedLabel = null;
  const attemptedMethodIds = new Set();
  const succeededMethodIds = new Set();
  const failedMethodIds = new Set();
  // Shared with keyboard-interactive auto-fill. See createAuthPhase /
  // shouldSkipKiPasswordAutoFill — a completed password or keyboard-
  // interactive factor suppresses reusing the saved host password on a later
  // KI challenge (#2150 / #2151).
  const authPhase = createAuthPhase();
  let lastAttemptedType = null;
  let lastAttemptedMethodId = null;

  let triedNone = false;

  const authHandler = (methodsLeft, partialSuccess, callback) => {
    // Per RFC 4252, always try "none" first to discover available methods
    // and to support passwordless login (e.g. embedded devices).
    // This matches the behavior of OpenSSH and Tabby.
    if (methodsLeft === null && !triedNone) {
      triedNone = true;
      lastAttemptedLabel = "none (no credentials)";
      lastAttemptedType = "none";
      lastAttemptedMethodId = null;
      onAuthAttempt?.("none (no credentials)");
      return callback("none");
    }

    const availableMethods = methodsLeft || ["publickey", "password", "keyboard-interactive", "agent"];

    // Log rejection of previous method (authHandler is called again when server rejects)
    if (lastAttemptedLabel && !partialSuccess) {
      onAuthAttempt?.(`${lastAttemptedLabel} rejected`);
      if (lastAttemptedMethodId) {
        failedMethodIds.add(lastAttemptedMethodId);
      }
    }

    if (partialSuccess) {
      markAuthPhasePartialSuccess(authPhase, lastAttemptedType);
      if (lastAttemptedMethodId) {
        succeededMethodIds.add(lastAttemptedMethodId);
      }
      // Start a fresh pass for the next factor. Methods merely unavailable in
      // the previous phase become eligible again, while methods actually
      // rejected or already successful stay suppressed.
      attemptedMethodIds.clear();
      for (const methodId of failedMethodIds) {
        attemptedMethodIds.add(methodId);
      }
      for (const methodId of succeededMethodIds) {
        attemptedMethodIds.add(methodId);
      }
      // Some PAM/EDR stacks model login-password + secondary-password as two
      // consecutive keyboard-interactive authentication factors. The server
      // reports the first factor as partial success and advertises the same
      // method again for the second factor. Unlike a key, keyboard-interactive
      // is safe to repeat because the server supplies a fresh challenge and
      // createKeyboardInteractiveHandler refuses to auto-fill after round one.
      if (
        Array.isArray(methodsLeft) &&
        methodsLeft.includes("keyboard-interactive") &&
        canRepeatKeyboardInteractive(authPhase, failedMethodIds)
      ) {
        attemptedMethodIds.delete("keyboard-interactive");
      }
    }

    // After any successful factor, prefer keyboard-interactive for the next
    // factor when the server still advertises it. Password-first remains for
    // the first factor; this is automatic KI fallback without a host switch.
    if (
      authPhase.hadPartialSuccess
      && availableMethods.includes("keyboard-interactive")
      && !attemptedMethodIds.has("keyboard-interactive")
    ) {
      const kiMethod = authMethods.find((method) => method.type === "keyboard-interactive");
      if (kiMethod) {
        attemptedMethodIds.add(kiMethod.id);
        lastAttemptedLabel = "keyboard-interactive";
        lastAttemptedType = "keyboard-interactive";
        lastAttemptedMethodId = kiMethod.id;
        onAuthAttempt?.("keyboard-interactive");
        return callback("keyboard-interactive");
      }
    }

    for (const method of authMethods) {
      if (attemptedMethodIds.has(method.id)) continue;

      if (method.type === "agent" && (availableMethods.includes("publickey") || availableMethods.includes("agent"))) {
        attemptedMethodIds.add(method.id);
        console.log(`${logPrefix} Trying agent auth`);
        lastAttemptedLabel = "SSH agent";
        lastAttemptedType = "agent";
        lastAttemptedMethodId = method.id;
        onAuthAttempt?.("SSH agent");
        return callback("agent");
      } else if (method.type === "publickey" && availableMethods.includes("publickey")) {
        attemptedMethodIds.add(method.id);
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
        lastAttemptedType = "publickey";
        lastAttemptedMethodId = method.id;
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
        attemptedMethodIds.add(method.id);
        console.log(`${logPrefix} Trying password auth`);
        lastAttemptedLabel = "password";
        lastAttemptedType = "password";
        lastAttemptedMethodId = method.id;
        onAuthAttempt?.("password");
        return callback({
          type: "password",
          username,
          password,
        });
      } else if (method.type === "keyboard-interactive" && availableMethods.includes("keyboard-interactive")) {
        attemptedMethodIds.add(method.id);
        lastAttemptedLabel = "keyboard-interactive";
        lastAttemptedType = "keyboard-interactive";
        lastAttemptedMethodId = method.id;
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
    authPhase,
  };
}

// OTP / MFA / step-up vocabulary. Matched FIRST — any hit here disqualifies
// the challenge from auto-fill even if it also contains a "password" keyword.
// Catches phrases like "One-time password", "动态密码", "动态口令",
// "一次性密码", "Verification code", "Duo passcode", "two-factor", and
// EDR/secondary-password prompts like "二次密码" / "Secondary password"
// (issue #2150). Submitting the saved login password into any of these
// burns an auth attempt and often disconnects without re-prompting.
// (#969 PR review, second round; #2150.)
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
    // Step-up / secondary password (login password already used as first factor).
    // Allow a few words between "secondary" and "password" so prompts like
    // "Secondary Authentication Password:" (common EDR English label) match.
    "secondary(?:\\s+\\w+){0,3}\\s+passw",
    "second(?:\\s+\\w+){0,3}\\s+passw",
    "additional(?:\\s+\\w+){0,3}\\s+passw",
    "re[-\\s]?enter\\s+passw",
    "confirm\\s+passw",
    "\\bedr\\b",
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
    // Corporate EDR / bastion second-factor password prompts (#2150)
    // Covers "二次密码", "二次认证密码", "二次验证", etc.
    "二次",
    "安全密码",
    "挑战码",
  ].join("|"),
  "i",
);

// Narrower than OTP_PROMPT_PATTERN: used only for suggesting host-level MFA.
// Password-change words such as "confirm password" still block auto-fill via
// OTP_PROMPT_PATTERN, but they must not make a normal host become MFA-first.
const MFA_SUGGESTION_PROMPT_PATTERN = new RegExp(
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
    "secondary(?:\\s+\\w+){0,3}\\s+passw",
    "second(?:\\s+\\w+){0,3}\\s+passw",
    "additional(?:\\s+\\w+){0,3}\\s+passw",
    "\\bedr\\b",
    "duo",
    "动态",
    "一次性",
    "验证码",
    "验证信息",
    "令牌",
    "双因素",
    "多因素",
    "短信验证",
    "手机验证",
    "二次",
    "安全密码",
    "挑战码",
  ].join("|"),
  "i",
);

// Password-expiry / password-change keyboard-interactive forms are not MFA.
const PASSWORD_CHANGE_PROMPT_PATTERN =
  /\b(?:current|old|new)\s+(?:unix\s+)?passw|confirm\s+(?:new\s+)?passw|re[-\s]?enter\s+(?:new\s+)?passw/i;

// Latin-script + CJK keywords for "this prompt is asking for a reusable
// password". Only consulted AFTER OTP_PROMPT_PATTERN clears, so phrases like
// "One-time password", "动态密码", or "二次密码" never reach this step.
//
// Custom-localized prompts that don't match these keywords fall through to
// the modal, which is the same behavior as before the auto-fill optimization
// — strictly no worse than the old "always prompt" baseline.
const PASSWORD_PROMPT_PATTERN = /passw(or)?d|密\s*码|口\s*令/i;
const MAX_KEYBOARD_INTERACTIVE_FACTORS = 2;
const EDR_SECONDARY_AUTH_FALLBACK_INSTRUCTIONS =
  "为保障主机安全，请输入二次认证密码，如有疑问，请联系xxx，电话xxx。";

/**
 * Shared auth-phase state for keyboard-interactive auto-fill decisions.
 * passwordAlreadySucceeded means the password method already contributed a
 * successful factor. keyboardInteractiveSuccessCount remembers completed KI
 * factors, so a later KI challenge is treated as distinct even when another
 * factor ran between them. Neither value changes for publickey/agent alone,
 * preserving publickey+password MFA auto-fill.
 */
function createAuthPhase() {
  return {
    hadPartialSuccess: false,
    passwordAlreadySucceeded: false,
    keyboardInteractiveSuccessCount: 0,
    retryKeyboardInteractiveFirst: false,
  };
}

/**
 * Record a partialSuccess against authPhase. Pass the method type that just
 * succeeded (e.g. "password", "publickey", "agent", or
 * "keyboard-interactive").
 */
function markAuthPhasePartialSuccess(authPhase, succeededMethodType) {
  if (!authPhase) return;
  authPhase.hadPartialSuccess = true;
  if (succeededMethodType === "password") {
    authPhase.passwordAlreadySucceeded = true;
  }
  if (succeededMethodType === "keyboard-interactive") {
    authPhase.keyboardInteractiveSuccessCount =
      (authPhase.keyboardInteractiveSuccessCount || 0) + 1;
  }
}

/**
 * Allow at most one repeated keyboard-interactive factor. Two completed KI
 * factors cover login-password + secondary-password flows while preventing a
 * broken or malicious server from keeping the client in an unbounded loop.
 * Once an interactive factor is rejected, it must not be revived by a later
 * partial success from another method.
 * @param {Object} authPhase
 * @param {Set<string>} [failedMethodIds]
 */
function canRepeatKeyboardInteractive(authPhase, failedMethodIds) {
  if (!authPhase) return false;
  if (failedMethodIds?.has("keyboard-interactive")) return false;
  return (authPhase.keyboardInteractiveSuccessCount || 0) ===
    MAX_KEYBOARD_INTERACTIVE_FACTORS - 1;
}

/**
 * Whether keyboard-interactive should refuse to auto-fill / prefill the saved
 * host password. A completed password or keyboard-interactive factor means a
 * later KI challenge is a distinct factor. publickey→Password: MFA still
 * returns false so the saved login password can be used there.
 */
function shouldSkipKiPasswordAutoFill(authPhase) {
  return Boolean(
    authPhase &&
    (
      authPhase.passwordAlreadySucceeded ||
      (authPhase.keyboardInteractiveSuccessCount || 0) > 0
    )
  );
}

/**
 * Wrap a simple ordered list of ssh2 auth method *strings* (the form used by
 * `connectOpts.authHandler = ["none","password","keyboard-interactive"]`)
 * so callers can observe `partialSuccess` for multi-factor flows (#2150).
 *
 * Behavior mirrors ssh2's array handler, with one important difference from a
 * naive index cursor: methods that are merely *unavailable on this call*
 * (not in `methodsLeft`) are NOT permanently consumed. That matters when a
 * server first advertises only `publickey`, then after a partial-success key
 * re-advertises `password` — advancing past password on the first pass would
 * leave the connection unable to offer the second factor (Codex P2 on #2151).
 *
 * @param {string[]} order
 * @param {{ hadPartialSuccess: boolean, passwordAlreadySucceeded?: boolean, keyboardInteractiveSuccessCount?: number }} authPhase
 * @param {(label: string) => void} [onAuthAttempt] - optional progress callback
 *   (jump/SFTP connection logs). Mirrors the dynamic authHandler's onAuthAttempt.
 * @returns {(methodsLeft: string[]|null, partialSuccess: boolean, callback: Function) => void}
 */
function createOrderedStringAuthHandler(order, authPhase, onAuthAttempt) {
  // Methods we actually offered (server got a chance to accept/reject).
  let attempted = new Set();
  // Methods that contributed a successful factor; never retried.
  const succeeded = new Set();
  // Methods actually rejected by the server. Methods that were merely absent
  // from an earlier methodsLeft list are intentionally not recorded here.
  const failed = new Set();
  let lastOffered = null;
  let passwordAttemptSawKeyboardInteractive = false;

  const attemptLabel = (method) => {
    if (method === "none") return "none (no credentials)";
    if (method === "agent") return "SSH agent";
    return method;
  };

  return (methodsLeft, partialSuccess, callback) => {
    if (partialSuccess) {
      markAuthPhasePartialSuccess(authPhase, lastOffered);
      if (lastOffered) succeeded.add(lastOffered);
      // Reconsider methods that were unavailable in the previous factor, but
      // do not resubmit credentials the server already rejected or accepted.
      attempted = new Set([...failed, ...succeeded]);
      // A server may deliberately require keyboard-interactive more than once
      // (for example PAM login password followed by an EDR secondary password).
      // Re-offer it only when the server explicitly advertises it for the next
      // factor. Failed attempts still remain blocked on non-partial callbacks.
      if (
        Array.isArray(methodsLeft) &&
        methodsLeft.includes("keyboard-interactive") &&
        canRepeatKeyboardInteractive(authPhase, failed)
      ) {
        attempted.delete("keyboard-interactive");
      }
    } else if (lastOffered && methodsLeft !== null) {
      // Server rejected the previous method (or finished a failed factor).
      // Skip the initial methodsLeft===null probe which is not a rejection.
      onAuthAttempt?.(`${attemptLabel(lastOffered)} rejected`);
      if (
        lastOffered === "password" &&
        passwordAttemptSawKeyboardInteractive &&
        Array.isArray(methodsLeft) &&
        !methodsLeft.includes("keyboard-interactive")
      ) {
        authPhase.retryKeyboardInteractiveFirst = true;
      }
      failed.add(lastOffered);
    }

    const available = Array.isArray(methodsLeft) && methodsLeft.length > 0
      ? methodsLeft
      : null;

    // After a successful factor, prefer keyboard-interactive when the server
    // still allows it (automatic KI fallback; no host MFA switch required).
    if (
      authPhase.hadPartialSuccess
      && order.includes("keyboard-interactive")
      && !attempted.has("keyboard-interactive")
      && (!available || available.includes("keyboard-interactive"))
    ) {
      attempted.add("keyboard-interactive");
      lastOffered = "keyboard-interactive";
      onAuthAttempt?.(attemptLabel("keyboard-interactive"));
      return callback("keyboard-interactive");
    }

    for (const method of order) {
      if (attempted.has(method)) continue;
      if (available) {
        const allowed =
          available.includes(method) ||
          (method === "agent" && available.includes("publickey"));
        // Not advertised right now — leave it eligible for a later phase.
        if (!allowed) continue;
      }
      attempted.add(method);
      lastOffered = method;
      if (method === "password") {
        passwordAttemptSawKeyboardInteractive = Boolean(
          available && available.includes("keyboard-interactive"),
        );
      }
      onAuthAttempt?.(attemptLabel(method));
      return callback(method);
    }
    onAuthAttempt?.("all methods exhausted");
    return callback(false);
  };
}

/**
 * Decide whether a keyboard-interactive challenge is "just a PAM-wrapped
 * password prompt" that we can answer with the saved host password without
 * bothering the user. PAM-based Linux servers commonly advertise only
 * `keyboard-interactive` (not `password`), so without this shortcut every
 * connection pops a second password dialog even when the host already has a
 * saved credential — see #969.
 *
 * Conservative criteria:
 *   - exactly one prompt (multi-prompt is almost certainly real 2FA / MFA)
 *   - the prompt has `echo === false`
 *   - the prompt text + optional name/instructions do NOT contain any OTP /
 *     MFA / secondary-password vocabulary (EDR often puts the Chinese
 *     "二次认证密码" wording in instructions and only "Secondary
 *     Authentication Password:" in the prompt field — see #2150)
 *   - the prompt text DOES contain a recognized password keyword (Latin
 *     "password" / "passwd", CJK "密码" / "口令")
 *   - we have a non-empty saved password
 *
 * Anything else falls through to the modal so the user can answer in person.
 *
 * @param {Array} prompts
 * @param {string} password
 * @param {string} [contextText] - name + instructions from the KI challenge
 */
function isAutoFillablePasswordChallenge(prompts, password, contextText = "") {
  if (typeof password !== "string" || password.length === 0) return false;
  if (!Array.isArray(prompts) || prompts.length !== 1) return false;
  const prompt = prompts[0];
  if (!prompt || prompt.echo !== false) return false;
  const promptText = typeof prompt.prompt === "string" ? prompt.prompt : "";
  // Scan prompt + name/instructions together so secondary-password wording
  // that only appears in the instruction banner still blocks auto-fill.
  const haystack = [contextText, promptText].filter(Boolean).join("\n");
  if (OTP_PROMPT_PATTERN.test(haystack)) return false;
  return PASSWORD_PROMPT_PATTERN.test(promptText);
}

/**
 * Whether the modal may pre-fill / offer-to-save the host login password for
 * this challenge. Single secondary/EDR prompts and post-partialSuccess
 * challenges must open empty (#2150). Multi-prompt forms (password + OTP)
 * still get the saved value as a convenience for the password slot.
 *
 * @param {Array} prompts
 * @param {string} password
 * @param {{ skipAutoFill?: boolean, contextText?: string }} [opts]
 */
function shouldPrefillSavedPassword(prompts, password, { skipAutoFill = false, contextText = "" } = {}) {
  if (skipAutoFill) return false;
  if (typeof password !== "string" || password.length === 0) return false;
  if (!Array.isArray(prompts) || prompts.length === 0) return false;
  // Single-prompt: only prefill classic first-factor password challenges.
  // Secondary/OTP wording in name/instructions still blocks via contextText.
  if (prompts.length === 1) {
    return isAutoFillablePasswordChallenge(prompts, password, contextText);
  }
  // Multi-prompt (e.g. Password: + Verification code: / Duo): always prefill
  // the password slot when we have a saved host password. Challenge names like
  // "Duo two-factor" must NOT suppress prefill — skipAutoFill already covers
  // true post-partialSuccess second-factor rounds (Codex P3 on #2151).
  // The modal only writes into isAPasswordPrompt fields, not OTP slots.
  return true;
}

function getFallbackKeyboardInteractiveInstructions(prompts) {
  if (!Array.isArray(prompts) || prompts.length !== 1) return "";
  const prompt = typeof prompts[0]?.prompt === "string" ? prompts[0].prompt : "";
  return /secondary\s+authentication\s+password/i.test(prompt)
    ? EDR_SECONDARY_AUTH_FALLBACK_INSTRUCTIONS
    : "";
}

/**
 * Whether a keyboard-interactive challenge looks like a secondary / EDR /
 * OTP factor (not the ordinary first-factor host password). Used for modal
 * copy and optional "enable MFA mode on this host" suggestions.
 */
function looksLikeSecondaryAuthChallenge(name, instructions, prompts, extraContext = "") {
  const parts = [name, instructions, extraContext];
  if (Array.isArray(prompts)) {
    for (const prompt of prompts) {
      if (prompt && typeof prompt.prompt === "string") parts.push(prompt.prompt);
    }
  }
  const haystack = parts.filter((part) => typeof part === "string" && part.trim()).join("\n");
  if (!haystack) return false;
  if (PASSWORD_CHANGE_PROMPT_PATTERN.test(haystack)) return false;
  return MFA_SUGGESTION_PROMPT_PATTERN.test(haystack)
    || /secondary\s+authentication\s+password/i.test(haystack);
}

/**
 * Create a keyboard-interactive event handler
 * @param {Object} options
 * @param {Object} options.sender - Electron webContents sender
 * @param {string} options.sessionId - Session/connection ID
 * @param {string} [options.hostId] - Owning vault host ID, when known.
 * @param {string} options.hostname - Host being connected to
 * @param {string} [options.password] - Saved password; used both as the
 *   one-click fill button payload and as the auto-fill for the single-
 *   password-prompt fast path (#969).
 * @param {string} [options.logPrefix] - Log prefix for debugging
 * @param {"terminal"|"external"} [options.scope] - Renderer-side routing scope
 * @param {Function} [options.shouldSkipAutoFill] - Optional predicate. When it
 *   returns true, never auto-fill — always show the modal. Callers set this
 *   after a first-factor `partialSuccess` so a second-factor challenge that
 *   merely says "Password:" / "密码：" is not silently answered with the
 *   already-used login password (#2150).
 * @param {Function} [options.onAutoFill] - Called when the saved password is
 *   auto-filled into the challenge (no modal shown). Lets callers emit a
 *   different progress message than the user-prompt flow.
 * @param {Function} [options.onPromptShown] - Called right before the modal
 *   IPC is sent to the renderer.
 * @param {Function} [options.onUserResponded] - Called when the renderer
 *   sends a response back (after the modal closed).
 * @param {Function} [options.getAuthBanner] - Returns the most recent SSH
 *   USERAUTH_BANNER text for this connection, if the server sent one before
 *   the keyboard-interactive challenge.
 * @returns {Function} - Event handler for 'keyboard-interactive' event
 */
function createKeyboardInteractiveHandler(options) {
  const {
    sender,
    sessionId,
    hostId,
    hostname,
    password,
    logPrefix = "[SSH]",
    scope = "external",
    shouldSkipAutoFill,
    onAutoFill,
    onPromptShown,
    onUserResponded,
    getAuthBanner,
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

    let authBanner = "";
    try {
      authBanner = typeof getAuthBanner === "function" ? String(getAuthBanner() || "").trim() : "";
    } catch (err) {
      console.warn(`${logPrefix} getAuthBanner callback threw`, err);
    }
    const fallbackInstructions = getFallbackKeyboardInteractiveInstructions(prompts);
    const modalInstructions = instructions || authBanner || fallbackInstructions;

    // name + keyboard-interactive instructions often carry the real EDR
    // warning (e.g. "请输入二次认证密码") while prompts[i].prompt is only the
    // short English field label. USERAUTH_BANNER is intentionally display-only:
    // it can be a generic corporate legal/MFA banner before an ordinary first
    // factor Password: prompt.
    const contextText = [name, instructions, fallbackInstructions]
      .filter((s) => typeof s === "string" && s.trim())
      .join("\n");

    let skipAutoFill = false;
    try {
      skipAutoFill = typeof shouldSkipAutoFill === "function" && !!shouldSkipAutoFill();
    } catch (err) {
      console.warn(`${logPrefix} shouldSkipAutoFill callback threw`, err);
    }
    const autoFillablePasswordChallenge =
      isAutoFillablePasswordChallenge(prompts, password, contextText);

    // After a first factor already succeeded (partialSuccess), never reuse the
    // saved login password for a later keyboard-interactive challenge — even
    // if the prompt text looks like a plain "Password:" / "密码：". Corporate
    // EDR step-up often reuses password wording for a different secret.
    if (
      !skipAutoFill &&
      !autoFilledOnce &&
      autoFillablePasswordChallenge
    ) {
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

    // Never prefill the host login password into a second-factor challenge or
    // into a retry after a failed auto-fill. Passing null here is what keeps
    // KeyboardInteractiveModal from re-submitting the wrong secret on Enter
    // (#2150). autoFilledOnce blocks prefill only — not the save checkbox.
    const savedPasswordForModal = shouldPrefillSavedPassword(prompts, password, {
      skipAutoFill: skipAutoFill || autoFilledOnce,
      contextText,
    })
      ? password
      : null;
    // Hide "Save password" only for true second-factor challenges:
    //   - after a first-factor partialSuccess, or
    //   - a *single* OTP / EDR secondary field (possibly with secondary wording
    //     only in name/instructions).
    // Do NOT disable save after a failed auto-fill retry of the same first-
    // factor Password: prompt — the user may have corrected a stale login
    // password and should be able to persist it (Codex P2 on #2151).
    // Do NOT disable save just because a multi-prompt challenge also includes
    // an OTP field next to Password: (PAM/Duo first-login) — the modal only
    // ever saves the isAPasswordPrompt slot (Codex P3 on #2151).
    const singlePromptText =
      prompts.length === 1 && typeof prompts[0]?.prompt === "string"
        ? prompts[0].prompt
        : "";
    const singleSecondaryChallenge =
      prompts.length === 1 &&
      OTP_PROMPT_PATTERN.test(
        [contextText, singlePromptText].filter(Boolean).join("\n"),
      );
    const allowSavePassword = !(skipAutoFill || singleSecondaryChallenge);

    console.log(`${logPrefix} Showing modal for ${promptsData.length} prompts`);
    try { onPromptShown?.(); } catch (err) { console.warn(`${logPrefix} onPromptShown callback threw`, err); }

    safeSend(sender, "netcatty:keyboard-interactive", {
      requestId,
      sessionId,
      hostId,
      name: name || hostname,
      instructions: modalInstructions,
      prompts: promptsData,
      hostname: hostname,
      savedPassword: savedPasswordForModal,
      allowSavePassword,
      scope,
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
  orderSshIdentityNames,
  looksLikePrivateKey,
  isKeyEncrypted,
  findDefaultPrivateKey,
  findAllDefaultPrivateKeys,
  getSshAgentSocket,
  getAvailableAgentSocket,
  getNativeOpenSshAgentSocket,
  isWindowsNamedPipe,
  ssh2AgentConnectable,
  cygwinAgentConnectable,
  socketAgentConnectable,
  resolveIdentityAgentPath,
  prepareSystemSshAgentForAuth,
  buildAuthHandler,
  appendPasswordAuthMethods,
  ensureKeyboardInteractiveMethod,
  createAuthPhase,
  markAuthPhasePartialSuccess,
  canRepeatKeyboardInteractive,
  shouldSkipKiPasswordAutoFill,
  createOrderedStringAuthHandler,
  createKeyboardInteractiveHandler,
  isAutoFillablePasswordChallenge,
  shouldPrefillSavedPassword,
  looksLikeSecondaryAuthChallenge,
  applyAuthToConnOpts,
  safeSend,
  requestPassphrasesForEncryptedKeys,
  readFileNoFollow,
  expandIdentityFilePath,
  preparePrivateKeyForAuth,
  loadIdentityFileForAuth,
  loadFirstIdentityFileForAuth,
  hasUserConfiguredKey,
  isPasswordProvided,
  PassphraseCancelledError,
  isPassphraseCancelledError,
};
