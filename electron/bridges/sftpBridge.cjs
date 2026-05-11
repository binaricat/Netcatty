/**
 * SFTP Bridge - Handles SFTP connections and file operations
 * Extracted from main.cjs for single responsibility
 */

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { pipeline } = require("node:stream/promises");
const { TextDecoder } = require("node:util");
const SftpClient = require("ssh2-sftp-client");
const { Client: SSHClient } = require("ssh2");
const iconv = require("iconv-lite");
let SFTPWrapper;
try {
  // Try to load SFTPWrapper from ssh2 internals for sudo support
  const sftpModule = require("ssh2/lib/protocol/SFTP");
  SFTPWrapper = sftpModule.SFTP || sftpModule;
} catch (e) {
  console.warn("[SFTP] Failed to load SFTPWrapper from ssh2, sudo mode will not work:", e.message);
}
const { NetcattyAgent } = require("./netcattyAgent.cjs");
const fileWatcherBridge = require("./fileWatcherBridge.cjs");
const keyboardInteractiveHandler = require("./keyboardInteractiveHandler.cjs");
const passphraseHandler = require("./passphraseHandler.cjs");
const tempDirBridge = require("./tempDirBridge.cjs");
const { createProxySocket } = require("./proxyUtils.cjs");
const {
  buildAuthHandler,
  createKeyboardInteractiveHandler,
  applyAuthToConnOpts,
  safeSend: authSafeSend,
  isKeyEncrypted,
  findAllDefaultPrivateKeys: findAllDefaultPrivateKeysFromHelper,
  getAvailableAgentSocket,
  preparePrivateKeyForAuth,
  loadFirstIdentityFileForAuth,
} = require("./sshAuthHelper.cjs");

// SFTP clients storage - shared reference passed from main
let sftpClients = null;
let electronModule = null;
let sessions = null;

// Storage for jump host connections that need to be cleaned up
const jumpConnectionsMap = new Map(); // connId -> { connections: SSHClient[], socket: stream }

// Storage for active SFTP uploads that can be cancelled
const activeSftpUploads = new Map(); // transferId -> { cancelled: boolean, stream: Readable }

// Track requested/resolved filename encoding per SFTP session
const sftpEncodingState = new Map(); // stateKey -> { requested: 'auto'|'utf-8'|'gb18030', resolved: 'utf-8'|'gb18030' }
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

const cloneEncodingState = (value) => (
  value && typeof value === "object"
    ? { requested: value.requested || "auto", resolved: value.resolved || "utf-8" }
    : null
);

function copySftpEncodingState(sourceKey, targetKey) {
  if (!sourceKey || !targetKey || sourceKey === targetKey) return;
  const state = cloneEncodingState(sftpEncodingState.get(sourceKey));
  if (state) {
    sftpEncodingState.set(targetKey, state);
  } else {
    sftpEncodingState.delete(targetKey);
  }
}

function clearSftpEncodingState(stateKey) {
  if (!stateKey) return;
  sftpEncodingState.delete(stateKey);
}

function clearSftpEncodingStateByPrefix(prefix) {
  if (!prefix) return;
  for (const key of sftpEncodingState.keys()) {
    if (key.startsWith(prefix)) {
      sftpEncodingState.delete(key);
    }
  }
}

const normalizeEncoding = (encoding) => {
  if (!encoding) return "auto";
  const normalized = String(encoding).toLowerCase();
  if (normalized === "utf8") return "utf-8";
  return normalized;
};

const isValidUtf8 = (buffer) => {
  try {
    utf8Decoder.decode(buffer);
    return true;
  } catch {
    return false;
  }
};

const detectEncodingFromList = (items) => {
  // Return null if we can't definitively detect encoding (empty list or all valid UTF-8)
  // This allows the caller to preserve the previous encoding instead of defaulting to UTF-8
  if (!items || items.length === 0) {
    return null;
  }
  for (const item of items) {
    const raw = item?.filenameRaw || (item?.filename ? Buffer.from(item.filename, "utf8") : null);
    if (raw && !isValidUtf8(raw)) {
      return "gb18030";
    }
  }
  // All filenames are valid UTF-8, but we can't prove they're not GB18030-encoded ASCII
  // Return null to preserve previous encoding rather than forcing UTF-8
  return null;
};

const resolveEncodingForRequest = (sftpId, requestedEncoding) => {
  const requested = normalizeEncoding(requestedEncoding);
  if (requested && requested !== "auto") {
    sftpEncodingState.set(sftpId, { requested, resolved: requested });
    return requested;
  }
  const existing = sftpEncodingState.get(sftpId);
  const resolved = existing?.resolved || "utf-8";
  sftpEncodingState.set(sftpId, { requested: "auto", resolved });
  return resolved;
};

const updateResolvedEncoding = (sftpId, requestedEncoding, resolvedEncoding) => {
  const requested = normalizeEncoding(requestedEncoding);
  const resolved = normalizeEncoding(resolvedEncoding);
  const finalResolved = resolved === "auto" ? "utf-8" : resolved;
  sftpEncodingState.set(sftpId, {
    requested: requested || "auto",
    resolved: finalResolved,
  });
  return finalResolved;
};

const isAsciiString = (value) =>
  typeof value === "string" && /^[\x00-\x7F]*$/.test(value);

const encodePath = (input, encoding) => {
  if (input === undefined || input === null) return input;
  if (Buffer.isBuffer(input)) return input;
  if (encoding === "utf-8") return input;
  // Avoid Buffer paths when ASCII-only; keeps compatibility with unpatched ssh2
  if (isAsciiString(input)) return input;
  return iconv.encode(input, encoding);
};

const decodeName = (raw, encoding) => {
  if (!raw) return "";
  if (Buffer.isBuffer(raw)) {
    return encoding === "utf-8" ? raw.toString("utf8") : iconv.decode(raw, encoding);
  }
  return raw;
};

const encodePathForSession = (sftpId, inputPath, requestedEncoding) => {
  if (!sftpId) return inputPath;
  const encoding = resolveEncodingForRequest(sftpId, requestedEncoding);
  return encodePath(inputPath, encoding);
};

const hasSftpChannelApi = (value) =>
  !!value &&
  typeof value.readdir === "function" &&
  typeof value.stat === "function" &&
  typeof value.mkdir === "function" &&
  typeof value.unlink === "function";

const DEFAULT_SFTP_CHANNEL_OPEN_TIMEOUT_MS = 10_000;

function createAbortError(signal, fallbackMessage = "The operation was aborted.") {
  const reason = signal?.reason;
  if (reason instanceof Error) {
    return reason;
  }
  if (typeof reason === "string" && reason) {
    return new Error(reason);
  }
  return new Error(fallbackMessage);
}

const tryOpenSftpChannel = (client, options = {}) =>
  new Promise((resolve, reject) => {
    const sshClient = client?.client;
    if (!sshClient || typeof sshClient.sftp !== "function") {
      resolve(null);
      return;
    }
    const signal = options?.signal || null;
    const timeoutMs = Number.isFinite(options?.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_SFTP_CHANNEL_OPEN_TIMEOUT_MS;
    if (signal?.aborted) {
      reject(createAbortError(signal, "SFTP channel open was aborted"));
      return;
    }
    let settled = false;
    let timer = null;
    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
    };
    const closeOrphanedChannel = (sftp) => {
      try { sftp?.end?.(); } catch {}
      try { sftp?.close?.(); } catch {}
    };
    const finishReject = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const finishResolve = (sftp) => {
      if (settled) {
        closeOrphanedChannel(sftp);
        return;
      }
      settled = true;
      cleanup();
      resolve(sftp || null);
    };
    const onAbort = () => {
      finishReject(createAbortError(signal, "SFTP channel open was aborted"));
    };
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    if (timeoutMs) {
      timer = setTimeout(() => {
        finishReject(new Error(`SFTP channel open timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }
    try {
      sshClient.sftp((err, sftp) => {
        if (err) {
          finishReject(err);
          return;
        }
        finishResolve(sftp);
      });
    } catch (err) {
      finishReject(err);
    }
  });

const getSftpChannel = async (client, options = {}) => {
  if (!client) return null;

  if (hasSftpChannelApi(client.sftp)) {
    return client.sftp;
  }

  // sudo sessions must keep using the sudo-bootstrapped SFTP wrapper.
  // Reopening with sshClient.sftp() would silently downgrade permissions.
  if (client.__netcattySudoMode) {
    console.warn("[SFTP] Sudo SFTP channel is unavailable; automatic recovery is disabled for sudo sessions. Please reconnect.");
    return null;
  }

  // Do not treat ssh2's "client.sftp" method as a channel object.
  // Re-open a fresh channel when the cached channel is stale.
  if (!client.client || typeof client.client.sftp !== "function") {
    return null;
  }

  // Deduplicate per-client: avoid concurrent channel re-open attempts
  if (client._reopeningPromise) {
    try {
      return await client._reopeningPromise;
    } catch {
      return null;
    }
  }

  client._reopeningPromise = (async () => {
    try {
      const reopened = await tryOpenSftpChannel(client, options);
      if (hasSftpChannelApi(reopened)) {
        client.sftp = reopened;
        return reopened;
      }
    } catch (err) {
      console.warn("[SFTP] Failed to recover SFTP channel", err?.message || String(err));
    }
    return null;
  })();

  try {
    return await client._reopeningPromise;
  } finally {
    client._reopeningPromise = null;
  }
};

const requireSftpChannel = async (client, options = {}) => {
  const sftp = await getSftpChannel(client, options);
  if (!sftp) {
    throw new Error("SFTP session lost. Please reconnect.");
  }
  return sftp;
};

const realpathAsync = (sftp, targetPath) =>
  new Promise((resolve, reject) => {
    sftp.realpath(targetPath, (err, absPath) => (err ? reject(err) : resolve(absPath)));
  });

const statAsync = (sftp, targetPath) =>
  new Promise((resolve, reject) => {
    sftp.stat(targetPath, (err, stats) => (err ? reject(err) : resolve(stats)));
  });

const readdirAsync = (sftp, targetPath) =>
  new Promise((resolve, reject) => {
    sftp.readdir(targetPath, (err, items) => (err ? reject(err) : resolve(items || [])));
  });

const mkdirAsync = (sftp, targetPath) =>
  new Promise((resolve, reject) => {
    sftp.mkdir(targetPath, (err) => (err ? reject(err) : resolve()));
  });

const rmdirAsync = (sftp, targetPath) =>
  new Promise((resolve, reject) => {
    sftp.rmdir(targetPath, (err) => (err ? reject(err) : resolve()));
  });

const unlinkAsync = (sftp, targetPath) =>
  new Promise((resolve, reject) => {
    sftp.unlink(targetPath, (err) => (err ? reject(err) : resolve()));
  });

const openFileAsync = (sftp, targetPath, flags = "w") =>
  new Promise((resolve, reject) => {
    sftp.open(targetPath, flags, (err, handle) => (err ? reject(err) : resolve(handle)));
  });

const writeFileChunkAsync = (sftp, handle, buffer, offset, length, position) =>
  new Promise((resolve, reject) => {
    sftp.write(handle, buffer, offset, length, position, (err) => (err ? reject(err) : resolve()));
  });

const closeFileAsync = (sftp, handle) =>
  new Promise((resolve, reject) => {
    sftp.close(handle, (err) => (err ? reject(err) : resolve()));
  });

const normalizeRemotePathString = async (client, inputPath) => {
  if (typeof inputPath !== "string") return inputPath;
  if (inputPath.startsWith("..")) {
    const root = await client.realPath("..");
    return `${root}/${inputPath.slice(3)}`;
  }
  if (inputPath.startsWith(".")) {
    const root = await client.realPath(".");
    return `${root}/${inputPath.slice(2)}`;
  }
  return inputPath;
};

const isWindowsRemotePath = (dirPath) => /^[A-Za-z]:[\\/]/.test(dirPath) || /^[A-Za-z]:$/.test(dirPath);

const normalizeRemoteDirPath = (dirPath) => {
  if (isWindowsRemotePath(dirPath)) {
    const normalized = dirPath.replace(/\//g, "\\").replace(/\\+/g, "\\");
    if (/^[A-Za-z]:$/.test(normalized)) return `${normalized}\\`;
    return normalized;
  }
  return path.posix.normalize(dirPath);
};

const ensureRemoteDirInternal = async (sftp, dirPath, encoding) => {
  if (!dirPath || dirPath === ".") return;
  const normalized = normalizeRemoteDirPath(dirPath);
  if (!normalized || normalized === ".") return;

  // Optimization: Check if the full path already exists to avoid O(N) round trips
  // This is the common case (e.g. uploading multiple files to the same directory)
  const encodedFull = encodePath(normalized, encoding);
  try {
    const stats = await statAsync(sftp, encodedFull);
    if (stats.isDirectory()) {
      return;
    }
  } catch (err) {
    // If path doesn't exist or other error, proceed to recursive check
  }

  const isWindowsPath = isWindowsRemotePath(normalized);
  const isAbsolute = normalized.startsWith("/");
  const parts = isWindowsPath
    ? normalized.slice(2).replace(/^[\\]+/, "").split(/[\\]+/).filter(Boolean)
    : normalized.split("/").filter(Boolean);
  let current = isWindowsPath
    ? `${normalized.slice(0, 2)}\\`
    : (isAbsolute ? "/" : "");

  for (const part of parts) {
    if (isWindowsPath) {
      const base = current.replace(/[\\]+$/, "");
      current = `${base}\\${part}`;
    } else {
      current = current === "/" ? `/${part}` : (current ? `${current}/${part}` : part);
    }
    const encodedCurrent = encodePath(current, encoding);
    try {
      const stats = await statAsync(sftp, encodedCurrent);
      if (!stats.isDirectory()) {
        throw new Error(`Remote path is not a directory: ${current}`);
      }
    } catch (err) {
      if (err && (err.code === 2 || err.code === 4)) {
        await mkdirAsync(sftp, encodedCurrent);
        continue;
      }
      throw err;
    }
  }
};

const removeRemotePathInternal = async (sftp, targetPath, encoding, signal = null) => {
  throwIfAborted(signal);
  const encodedTarget = encodePath(targetPath, encoding);
  let stats;
  try {
    stats = await statAsync(sftp, encodedTarget);
  } catch (err) {
    if (err && err.code === 2) return;
    throw err;
  }
  throwIfAborted(signal);

  if (stats.isDirectory()) {
    throwIfAborted(signal);
    const items = await readdirAsync(sftp, encodedTarget);
    throwIfAborted(signal);
    for (const item of items) {
      throwIfAborted(signal);
      const rawName =
        item?.filenameRaw ||
        (item?.filename ? Buffer.from(item.filename, "utf8") : null);
      const name = decodeName(rawName, encoding);
      if (!name || name === "." || name === "..") continue;
      const childPath = path.posix.join(targetPath, name);
      await removeRemotePathInternal(sftp, childPath, encoding, signal);
      throwIfAborted(signal);
    }
    throwIfAborted(signal);
    await rmdirAsync(sftp, encodedTarget);
  } else {
    throwIfAborted(signal);
    await unlinkAsync(sftp, encodedTarget);
  }
  throwIfAborted(signal);
};

const ensureRemoteDirForSession = async (sftpId, dirPath, requestedEncoding) => {
  const client = sftpClients.get(sftpId);
  if (!client) throw new Error("SFTP session not found");

  if (!dirPath || dirPath === ".") return true;

  const encoding = resolveEncodingForRequest(sftpId, requestedEncoding);
  const sftp = await requireSftpChannel(client);

  // Always walk the path segment-by-segment. This lets sftp.stat() follow
  // symlinked directory segments before deciding whether the next mkdir is
  // valid, which avoids recursive mkdir failures on paths like /link/subdir.
  const normalizedPath = await normalizeRemotePathString(client, dirPath);
  await ensureRemoteDirInternal(sftp, normalizedPath, encoding);
  return true;
};

/**
 * Build SSH algorithm configuration for SFTP connections.
 * When legacyEnabled is true, legacy algorithms are appended for older device compatibility.
 */
function buildSftpAlgorithms(legacyEnabled) {
  const algorithms = {
    cipher: [
      'aes128-gcm@openssh.com', 'aes256-gcm@openssh.com',
      'aes128-ctr', 'aes192-ctr', 'aes256-ctr',
    ],
    kex: [
      'curve25519-sha256', 'curve25519-sha256@libssh.org',
      'ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521',
      'diffie-hellman-group14-sha256',
      'diffie-hellman-group16-sha512', 'diffie-hellman-group18-sha512',
      'diffie-hellman-group-exchange-sha256',
    ],
    compress: ['none'],
  };

  if (legacyEnabled) {
    algorithms.kex.push(
      'diffie-hellman-group14-sha1',
      'diffie-hellman-group1-sha1',
    );
    algorithms.cipher.push(
      'aes128-cbc', 'aes256-cbc', '3des-cbc',
    );
    algorithms.serverHostKey = [
      'ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521',
      'rsa-sha2-512', 'rsa-sha2-256',
      'ssh-rsa', 'ssh-dss',
    ];
  }

  return algorithms;
}

const { safeSend } = require("./ipcUtils.cjs");

/**
 * Initialize the SFTP bridge with dependencies
 */
function init(deps) {
  sftpClients = deps.sftpClients;
  electronModule = deps.electronModule;
  sessions = deps.sessions;
}

function ensureRemoteSftpSupport(sessionId) {
  const session = sessions?.get(sessionId);
  if (!session) {
    throw new Error(`Session "${sessionId}" not found`);
  }
  const sshClient = session.conn || session.sshClient;
  if (!sshClient || typeof sshClient.sftp !== "function") {
    throw new Error("SFTP is only supported for SSH sessions with an active SSH connection.");
  }
  return { session, sshClient };
}

function buildStagedRemotePath(remotePath) {
  const isWindowsPath = isWindowsRemotePath(remotePath);
  const lastSeparatorIndex = Math.max(remotePath.lastIndexOf("/"), remotePath.lastIndexOf("\\"));
  const dir = lastSeparatorIndex >= 0 ? remotePath.slice(0, lastSeparatorIndex + 1) : "";
  const baseName = lastSeparatorIndex >= 0 ? remotePath.slice(lastSeparatorIndex + 1) : remotePath;
  const safeBaseName = baseName || "upload";
  const stagedName = `.netcatty-upload-${randomUUID().slice(0, 8)}-${safeBaseName}.part`;
  return dir ? `${dir}${stagedName}` : stagedName;
}

function buildBackupRemotePath(remotePath) {
  const lastSeparatorIndex = Math.max(remotePath.lastIndexOf("/"), remotePath.lastIndexOf("\\"));
  const dir = lastSeparatorIndex >= 0 ? remotePath.slice(0, lastSeparatorIndex + 1) : "";
  const baseName = lastSeparatorIndex >= 0 ? remotePath.slice(lastSeparatorIndex + 1) : remotePath;
  const safeBaseName = baseName || "upload";
  const backupName = `.netcatty-backup-${randomUUID().slice(0, 8)}-${safeBaseName}.bak`;
  return dir ? `${dir}${backupName}` : backupName;
}

const posixRenameAsync = (sftp, fromPath, toPath) =>
  new Promise((resolve, reject) => {
    if (typeof sftp?.ext_openssh_rename !== "function") {
      reject(new Error("POSIX rename is not supported by this SFTP channel."));
      return;
    }
    sftp.ext_openssh_rename(fromPath, toPath, (err) => (err ? reject(err) : resolve()));
  });

async function renameRemotePath(client, fromPath, toPath, backupPath = null) {
  const sftp = await requireSftpChannel(client);
  if (typeof sftp?.ext_openssh_rename === "function") {
    try {
      await posixRenameAsync(sftp, fromPath, toPath);
      return;
    } catch {
      // Fall back to plain rename when the OpenSSH extension is unavailable or rejected.
    }
  }
  try {
    await client.rename(fromPath, toPath);
    return;
  } catch (renameErr) {
    if (!backupPath) throw renameErr;

    const destinationStat = await client.stat(toPath)
      .then((stat) => stat || null)
      .catch(() => false);
    if (!destinationStat || destinationStat.isDirectory) {
      throw renameErr;
    }

    let movedExistingTarget = false;
    try {
      await client.rename(toPath, backupPath);
      movedExistingTarget = true;
      await client.rename(fromPath, toPath);
    } catch (fallbackErr) {
      if (movedExistingTarget) {
        try {
          await client.rename(backupPath, toPath);
        } catch {
          // Ignore restore failures and surface the original fallback error.
        }
      }
      throw fallbackErr;
    }

    if (movedExistingTarget) {
      try {
        await client.delete(backupPath);
      } catch {
        // Ignore backup cleanup failures after the final file is in place.
      }
    }
  }
}

function collectReadable(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.once("error", reject);
    stream.once("end", () => resolve(Buffer.concat(chunks)));
  });
}

function writeToWritable(stream, content) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      stream.removeListener("error", onError);
      stream.removeListener("finish", onSuccess);
      stream.removeListener("close", onSuccess);
    };
    const onError = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const onSuccess = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    stream.once("error", onError);
    stream.once("finish", onSuccess);
    stream.once("close", onSuccess);
    stream.end(content);
  });
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) {
    throw reason;
  }
  if (typeof reason === "string" && reason) {
    throw new Error(reason);
  }
  throw new Error("The operation was aborted.");
}

async function pipeStreams(source, destination, signal = null) {
  if (signal) {
    return await pipeline(source, destination, { signal });
  }
  return await pipeline(source, destination);
}

function statResultFromAttrs(attrs) {
  const mode = attrs?.mode || 0;
  const fileTypeMask = mode & 0o170000;
  return {
    size: attrs?.size || 0,
    modifyTime: (attrs?.mtime || 0) * 1000,
    mode,
    isDirectory: typeof attrs?.isDirectory === "function"
      ? attrs.isDirectory()
      : fileTypeMask === 0o040000,
    isSymbolicLink: typeof attrs?.isSymbolicLink === "function"
      ? attrs.isSymbolicLink()
      : fileTypeMask === 0o120000,
  };
}

function createSessionBackedSftpClient(sessionId, sshClient) {
  const client = {
    client: sshClient,
    sftp: null,
    __netcattySessionBacked: true,
    _reopeningPromise: null,
    async get(remotePath) {
      const sftp = await requireSftpChannel(client);
      const stream = sftp.createReadStream(remotePath);
      return await collectReadable(stream);
    },
    async put(content, remotePath, options = {}) {
      const sftp = await requireSftpChannel(client);
      const signal = options?.signal || null;
      throwIfAborted(signal);
      if (content && typeof content.pipe === "function") {
        const stream = sftp.createWriteStream(remotePath);
        await pipeStreams(content, stream, signal);
        return true;
      }
      const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
      const handle = await openFileAsync(sftp, remotePath, "w");
      try {
        let offset = 0;
        while (offset < buffer.length) {
          throwIfAborted(signal);
          const length = Math.min(256 * 1024, buffer.length - offset);
          await writeFileChunkAsync(sftp, handle, buffer, offset, length, offset);
          offset += length;
        }
      } finally {
        await closeFileAsync(sftp, handle);
      }
      return true;
    },
    async stat(remotePath) {
      const sftp = await requireSftpChannel(client);
      const attrs = await statAsync(sftp, remotePath);
      return statResultFromAttrs(attrs);
    },
    async realPath(remotePath) {
      const sftp = await requireSftpChannel(client);
      return await realpathAsync(sftp, remotePath);
    },
    async rename(oldPath, newPath) {
      const sftp = await requireSftpChannel(client);
      await new Promise((resolve, reject) => {
        sftp.rename(oldPath, newPath, (err) => (err ? reject(err) : resolve()));
      });
    },
    async delete(remotePath, options = {}) {
      const signal = options?.signal || null;
      throwIfAborted(signal);
      const sftp = await requireSftpChannel(client, { signal });
      throwIfAborted(signal);
      await unlinkAsync(sftp, remotePath);
      throwIfAborted(signal);
    },
    async rmdir(remotePath, recursive = false, options = {}) {
      const signal = options?.signal || null;
      throwIfAborted(signal);
      const sftp = await requireSftpChannel(client, { signal });
      if (recursive) {
        const normalized = await normalizeRemotePathString(client, remotePath);
        throwIfAborted(signal);
        await removeRemotePathInternal(sftp, normalized, "utf-8", signal);
        return;
      }
      throwIfAborted(signal);
      await rmdirAsync(sftp, remotePath);
      throwIfAborted(signal);
    },
    async chmod(remotePath, mode) {
      const sftp = await requireSftpChannel(client);
      await new Promise((resolve, reject) => {
        if (typeof sftp.chmod === "function") {
          sftp.chmod(remotePath, mode, (err) => (err ? reject(err) : resolve()));
          return;
        }
        sftp.setstat(remotePath, { mode }, (err) => (err ? reject(err) : resolve()));
      });
    },
    async end() {
      try {
        if (client.sftp && typeof client.sftp.end === "function") {
          client.sftp.end();
        } else if (client.sftp && typeof client.sftp.close === "function") {
          client.sftp.close();
        }
      } catch {
        // Ignore channel close failures for session-backed clients.
      } finally {
        client.sftp = null;
      }
    },
  };

  return client;
}

async function openSftpForSession(_event, payload) {
  const { sessionId } = payload || {};
  if (!sessionId) throw new Error("sessionId is required");

  throwIfAborted(payload?.abortSignal);
  const { sshClient } = ensureRemoteSftpSupport(sessionId);
  const sftpId = `${sessionId}-sftp-${randomUUID()}`;
  const client = createSessionBackedSftpClient(sessionId, sshClient);
  try {
    await requireSftpChannel(client, {
      signal: payload?.abortSignal,
      timeoutMs: payload?.timeoutMs,
    });
    throwIfAborted(payload?.abortSignal);
    copySftpEncodingState(payload?.encodingStateKey, sftpId);
    sftpClients.set(sftpId, client);
    return { ok: true, sftpId };
  } catch (err) {
    try {
      await client.end();
    } catch {
      // Ignore cleanup failures while discarding a one-off session-backed handle.
    }
    throw err;
  }
}

async function downloadSftpToLocal(_event, payload) {
  const client = sftpClients.get(payload.sftpId);
  if (!client) throw new Error("SFTP session not found");

  const sftp = await requireSftpChannel(client);
  const encoding = resolveEncodingForRequest(payload.sftpId, payload.encoding);
  const encodedPath = encodePath(payload.remotePath, encoding);
  const stagedFilePath = tempDirBridge.getTempFilePath(path.basename(payload.localPath || payload.remotePath || "download"));
  throwIfAborted(payload.abortSignal);
  const readStream = sftp.createReadStream(encodedPath);
  const writeStream = fs.createWriteStream(stagedFilePath);
  try {
    await pipeStreams(readStream, writeStream, payload.abortSignal);
    throwIfAborted(payload.abortSignal);
    try {
      await fs.promises.rename(stagedFilePath, payload.localPath);
    } catch (err) {
      if (err?.code !== "EXDEV" && err?.code !== "EEXIST" && err?.code !== "EPERM") {
        throw err;
      }
      await fs.promises.copyFile(stagedFilePath, payload.localPath);
      await fs.promises.unlink(stagedFilePath);
    }
  } catch (err) {
    try {
      await fs.promises.unlink(stagedFilePath);
    } catch {
      // Ignore temp-file cleanup failures after a cancelled or failed download.
    }
    throw err;
  }
  return { success: true, localPath: payload.localPath };
}

async function uploadLocalToSftp(_event, payload) {
  const client = sftpClients.get(payload.sftpId);
  if (!client) throw new Error("SFTP session not found");

  await requireSftpChannel(client);
  const encoding = resolveEncodingForRequest(payload.sftpId, payload.encoding);
  const stagedRemotePath = buildStagedRemotePath(payload.remotePath);
  const backupRemotePath = buildBackupRemotePath(payload.remotePath);
  const encodedPath = encodePath(payload.remotePath, encoding);
  const encodedStagedPath = encodePath(stagedRemotePath, encoding);
  const encodedBackupPath = encodePath(backupRemotePath, encoding);
  throwIfAborted(payload.abortSignal);
  const content = fs.createReadStream(payload.localPath);
  try {
    await client.put(content, encodedStagedPath, { signal: payload.abortSignal });
    throwIfAborted(payload.abortSignal);
    await renameRemotePath(client, encodedStagedPath, encodedPath, encodedBackupPath);
  } catch (err) {
    try {
      await client.delete(encodedStagedPath);
    } catch {
      // Ignore best-effort cleanup failures for partially uploaded temp files.
    }
    throw err;
  }
  return { success: true, remotePath: payload.remotePath };
}

/**
 * Send SFTP connection progress to the renderer for user-visible logging
 */
function sendSftpProgress(sender, sessionId, label, status, detail) {
  try {
    if (!sender || sender.isDestroyed()) return;
    sender.send("netcatty:sftp:connection-progress", { sessionId, label, status, detail });
  } catch {
    // Ignore destroyed webContents
  }
}

/**
 * Connect through a chain of jump hosts for SFTP
 */
async function connectThroughChainForSftp(event, options, jumpHosts, targetHost, targetPort, connId, agentSocket) {
  const sender = event.sender;
  const connections = [];
  let currentSocket = null;
  let activeConn = null;

  const cleanupSocket = (socket) => {
    if (!socket) return;
    try { socket.end?.(); } catch { /* ignore */ }
    try { socket.destroy?.(); } catch { /* ignore */ }
  };

  try {
    // Connect through each jump host
    for (let i = 0; i < jumpHosts.length; i++) {
      const jump = jumpHosts[i];
      const isFirst = i === 0;
      const isLast = i === jumpHosts.length - 1;
      const hopLabel = jump.label || (jump.hostname.includes(':') && !jump.hostname.startsWith('[') ? `[${jump.hostname}]:${jump.port || 22}` : `${jump.hostname}:${jump.port || 22}`);

      console.log(`[SFTP Chain] Hop ${i + 1}/${jumpHosts.length}: Connecting to ${hopLabel}...`);
      sendSftpProgress(sender, connId, hopLabel, 'connecting');

      const conn = new SSHClient();
      activeConn = conn;
      // Increase max listeners to prevent Node.js warning
      // Set to 0 (unlimited) since complex operations add many temp listeners
      conn.setMaxListeners(0);

      // Per-hop keepalive. The renderer's resolver returns either a positive
      // number (use it) or 0 (the host explicitly opted out, e.g. a router
      // whose SSH stack doesn't reply to keepalive@openssh.com). Only when
      // BOTH the per-hop and the target-call fields are undefined do we
      // fall back to 10s/3 — that path exists for older serializers that
      // pre-date per-host plumbing, preserving the #669 idle-NAT protection
      // for callers that haven't yet been updated.
      const hopInterval = jump.keepaliveInterval != null
        ? jump.keepaliveInterval
        : options.keepaliveInterval;
      const hopCountMax = jump.keepaliveCountMax != null
        ? jump.keepaliveCountMax
        : options.keepaliveCountMax;
      const hopIntervalMs = hopInterval == null
        ? 10000
        : (hopInterval > 0 ? hopInterval * 1000 : 0);
      const hopCountMaxEffective = hopInterval == null
        ? 3
        : (hopInterval > 0 ? (hopCountMax ?? 3) : 0);
      // Build connection options
      const connOpts = {
        host: jump.hostname,
        port: jump.port || 22,
        username: jump.username || 'root',
        readyTimeout: 120000, // 2 minutes to allow for keyboard-interactive (2FA/MFA)
        keepaliveInterval: hopIntervalMs,
        keepaliveCountMax: hopCountMaxEffective,
        // Enable keyboard-interactive authentication (required for 2FA/MFA)
        tryKeyboard: true,
        algorithms: buildSftpAlgorithms(options.legacyAlgorithms),
      };

      // Auth - support agent (certificate), key, and password fallback
      const hasCertificate =
        typeof jump.certificate === "string" && jump.certificate.trim().length > 0;

      const identityFile = !jump.privateKey
        ? await loadFirstIdentityFileForAuth({
          sender,
          identityFilePaths: jump.identityFilePaths,
          hostname: hopLabel,
          initialPassphrase: jump.passphrase,
          logPrefix: `[SFTP Chain] Hop ${i + 1}:`,
          onLoaded: (loaded) => {
            console.log(`[SFTP Chain] Hop ${i + 1}: loaded identity file ${loaded.keyPath}`);
          },
          onError: (err, keyPath) => {
            console.warn(`[SFTP Chain] Hop ${i + 1}: failed to read identity file ${keyPath}:`, err.message);
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
          logPrefix: `[SFTP Chain] Hop ${i + 1}:`,
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
          console.log(`[SFTP Chain] Hop ${i + 1}: key is encrypted, requesting passphrase`);
          const keyLabel = jump.label || hopLabel;
          const result = await passphraseHandler.requestPassphrase(
            sender,
            `SSH key for ${keyLabel}`,
            keyLabel,
            hopLabel
          );
          if (result?.passphrase) {
            connOpts.passphrase = result.passphrase;
          } else {
            delete connOpts.privateKey;
            if (result?.cancelled) {
              throw new Error(`Passphrase entry cancelled for ${hopLabel}`);
            }
          }
        }
      }

      if (jump.password) connOpts.password = jump.password;

      // Get default keys (either from options if pre-fetched, or fetch them now)
      const defaultKeys = options._defaultKeys || await findAllDefaultPrivateKeysFromHelper();

      // Build auth handler using shared helper
      // Pass unlocked encrypted keys from options so jump hosts can use them for retry
      const authConfig = buildAuthHandler({
        privateKey: connOpts.privateKey,
        password: connOpts.password,
        passphrase: connOpts.passphrase,
        agent: connOpts.agent,
        username: connOpts.username,
        logPrefix: `[SFTP Chain] Hop ${i + 1}`,
        unlockedEncryptedKeys: options._unlockedEncryptedKeys || [],
        defaultKeys,
        sshAgentSocketOverride: agentSocket,
        onAuthAttempt: (method) => {
          sendSftpProgress(sender, connId, hopLabel, 'auth-attempt', method);
        },
      });
      applyAuthToConnOpts(connOpts, authConfig);

      // If first hop and proxy is configured, connect through proxy
      const hasUsableJumpProxy = !!(jump.proxy?.host && jump.proxy?.port);
      const effectiveHopProxy = isFirst ? ((hasUsableJumpProxy ? jump.proxy : null) || options.proxy) : null;
      if (effectiveHopProxy) {
        currentSocket = await createProxySocket(effectiveHopProxy, jump.hostname, jump.port || 22);
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
          sendSftpProgress(sender, connId, hopLabel, 'authenticating');
        });
        conn.once('ready', () => {
          console.log(`[SFTP Chain] Hop ${i + 1}/${jumpHosts.length}: ${hopLabel} connected`);
          sendSftpProgress(sender, connId, hopLabel, 'connected');
          resolve();
        });
        conn.on('error', (err) => {
          // Filter out non-fatal agent auth errors (same as in openSftp)
          if (err.level === 'agent') {
            console.log(`[SFTP Chain] Hop ${i + 1} non-fatal agent auth error (will try next method):`, err.message);
            return;
          }
          console.error(`[SFTP Chain] Hop ${i + 1}/${jumpHosts.length}: ${hopLabel} error:`, err.message);
          sendSftpProgress(sender, connId, hopLabel, 'error', err.message);
          reject(err);
        });
        conn.once('timeout', () => {
          console.error(`[SFTP Chain] Hop ${i + 1}/${jumpHosts.length}: ${hopLabel} timeout`);
          reject(new Error(`Connection timeout to ${hopLabel}`));
        });
        // Handle keyboard-interactive authentication for jump hosts (2FA/MFA)
        const sftpChainKiHandler = createKeyboardInteractiveHandler({
          sender,
          sessionId: connId,
          hostname: hopLabel,
          password: jump.password,
          logPrefix: `[SFTP Chain] Hop ${i + 1}/${jumpHosts.length}`,
        });
        conn.on('keyboard-interactive', (name, instructions, lang, prompts, finish) => {
          if (prompts && prompts.length > 0) {
            sendSftpProgress(sender, connId, hopLabel, 'auth-attempt', 'waiting for user input...');
          }
          const wrappedFinish = (...args) => {
            sendSftpProgress(sender, connId, hopLabel, 'auth-attempt', 'user responded');
            finish(...args);
          };
          sftpChainKiHandler(name, instructions, lang, prompts, wrappedFinish);
        });
        conn.connect(connOpts);
      });

      connections.push(conn);
      activeConn = null;

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
      console.log(`[SFTP Chain] Hop ${i + 1}/${jumpHosts.length}: Forwarding to ${nextHost}:${nextPort}...`);
      currentSocket = await new Promise((resolve, reject) => {
        conn.forwardOut('127.0.0.1', 0, nextHost, nextPort, (err, stream) => {
          if (err) {
            console.error(`[SFTP Chain] Hop ${i + 1}/${jumpHosts.length}: forwardOut failed:`, err.message);
            reject(err);
            return;
          }
          console.log(`[SFTP Chain] Hop ${i + 1}/${jumpHosts.length}: forwardOut success`);
          resolve(stream);
        });
      });
    }

    // Return the final forwarded stream and all connections for cleanup
    return {
      socket: currentSocket,
      connections
    };
  } catch (err) {
    // Cleanup on error
    if (activeConn && !connections.includes(activeConn)) {
      try { activeConn.end(); } catch (cleanupErr) { console.warn('[SFTP Chain] Cleanup error:', cleanupErr.message); }
    }
    cleanupSocket(currentSocket);
    for (const conn of connections) {
      try { conn.end(); } catch (cleanupErr) { console.warn('[SFTP Chain] Cleanup error:', cleanupErr.message); }
    }
    throw err;
  }
}

/**
 * Establish an SFTP connection using sudo
 * @param {SSHClient} client - Connected SSH client
 * @param {string} password - User password for sudo
 */
async function connectSudoSftp(client, password) {
  if (!SFTPWrapper) {
    throw new Error("SFTP sudo mode is not available on this platform. Please disable sudo mode in host settings.");
  }

  // Known sftp-server paths to try
  const sftpPaths = [
    "/usr/lib/openssh/sftp-server",
    "/usr/libexec/openssh/sftp-server",
    "/usr/lib/ssh/sftp-server",
    "/usr/libexec/sftp-server",
    "/usr/local/libexec/sftp-server",
    "/usr/local/lib/sftp-server"
  ];

  console.log("[SFTP] Probing sftp-server path for sudo mode...");

  let serverPath = null;
  // Try to find the path
  for (const p of sftpPaths) {
    try {
      await new Promise((resolve, reject) => {
        client.exec(`test -x ${p}`, (err, stream) => {
          if (err) return reject(err);
          stream.on('exit', (code) => {
            if (code === 0) resolve();
            else reject(new Error('Not found'));
          });
        });
      });
      serverPath = p;
      break;
    } catch (e) {
      // Continue probing
    }
  }

  if (!serverPath) {
    // Fallback: try to find it in path or assume standard location
    console.warn("[SFTP] Could not probe sftp-server, trying default /usr/lib/openssh/sftp-server");
    serverPath = "/usr/lib/openssh/sftp-server";
  } else {
    console.log(`[SFTP] Found sftp-server at ${serverPath}`);
  }

  return new Promise((resolve, reject) => {
    // Use sudo -S to read password from stdin
    // Use -p '' to set a specific prompt we can detect
    // Use sh -c 'printf SFTPREADY; exec ...' to synchronize the start of sftp-server
    // We use printf instead of echo to avoid trailing newline which could confuse SFTPWrapper
    const prompt = "SUDOPASSWORD:";
    const readyMarker = "SFTPREADY";
    const readyMarkerBuffer = Buffer.from(readyMarker);
    // Add -e to sftp-server to log to stderr for debugging
    const cmd = `sudo -S -p '${prompt}' sh -c 'printf ${readyMarker}; exec ${serverPath} -e'`;

    console.log(`[SFTP] Executing sudo command: ${cmd}`);

    // Disable pty to ensure clean binary stream for SFTP
    client.exec(cmd, { pty: false }, (err, stream) => {
      if (err) return reject(err);

      // Add stream lifecycle logging
      stream.on('close', () => console.log("[SFTP] Stream closed"));
      stream.on('end', () => console.log("[SFTP] Stream ended"));
      stream.on('error', (e) => console.error("[SFTP] Stream error:", e.message));

      let sftpInitialized = false;
      let sftp = null;
      let settled = false;
      let stdoutBuffer = Buffer.alloc(0);
      let stderrBuffer = "";
      let pendingAfterMarker = null;
      let sftpCreated = false;
      const timeoutMs = 20000;
      const timeoutId = setTimeout(() => {
        if (sftpInitialized || settled) return;
        settled = true;
        stream.stderr?.removeListener('data', onStderr);
        stream.removeListener('data', onStdout);
        const error = new Error("SFTP sudo handshake timed out. This may happen if: (1) the password is incorrect, (2) sudo requires a TTY, or (3) the user does not have sudo privileges.");
        reject(error);
      }, timeoutMs);

      const finalize = (err, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        stream.stderr?.removeListener('data', onStderr);
        stream.removeListener('data', onStdout);
        if (err) reject(err);
        else resolve(result);
      };

      const createSftp = () => {
        if (sftpCreated) return;
        sftpCreated = true;
        try {
          const chanInfo = {
            type: 'sftp',
            incoming: stream.incoming,
            outgoing: stream.outgoing
          };
          sftp = new SFTPWrapper(client, chanInfo, {
            // debug: (str) => console.log(`[SFTP DEBUG] ${str}`)
          });

          // Route any remaining channel data directly into the SFTP parser
          if (client._chanMgr && typeof stream.incoming?.id === "number") {
            client._chanMgr.update(stream.incoming.id, sftp);
          }

          sftp.on('ready', () => {
            sftpInitialized = true;
            console.log("[SFTP] Protocol ready");
            finalize(null, sftp);
          });

          sftp.on('error', (err) => {
            console.error("[SFTP] Protocol error:", err.message);
            if (!sftpInitialized) {
              finalize(err);
            }
          });

          stream.on('end', () => {
            try { sftp.push(null); } catch { }
          });
        } catch (e) {
          console.error("[SFTP] Initialization failed:", e.message);
          finalize(e);
        }
      };

      const initSftp = () => {
        if (sftpInitialized) return;
        console.log("[SFTP] Sudo success, initializing SFTP protocol...");
        if (!sftpCreated) createSftp();
        try {
          // Start the handshake
          console.log("[SFTP] Sending INIT packet...");
          sftp._init();
          if (pendingAfterMarker && pendingAfterMarker.length > 0) {
            try {
              sftp.push(pendingAfterMarker);
            } catch (pushErr) {
              console.warn("[SFTP] Failed to push buffered data:", pushErr.message);
            }
            pendingAfterMarker = null;
          }
        } catch (e) {
          console.error("[SFTP] Initialization failed:", e.message);
          finalize(e);
        }
      };

      const onStdout = (data) => {
        const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
        stdoutBuffer = stdoutBuffer.length > 0 ? Buffer.concat([stdoutBuffer, chunk]) : chunk;
        const markerIndex = stdoutBuffer.indexOf(readyMarkerBuffer);
        if (markerIndex !== -1) {
          const afterMarkerIndex = markerIndex + readyMarkerBuffer.length;
          if (afterMarkerIndex < stdoutBuffer.length) {
            pendingAfterMarker = stdoutBuffer.subarray(afterMarkerIndex);
          }
          // Found marker, stop listening to stdout here so SFTPWrapper can take over
          stream.removeListener('data', onStdout);
          stdoutBuffer = Buffer.alloc(0);

          console.log("[SFTP] SFTPREADY detected, waiting for stream to stabilize...");

          // Delay SFTP initialization to ensure sftp-server is fully started and stream is clean
          // Increased timeout to 1000ms to be safe
          setTimeout(() => {
            initSftp();
          }, 1000);
        } else if (stdoutBuffer.length > 256) {
          stdoutBuffer = stdoutBuffer.subarray(stdoutBuffer.length - 256);
        }
      };

      const onStderr = (data) => {
        const chunk = data.toString();
        // Only log that we received stderr data, not the content (may contain sensitive prompts)
        stderrBuffer += chunk;
        if (stderrBuffer.includes(prompt)) {
          console.log("[SFTP] Sudo requested password, sending...");
          // Send password
          if (password) {
            stream.write(password + '\n');
          } else {
            console.warn('[SFTP] sudo requested password but none provided');
            stream.write('\n');
          }
          stderrBuffer = "";
        } else if (stderrBuffer.length > 256) {
          stderrBuffer = stderrBuffer.slice(-256);
        }
      };

      stream.on('data', onStdout);
      stream.stderr.on('data', onStderr);

      // Error handling
      stream.on('exit', (code) => {
        console.log(`[SFTP] Stream exited with code ${code}`);
        if (!sftpInitialized && code !== 0) {
          let errorMsg = `SFTP sudo failed with exit code ${code}.`;
          if (code === 1) {
            errorMsg += " The password may be incorrect or sudo privileges are denied.";
          } else if (code === 127) {
            errorMsg += " sftp-server was not found on the remote system.";
          }
          const error = new Error(errorMsg);
          finalize(error);
        }
      });
    });
  });
}

/**
 * Open a new SFTP connection
 * Supports jump host connections when options.jumpHosts is provided
 */
async function openSftp(event, options) {
  const client = new SftpClient();
  const connId = options.sessionId || randomUUID();

  // Get default keys early to use for both chain and target
  const defaultKeys = await findAllDefaultPrivateKeysFromHelper();

  // Check if we need to connect through jump hosts
  const jumpHosts = options.jumpHosts || [];
  const hasJumpHosts = jumpHosts.length > 0;
  const hasProxy = !!options.proxy;

  let chainConnections = [];
  let connectionSocket = null;
  const cleanupPendingConnection = () => {
    for (const conn of chainConnections) {
      try { conn.end(); } catch (cleanupErr) { console.warn('[SFTP] Cleanup error on connect failure:', cleanupErr.message); }
    }
    if (connectionSocket) {
      try { connectionSocket.end?.(); } catch { /* ignore */ }
      try { connectionSocket.destroy?.(); } catch { /* ignore */ }
    }
  };

  // Pre-fetch agent socket (async check for Windows SSH Agent service)
  // This is used by both jump host chain auth and final host auth
  const agentSocket = await getAvailableAgentSocket();

  // Handle chain/proxy connections
  if (hasJumpHosts) {
    console.log(`[SFTP] Opening connection through ${jumpHosts.length} jump host(s) to ${options.hostname}:${options.port || 22}`);

    // Pass default keys to chain connection
    options._defaultKeys = defaultKeys;

    const chainResult = await connectThroughChainForSftp(
      event,
      options,
      jumpHosts,
      options.hostname,
      options.port || 22,
      connId,
      agentSocket
    );
    connectionSocket = chainResult.socket;
    chainConnections = chainResult.connections;
  } else if (hasProxy) {
    console.log(`[SFTP] Opening connection through proxy to ${options.hostname}:${options.port || 22}`);
    connectionSocket = await createProxySocket(
      options.proxy,
      options.hostname,
      options.port || 22
    );
  }

  const connectOpts = {
    host: options.hostname,
    port: options.port || 22,
    username: options.username || "root",
    // Enable keyboard-interactive authentication (required for 2FA/MFA)
    tryKeyboard: true,
    readyTimeout: 120000, // 2 minutes for 2FA input
    // Keepalive policy:
    //   - positive value: honor it (in seconds, convert to ms)
    //   - explicit 0: truly disabled (host opted out via per-host override —
    //     critical for routers/switches that don't reply to keepalive
    //     @openssh.com and would otherwise be killed by ssh2 after countMax
    //     unanswered probes)
    //   - undefined: legacy caller path, fall back to 10s/3 so an idle SFTP
    //     browse over a NAT doesn't drop (the original #669 protection)
    keepaliveInterval: options.keepaliveInterval == null
      ? 10000
      : (options.keepaliveInterval > 0 ? options.keepaliveInterval * 1000 : 0),
    keepaliveCountMax: options.keepaliveInterval == null
      ? 3
      : (options.keepaliveInterval > 0 ? (options.keepaliveCountMax ?? 3) : 0),
    algorithms: buildSftpAlgorithms(options.legacyAlgorithms),
  };

  // Use the tunneled socket if we have one
  if (connectionSocket) {
    connectOpts.sock = connectionSocket;
    // When using sock, we should not set host/port as the connection is already established
    delete connectOpts.host;
    delete connectOpts.port;
  }

  const hasCertificate = typeof options.certificate === "string" && options.certificate.trim().length > 0;

  let identityFile = null;
  let inlineKey = null;
  try {
    identityFile = !options.privateKey
      ? await loadFirstIdentityFileForAuth({
        sender: event.sender,
        identityFilePaths: options.identityFilePaths,
        hostname: options.hostname,
        initialPassphrase: options.passphrase,
        logPrefix: "[SFTP]",
        onLoaded: (loaded) => {
          console.log(`[SFTP] Loaded identity file ${loaded.keyPath}`);
        },
        onError: (err, keyPath) => {
          console.warn(`[SFTP] Failed to read identity file ${keyPath}:`, err.message);
        },
      })
      : null;
    inlineKey = options.privateKey
      ? await preparePrivateKeyForAuth({
        sender: event.sender,
        privateKey: options.privateKey,
        keyId: options.keyId,
        keyName: options.keyId || options.username,
        hostname: options.hostname,
        initialPassphrase: options.passphrase,
        logPrefix: "[SFTP]",
      })
      : null;
  } catch (err) {
    cleanupPendingConnection();
    throw err;
  }
  const effectivePrivateKey = inlineKey?.privateKey || identityFile?.privateKey;
  const effectivePassphrase = inlineKey?.passphrase || identityFile?.passphrase;

  let authAgent = null;
  if (hasCertificate) {
    authAgent = new NetcattyAgent({
      mode: "certificate",
      webContents: event.sender,
      meta: {
        label: options.keyId || options.username || "",
        certificate: options.certificate,
        privateKey: effectivePrivateKey,
        passphrase: effectivePassphrase,
      },
    });
    connectOpts.agent = authAgent;
  } else if (effectivePrivateKey) {
    connectOpts.privateKey = effectivePrivateKey;
    if (effectivePassphrase) {
      connectOpts.passphrase = effectivePassphrase;
    } else if (options.privateKey && isKeyEncrypted(options.privateKey)) {
      // Key is encrypted but no passphrase provided — prompt the user
      console.log(`[SFTP] Key is encrypted, requesting passphrase for ${options.hostname}`);
      const result = await passphraseHandler.requestPassphrase(
        event.sender,
        `SSH key for ${options.hostname}`,
        options.hostname,
        options.hostname
      );
      if (result?.passphrase) {
        connectOpts.passphrase = result.passphrase;
      } else {
        delete connectOpts.privateKey;
        if (result?.cancelled) {
          // Clean up any chain/proxy connections and proxy socket opened earlier
          for (const c of chainConnections) {
            try { c.end(); } catch {}
          }
          if (connectionSocket) {
            try { connectionSocket.destroy(); } catch {}
          }
          // Use "authentication" in the message so the SFTP frontend's
          // isAuthError() check recognizes this and falls back to password.
          const err = new Error(`Authentication cancelled — passphrase not provided for ${options.hostname}`);
          err.level = 'client-authentication';
          throw err;
        }
      }
    }
  }

  if (options.password) connectOpts.password = options.password;

  // Build auth handler using shared helper
  // Use pre-fetched agentSocket (validated async, including Windows service check)
  const authConfig = buildAuthHandler({
    privateKey: connectOpts.privateKey,
    password: connectOpts.password,
    passphrase: connectOpts.passphrase,
    agent: connectOpts.agent,
    username: connectOpts.username,
    logPrefix: "[SFTP]",
    defaultKeys,
    sshAgentSocketOverride: agentSocket,
    onAuthAttempt: (method) => {
      sendSftpProgress(event.sender, connId, options.hostname, 'auth-attempt', method);
    },
  });
  applyAuthToConnOpts(connectOpts, authConfig);

  // Create keyboard-interactive handler using shared helper
  const kiHandler = createKeyboardInteractiveHandler({
    sender: event.sender,
    sessionId: connId,
    hostname: options.hostname,
    password: options.password,
    logPrefix: "[SFTP]",
  });

  // Add keyboard-interactive listener BEFORE connecting
  // Wrap to emit progress events for the SFTP connection log
  client.on("keyboard-interactive", (name, instructions, lang, prompts, finish) => {
    if (prompts && prompts.length > 0) {
      sendSftpProgress(event.sender, connId, options.hostname, 'auth-attempt', 'waiting for user input...');
    }
    const wrappedFinish = (...args) => {
      sendSftpProgress(event.sender, connId, options.hostname, 'auth-attempt', 'user responded');
      finish(...args);
    };
    kiHandler(name, instructions, lang, prompts, wrappedFinish);
  });

  // Increase timeout to allow for keyboard-interactive auth
  connectOpts.readyTimeout = 120000; // 2 minutes for 2FA input

  try {
    // IMPORTANT: We bypass ssh2-sftp-client's connect() method and use the
    // underlying ssh2 Client directly. This is because ssh2-sftp-client adds
    // temporary error listeners that reject the entire connect promise on ANY
    // error, including non-fatal auth errors (e.g. 'Failed to connect to agent'
    // when ssh2 tries agent auth and falls through to the next method).
    // By connecting directly, we can filter these non-fatal errors and allow
    // the auth flow to continue to keyboard-interactive/password/etc.
    const sshClient = client.client;

    await new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn, val) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn(val);
      };

      const onError = (err) => {
        // Filter out non-fatal authentication errors.
        // ssh2 sets err.level = 'agent' when agent auth fails — it then
        // internally calls tryNextAuth() to proceed with the next method.
        // We must NOT reject here, or the fallback won't execute.
        if (err.level === 'agent') {
          console.log('[SFTP] Non-fatal agent auth error (will try next method):', err.message);
          return;
        }
        settle(reject, err);
      };

      const onEnd = () => {
        settle(reject, new Error('Connection closed before SFTP session was ready'));
      };

      const onClose = () => {
        settle(reject, new Error('Connection closed before SFTP session was ready'));
      };

      const cleanup = () => {
        sshClient.removeListener('error', onError);
        sshClient.removeListener('end', onEnd);
        sshClient.removeListener('close', onClose);
        // Keep a catch-all error listener so post-ready errors (e.g. connection
        // drops during an active SFTP session) don't become uncaught exceptions.
        sshClient.on('error', (err) => {
          console.error(`[SFTP] Post-ready SSH error for ${connId}:`, err.message);
        });
      };

      sshClient.on('error', onError);
      sshClient.on('end', onEnd);
      sshClient.on('close', onClose);

      sshClient.once('handshake', () => {
        sendSftpProgress(event.sender, connId, options.hostname, 'authenticating');
      });

      sshClient.once('ready', () => {
        cleanup();
        sendSftpProgress(event.sender, connId, options.hostname, 'connected');

        if (options.sudo) {
          console.log(`[SFTP] Using sudo mode for connection: ${connId}`);
          (async () => {
            try {
              const sudoPass = options.password || "";
              const sftpWrapper = await connectSudoSftp(sshClient, sudoPass);
              client.sftp = sftpWrapper;
              client.sftp.on('close', () => client.end());
              resolve();
            } catch (e) {
              // Fallback: if sftp-server binary is missing (exit code 127),
              // try standard SFTP subsystem instead of failing completely.
              // This handles systems like ESXi that don't have sftp-server
              // but support the SFTP subsystem natively.
              if (e.message && e.message.includes('exit code 127')) {
                console.warn('[SFTP] sftp-server not found, falling back to standard SFTP subsystem');
                options.sudo = false; // Mark as non-sudo for downstream logic
                sshClient.sftp((sftpErr, sftp) => {
                  if (sftpErr) {
                    sshClient.end();
                    return reject(sftpErr);
                  }
                  client.sftp = sftp;
                  resolve();
                });
              } else {
                sshClient.end();
                reject(e);
              }
            }
          })();
        } else {
          // Open standard SFTP subsystem channel
          sshClient.sftp((err, sftp) => {
            if (err) return reject(err);
            client.sftp = sftp;
            resolve();
          });
        }
      });

      sendSftpProgress(event.sender, connId, options.hostname, 'connecting');
      try {
        sshClient.connect(connectOpts);
      } catch (e) {
        settle(reject, e);
      }
    });
    // Increase max listeners AFTER connect, when the internal ssh2 Client exists
    // This prevents Node.js MaxListenersExceededWarning when performing many operations
    // ssh2-sftp-client adds temporary listeners for each operation, so we need a high limit
    if (client.client && typeof client.client.setMaxListeners === 'function') {
      client.client.setMaxListeners(0); // 0 means unlimited
    }

    // Used by transferBridge to decide whether isolated fast-transfer channels are safe.
    client.__netcattySudoMode = !!options.sudo;
    sftpClients.set(connId, client);

    // Store jump connections for cleanup when SFTP is closed
    if (chainConnections.length > 0) {
      jumpConnectionsMap.set(connId, {
        connections: chainConnections,
        socket: connectionSocket
      });
    }

    console.log(`[SFTP] Connection established: ${connId}`);
    return { sftpId: connId };
  } catch (err) {
    // Cleanup jump connections on error
    cleanupPendingConnection();
    throw err;
  }
}

/**
 * List files in a directory
 * Properly handles symlinks by resolving their target type
 */
async function listSftp(event, payload) {
  const client = sftpClients.get(payload.sftpId);
  if (!client) throw new Error("SFTP session not found");

  const requestedEncoding = normalizeEncoding(payload.encoding);
  const basePath = payload.path || ".";
  const pathEncoding = resolveEncodingForRequest(payload.sftpId, requestedEncoding);
  const encodedPath = encodePath(basePath, pathEncoding);

  const sftp = await requireSftpChannel(client);

  let list;
  try {
    list = await new Promise((resolve, reject) => {
      sftp.readdir(encodedPath, (err, items) => {
        if (err) return reject(err);
        resolve(items || []);
      });
    });
  } catch (err) {
    // Retry with string path when ASCII-only and a Buffer path caused issues
    if (Buffer.isBuffer(encodedPath) && isAsciiString(basePath)) {
      console.warn("[SFTP] Retrying readdir with string path after Buffer failure", {
        basePath,
        error: err?.message || String(err),
      });
      list = await new Promise((resolve, reject) => {
        sftp.readdir(basePath, (retryErr, items) => {
          if (retryErr) return reject(retryErr);
          resolve(items || []);
        });
      });
    } else {
      throw err;
    }
  }

  // When auto mode, try to detect encoding from list
  // If detection returns null (empty list or can't prove non-UTF-8), preserve the previous encoding
  let detectedEncoding;
  if (requestedEncoding === "auto") {
    const detected = detectEncodingFromList(list);
    if (detected) {
      // Definitive detection (e.g., found GB18030 bytes)
      detectedEncoding = detected;
    } else {
      // Can't detect - preserve existing session encoding
      const existing = sftpEncodingState.get(payload.sftpId);
      detectedEncoding = existing?.resolved || "utf-8";
    }
  } else {
    detectedEncoding = requestedEncoding;
  }
  const resolvedEncoding = updateResolvedEncoding(payload.sftpId, requestedEncoding, detectedEncoding);

  // Process items and resolve symlinks
  const results = await Promise.all(list.map(async (item) => {
    const filenameRaw = item.filenameRaw || (item.filename ? Buffer.from(item.filename, "utf8") : null);
    const longnameRaw = item.longnameRaw || (item.longname ? Buffer.from(item.longname, "utf8") : null);
    const name = decodeName(filenameRaw, resolvedEncoding) || item.filename || "";
    const longname = decodeName(longnameRaw, resolvedEncoding) || item.longname || "";

    let type;
    let linkTarget = null;

    if (item.attrs?.isDirectory?.()) {
      type = "directory";
    } else if (item.attrs?.isSymbolicLink?.()) {
      // This is a symlink - try to resolve its target type
      type = "symlink";
      try {
        // Use path.posix.join to properly construct the path and avoid double slashes
        const fullPath = path.posix.join(basePath === "." ? "/" : basePath, name);
        const encodedFullPath = encodePath(fullPath, resolvedEncoding);
        const stat = await client.stat(encodedFullPath);
        // stat follows symlinks, so we get the target's type
        if (stat.isDirectory) {
          linkTarget = "directory";
        } else {
          linkTarget = "file";
        }
      } catch (err) {
        // If we can't stat the symlink target (broken link), keep it as symlink
        console.warn(`Could not resolve symlink target for ${item.name}:`, err.message);
      }
    } else {
      type = "file";
    }

    const modeToPermissions = (mode) => {
      if (typeof mode !== "number") return undefined;
      const toTriplet = (bits) =>
        `${bits & 4 ? "r" : "-"}${bits & 2 ? "w" : "-"}${bits & 1 ? "x" : "-"}`;
      return `${toTriplet((mode >> 6) & 7)}${toTriplet((mode >> 3) & 7)}${toTriplet(mode & 7)}`;
    };

    // Extract permissions from longname or attrs.mode
    let permissions = undefined;
    if (longname) {
      // Fallback: parse from longname (e.g., "-rwxr-xr-x 1 root root ...")
      const match = longname.match(/^[dlsbc-]([rwxsStT-]{9})/);
      if (match) {
        permissions = match[1];
      }
    }
    if (!permissions && item.attrs?.mode) {
      permissions = modeToPermissions(item.attrs.mode);
    }

    const modifyTime = item.attrs?.mtime ? item.attrs.mtime * 1000 : Date.now();
    return {
      name,
      type,
      linkTarget,
      size: `${item.attrs?.size || 0} bytes`,
      lastModified: new Date(modifyTime).toISOString(),
      permissions,
    };
  }));

  return results;
}

/**
 * Read file content
 */
async function readSftp(event, payload) {
  const client = sftpClients.get(payload.sftpId);
  if (!client) throw new Error("SFTP session not found");

  await requireSftpChannel(client);
  const encoding = resolveEncodingForRequest(payload.sftpId, payload.encoding);
  const encodedPath = encodePath(payload.path, encoding);
  const buffer = await client.get(encodedPath);
  return buffer.toString();
}

/**
 * Read file as binary (returns ArrayBuffer for binary files like images)
 */
async function readSftpBinary(event, payload) {
  const client = sftpClients.get(payload.sftpId);
  if (!client) throw new Error("SFTP session not found");

  await requireSftpChannel(client);
  const encoding = resolveEncodingForRequest(payload.sftpId, payload.encoding);
  const encodedPath = encodePath(payload.path, encoding);
  const buffer = await client.get(encodedPath);
  // Convert Node.js Buffer to ArrayBuffer
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

/**
 * Write file content.
 *
 * If the target file already exists, its mode is preserved — ssh2-sftp-client's
 * `put()` otherwise overwrites existing files with the server's default mode
 * (typically 0o666 after umask), which would silently change permissions on
 * files edited through the built-in text editor.
 */
async function writeSftp(event, payload) {
  const client = sftpClients.get(payload.sftpId);
  if (!client) throw new Error("SFTP session not found");

  await requireSftpChannel(client);
  const encoding = resolveEncodingForRequest(payload.sftpId, payload.encoding);
  const encodedPath = encodePath(payload.path, encoding);

  let existingMode = null;
  try {
    const stat = await client.stat(encodedPath);
    if (typeof stat.mode === "number") {
      // Mask with 0o7777 so special bits (setuid/setgid/sticky) are preserved too.
      existingMode = stat.mode & 0o7777;
    }
  } catch (_err) {
    // File does not exist — treat as a new file and let the server apply defaults.
  }

  // Normalize CRLF → LF so scripts edited on Windows don't break when
  // saved to a Linux/macOS host. LF is universally supported (Windows
  // 10+ notepad handles it), while CRLF in shell scripts causes
  // "command not found" and syntax errors on Linux.
  const normalized = payload.content.replace(/\r\n/g, '\n');
  await client.put(Buffer.from(normalized, "utf-8"), encodedPath);

  if (existingMode !== null) {
    try {
      await client.chmod(encodedPath, existingMode);
    } catch (err) {
      console.warn(
        `[sftp] Failed to restore permissions on ${payload.path}:`,
        err && err.message ? err.message : err,
      );
    }
  }

  return true;
}

/**
 * Write binary data
 */
async function writeSftpBinary(event, payload) {
  const client = sftpClients.get(payload.sftpId);
  if (!client) throw new Error("SFTP session not found");

  await requireSftpChannel(client);
  const encoding = resolveEncodingForRequest(payload.sftpId, payload.encoding);
  const encodedPath = encodePath(payload.path, encoding);
  await client.put(Buffer.from(payload.content), encodedPath);
  return true;
}

/**
 * Write binary data with progress callback
 * Supports cancellation via activeSftpUploads map
 * Optimized for performance with throttled progress updates
 */
async function writeSftpBinaryWithProgress(event, payload) {
  const client = sftpClients.get(payload.sftpId);
  if (!client) throw new Error("SFTP session not found");

  const { sftpId, path: remotePath, content, transferId } = payload;
  await requireSftpChannel(client);
  const encoding = resolveEncodingForRequest(payload.sftpId, payload.encoding);
  const encodedPath = encodePath(remotePath, encoding);

  // Extract callback functions from payload
  const onProgress = payload.onProgress;
  const onComplete = payload.onComplete;
  const onError = payload.onError;

  // Optimize: Use Buffer.isBuffer to avoid unnecessary copy if already a Buffer
  // For ArrayBuffer from renderer, we still need to convert but use a more efficient method
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const totalBytes = buffer.length;
  let transferredBytes = 0;
  let lastProgressTime = Date.now();
  let lastTransferredBytes = 0;
  let lastProgressSentTime = 0;

  // Throttle settings: send progress at most every 100ms or every 1MB
  const PROGRESS_THROTTLE_MS = 100;
  const PROGRESS_THROTTLE_BYTES = 1024 * 1024; // 1MB
  let lastProgressSentBytes = 0;

  const { Readable } = require("stream");
  const readableStream = new Readable({
    read() {
      // Check for cancellation
      const uploadState = activeSftpUploads.get(transferId);
      if (uploadState?.cancelled) {
        this.destroy(new Error("Upload cancelled"));
        return;
      }

      // Use larger chunk size for better performance (256KB instead of 64KB)
      const chunkSize = 262144;
      if (transferredBytes < totalBytes) {
        const end = Math.min(transferredBytes + chunkSize, totalBytes);
        // Use subarray instead of slice to avoid copying
        const chunk = buffer.subarray(transferredBytes, end);
        transferredBytes = end;

        const now = Date.now();
        const elapsed = (now - lastProgressTime) / 1000;
        let speed = 0;
        if (elapsed >= 0.1) {
          speed = (transferredBytes - lastTransferredBytes) / elapsed;
          lastProgressTime = now;
          lastTransferredBytes = transferredBytes;
        }

        // Throttle IPC progress events: only send if enough time or bytes have passed
        const timeSinceLastProgress = now - lastProgressSentTime;
        const bytesSinceLastProgress = transferredBytes - lastProgressSentBytes;
        const isComplete = transferredBytes >= totalBytes;

        if (isComplete || timeSinceLastProgress >= PROGRESS_THROTTLE_MS || bytesSinceLastProgress >= PROGRESS_THROTTLE_BYTES) {
          // Call the progress callback if provided, otherwise send IPC event
          if (typeof onProgress === 'function') {
            try {
              onProgress(transferredBytes, totalBytes, speed);
            } catch (err) {
              console.warn('[SFTP] Progress callback error:', err);
            }
          } else {
            const contents = electronModule.webContents.fromId(event.sender.id);
            contents?.send("netcatty:upload:progress", {
              transferId,
              transferred: transferredBytes,
              totalBytes,
              speed,
            });
          }
          lastProgressSentTime = now;
          lastProgressSentBytes = transferredBytes;
        }

        this.push(chunk);
      } else {
        this.push(null);
      }
    }
  });

  // Register this upload for potential cancellation
  activeSftpUploads.set(transferId, { cancelled: false, stream: readableStream });

  try {
    await client.put(readableStream, encodedPath);

    // Call the complete callback if provided, otherwise send IPC event
    if (typeof onComplete === 'function') {
      try {
        onComplete();
      } catch (err) {
        console.warn('[SFTP] Complete callback error:', err);
      }
    } else {
      const contents = electronModule.webContents.fromId(event.sender.id);
      contents?.send("netcatty:upload:complete", { transferId });
    }

    return { success: true, transferId };
  } catch (err) {
    // Check if this upload was cancelled - the error might not be exactly "Upload cancelled"
    // when stream is destroyed, SFTP server may return different errors like "Write stream error"
    const uploadState = activeSftpUploads.get(transferId);
    if (uploadState?.cancelled || err.message === "Upload cancelled") {
      const contents = electronModule.webContents.fromId(event.sender.id);
      contents?.send("netcatty:upload:cancelled", { transferId });
      return { success: false, transferId, cancelled: true };
    }

    // Call the error callback if provided, otherwise send IPC event
    if (typeof onError === 'function') {
      try {
        onError(err.message);
      } catch (callbackErr) {
        console.warn('[SFTP] Error callback error:', callbackErr);
      }
    } else {
      const contents = electronModule.webContents.fromId(event.sender.id);
      contents?.send("netcatty:upload:error", { transferId, error: err.message });
    }
    throw err;
  } finally {
    // Cleanup
    activeSftpUploads.delete(transferId);
  }
}

/**
 * Cancel an in-progress SFTP upload
 * Note: We only set the cancelled flag and destroy the stream here.
 * The cleanup (deleting from activeSftpUploads) is handled by writeSftpBinaryWithProgress's finally block
 * to avoid race conditions.
 */
async function cancelSftpUpload(event, payload) {
  const { transferId } = payload;
  const uploadState = activeSftpUploads.get(transferId);
  if (uploadState) {
    uploadState.cancelled = true;
    try {
      uploadState.stream?.destroy();
    } catch (err) {
      // Log but continue - stream may already be destroyed
      console.warn("[SFTP] Error destroying upload stream:", err.message);
    }
    // Don't delete here - let the finally block in writeSftpBinaryWithProgress handle cleanup
    // This avoids race conditions where the upload might still be in progress
  }
  return { success: true };
}

/**
 * Close an SFTP connection
 * Also cleans up any jump host connections and file watchers if present
 */
async function closeSftp(event, payload) {
  const client = sftpClients.get(payload.sftpId);
  if (!client) return;

  // Stop file watchers and clean up temp files for this SFTP session
  try {
    fileWatcherBridge.stopWatchersForSession(payload.sftpId, true);
  } catch (err) {
    console.warn("[SFTP] Error stopping file watchers:", err.message);
  }

  try {
    await client.end();
  } catch (err) {
    console.warn("SFTP close failed", err);
  }
  copySftpEncodingState(payload?.sftpId, payload?.encodingStateKey);
  sftpClients.delete(payload.sftpId);
  clearSftpEncodingState(payload.sftpId);

  // Clean up jump connections if any
  const jumpData = jumpConnectionsMap.get(payload.sftpId);
  if (jumpData) {
    for (const conn of jumpData.connections) {
      try { conn.end(); } catch (cleanupErr) { console.warn('[SFTP] Cleanup error on close:', cleanupErr.message); }
    }
    jumpConnectionsMap.delete(payload.sftpId);
    console.log(`[SFTP] Cleaned up ${jumpData.connections.length} jump connection(s) for ${payload.sftpId}`);
  }
}

/**
 * Create a directory
 */
async function mkdirSftp(event, payload) {
  await ensureRemoteDirForSession(payload.sftpId, payload.path, payload.encoding);
  return true;
}

/**
 * Execute a command via SSH using the underlying ssh2 client
 * Returns { stdout, stderr, code }
 */
function execSshCommand(sshClient, command) {
  return new Promise((resolve, reject) => {
    sshClient.exec(command, (err, stream) => {
      if (err) {
        return reject(err);
      }

      let stdout = '';
      let stderr = '';

      stream.on('close', (code) => {
        resolve({ stdout, stderr, code });
      });

      stream.on('data', (data) => {
        stdout += data.toString();
      });

      stream.stderr.on('data', (data) => {
        stderr += data.toString();
      });
    });
  });
}

/**
 * Delete a file or directory
 * For directories, uses SSH exec with 'rm -rf' for much faster deletion
 */
async function deleteSftp(event, payload) {
  const client = sftpClients.get(payload.sftpId);
  if (!client) throw new Error("SFTP session not found");

  const signal = payload?.abortSignal || null;
  const encoding = resolveEncodingForRequest(payload.sftpId, payload.encoding);
  const shouldUseFastDirectoryDelete = (
    encoding === "utf-8" &&
    !client.__netcattySessionBacked &&
    !signal &&
    !(Number.isFinite(payload?.timeoutMs) && payload.timeoutMs > 0)
  );

  if (encoding === "utf-8") {
    throwIfAborted(signal);
    const sftp = await requireSftpChannel(client, { signal, timeoutMs: payload?.timeoutMs });
    const encodedPath = encodePath(payload.path, encoding);
    const stat = statResultFromAttrs(await statAsync(sftp, encodedPath));
    throwIfAborted(signal);
    if (stat.isDirectory) {
      if (shouldUseFastDirectoryDelete) {
        // Keep the SSH rm -rf fast path only for ordinary UI SFTP sessions.
        // Session-backed / stop-sensitive flows must stay on the abort-aware
        // recursive SFTP path so ACP Stop and command timeouts can interrupt
        // large directory deletes promptly.
        const sshClient = client.client;
        if (sshClient && typeof sshClient.exec === 'function') {
          try {
            // Escape path for shell - wrap in single quotes and escape any single quotes in the path
            const escapedPath = payload.path.replace(/'/g, "'\\''");
            const command = `rm -rf '${escapedPath}'`;
            console.log(`[SFTP] Using SSH exec for fast directory deletion: ${command}`);

            const result = await execSshCommand(sshClient, command);

            if (result.code !== 0) {
              console.warn(`[SFTP] rm -rf returned code ${result.code}: ${result.stderr}`);
              // Fall back to SFTP rmdir if rm -rf fails (e.g., permission denied)
              await client.rmdir(encodedPath, true);
            }
            return true;
          } catch (execErr) {
            console.warn('[SFTP] SSH exec failed, falling back to SFTP rmdir:', execErr.message);
            // Fall back to slow SFTP rmdir
            await client.rmdir(encodedPath, true);
            return true;
          }
        }
      }
      if (client.__netcattySessionBacked) {
        await client.rmdir(encodedPath, true, { signal });
      } else {
        const normalizedPath = await normalizeRemotePathString(client, payload.path);
        throwIfAborted(signal);
        await removeRemotePathInternal(sftp, normalizedPath, encoding, signal);
        throwIfAborted(signal);
      }
    } else {
      if (client.__netcattySessionBacked) {
        await client.delete(encodedPath, { signal });
      } else {
        throwIfAborted(signal);
        await unlinkAsync(sftp, encodedPath);
        throwIfAborted(signal);
      }
    }
    return true;
  }

  throwIfAborted(signal);
  const sftp = await requireSftpChannel(client, { signal, timeoutMs: payload?.timeoutMs });
  const normalizedPath = await normalizeRemotePathString(client, payload.path);
  throwIfAborted(signal);
  await removeRemotePathInternal(sftp, normalizedPath, encoding, signal);
  return true;
}

/**
 * Rename a file or directory
 */
async function renameSftp(event, payload) {
  const client = sftpClients.get(payload.sftpId);
  if (!client) throw new Error("SFTP session not found");

  await requireSftpChannel(client);
  const encoding = resolveEncodingForRequest(payload.sftpId, payload.encoding);
  const encodedOldPath = encodePath(payload.oldPath, encoding);
  const encodedNewPath = encodePath(payload.newPath, encoding);
  await client.rename(encodedOldPath, encodedNewPath);
  return true;
}

/**
 * Get file statistics
 */
async function statSftp(event, payload) {
  const client = sftpClients.get(payload.sftpId);
  if (!client) throw new Error("SFTP session not found");

  await requireSftpChannel(client);
  const encoding = resolveEncodingForRequest(payload.sftpId, payload.encoding);
  const encodedPath = encodePath(payload.path, encoding);
  const stat = await client.stat(encodedPath);
  return {
    name: path.basename(payload.path),
    type: stat.isDirectory ? "directory" : stat.isSymbolicLink ? "symlink" : "file",
    size: stat.size,
    lastModified: stat.modifyTime,
    permissions: stat.mode ? (stat.mode & 0o777).toString(8) : undefined,
  };
}

/**
 * Change file permissions
 */
async function chmodSftp(event, payload) {
  const client = sftpClients.get(payload.sftpId);
  if (!client) throw new Error("SFTP session not found");

  await requireSftpChannel(client);
  const encoding = resolveEncodingForRequest(payload.sftpId, payload.encoding);
  const encodedPath = encodePath(payload.path, encoding);
  await client.chmod(encodedPath, parseInt(payload.mode, 8));
  return true;
}

/**
 * Resolve the remote user's home directory.
 * Strategy: exec `echo ~` via SSH, fallback to SFTP realpath('.').
 */
async function getSftpHomeDir(_event, payload) {
  const { sftpId } = payload;
  const client = sftpClients.get(sftpId);
  if (!client) return { success: false, error: "SFTP session not found" };
  const signal = payload?.abortSignal || null;
  throwIfAborted(signal);

  // Method 1: SSH exec `echo ~` (with 5s timeout to avoid hanging on
  // hosts with blocking shell init scripts or forced commands)
  const sshClient = client.client;
  if (sshClient && typeof sshClient.exec === "function") {
    let execStream = null;
    try {
      const result = await new Promise((resolve, reject) => {
        let settled = false;
        let timer = null;
        const cleanup = () => {
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
          if (signal) {
            signal.removeEventListener("abort", onAbort);
          }
        };
        const closeExecStream = () => {
          try { execStream?.close?.(); } catch {}
          try { execStream?.destroy?.(); } catch {}
        };
        const finishResolve = (value) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(value);
        };
        const finishReject = (err) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(err);
        };
        const onAbort = () => {
          closeExecStream();
          finishReject(createAbortError(signal, "SFTP home probe was aborted"));
        };
        if (signal) {
          signal.addEventListener("abort", onAbort, { once: true });
        }
        timer = setTimeout(() => {
          closeExecStream();
          finishReject(new Error("SFTP home probe timed out after 5000ms"));
        }, 5000);
        sshClient.exec("echo ~", (err, stream) => {
          if (err) {
            finishReject(err);
            return;
          }
          if (settled) {
            try { stream?.close?.(); } catch {}
            try { stream?.destroy?.(); } catch {}
            return;
          }
          execStream = stream;
          let stdout = "";
          stream.once("error", finishReject);
          stream.on("close", (code) => finishResolve({ stdout, code }));
          stream.on("data", (data) => { stdout += data.toString(); });
          stream.stderr.on("data", () => {});
        });
      });
      throwIfAborted(signal);
      const home = result.stdout?.trim();
      if (home && home.startsWith("/")) {
        return { success: true, homeDir: home };
      }
    } catch (err) {
      // Timeout or error — kill the exec channel if still open
      try { execStream?.close?.(); } catch {}
      try { execStream?.destroy?.(); } catch {}
      if (signal?.aborted) {
        throw err;
      }
      // Fall through to SFTP realpath
    }
  }

  // Method 2: SFTP realpath('.') — skip if result is '/' for non-root users
  // because some SFTP servers start in '/' rather than the user's home
  try {
    const sftp = await requireSftpChannel(client, {
      signal,
      timeoutMs: payload?.timeoutMs,
    });
    throwIfAborted(signal);
    const absPath = await realpathAsync(sftp, ".");
    throwIfAborted(signal);
    if (absPath && absPath !== "/") {
      return { success: true, homeDir: absPath };
    }
  } catch (err) {
    if (signal?.aborted) {
      throw err;
    }
    // ignore
  }

  return { success: false, error: "Could not determine home directory" };
}

/**
 * Register IPC handlers for SFTP operations
 */
function registerHandlers(ipcMain) {
  ipcMain.handle("netcatty:sftp:open", openSftp);
  ipcMain.handle("netcatty:sftp:list", listSftp);
  ipcMain.handle("netcatty:sftp:read", readSftp);
  ipcMain.handle("netcatty:sftp:readBinary", readSftpBinary);
  ipcMain.handle("netcatty:sftp:write", writeSftp);
  ipcMain.handle("netcatty:sftp:writeBinary", writeSftpBinary);
  ipcMain.handle("netcatty:sftp:writeBinaryWithProgress", writeSftpBinaryWithProgress);
  ipcMain.handle("netcatty:sftp:cancelUpload", cancelSftpUpload);
  ipcMain.handle("netcatty:sftp:close", closeSftp);
  ipcMain.handle("netcatty:sftp:mkdir", mkdirSftp);
  ipcMain.handle("netcatty:sftp:delete", deleteSftp);
  ipcMain.handle("netcatty:sftp:rename", renameSftp);
  ipcMain.handle("netcatty:sftp:stat", statSftp);
  ipcMain.handle("netcatty:sftp:chmod", chmodSftp);
  ipcMain.handle("netcatty:sftp:homeDir", getSftpHomeDir);
}

/**
 * Get the SFTP clients map (for external access)
 */
function getSftpClients() {
  return sftpClients;
}

module.exports = {
  init,
  registerHandlers,
  getSftpClients,
  requireSftpChannel,
  encodePathForSession,
  ensureRemoteDirForSession,
  clearSftpEncodingState,
  clearSftpEncodingStateByPrefix,
  openSftpForSession,
  openSftp,
  listSftp,
  readSftp,
  readSftpBinary,
  writeSftp,
  writeSftpBinary,
  writeSftpBinaryWithProgress,
  cancelSftpUpload,
  downloadSftpToLocal,
  uploadLocalToSftp,
  closeSftp,
  mkdirSftp,
  deleteSftp,
  renameSftp,
  statSftp,
  chmodSftp,
  getSftpHomeDir,
  resolveEncodingForRequest,
};
