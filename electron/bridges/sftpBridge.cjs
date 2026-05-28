/**
 * SFTP Bridge - Handles SFTP connections and file operations
 * Extracted from main.cjs for single responsibility
 */

const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
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
const {
  buildSftpAlgorithms,
  _resetAlgorithmSupportCacheForTests,
} = require("./sshAlgorithms.cjs");

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
const { createOpenConnectionApi } = require("./sftpBridge/openConnection.cjs");
const openConnectionApi = createOpenConnectionApi({
  get sftpClients() { return sftpClients; },
  get sessions() { return sessions; },
  get electronModule() { return electronModule; },
  jumpConnectionsMap, SftpClient, SSHClient, NetcattyAgent, keyboardInteractiveHandler, passphraseHandler,
  fs, path, net, Buffer, process, console, setTimeout, clearTimeout,
  SFTPWrapper, createProxySocket, buildSftpAlgorithms, getAvailableAgentSocket,
  preparePrivateKeyForAuth, loadFirstIdentityFileForAuth, findAllDefaultPrivateKeysFromHelper,
  buildAuthHandler, applyAuthToConnOpts, createKeyboardInteractiveHandler, passphraseHandler,
  isKeyEncrypted, randomUUID,
  sendSftpProgress, safeSend, authSafeSend, copySftpEncodingState, clearSftpEncodingState, normalizeEncoding,
  resolveEncodingForRequest, updateResolvedEncoding, requireSftpChannel, realpathAsync,
  connectSudoSftp: undefined,
});
const { connectThroughChainForSftp, connectSudoSftp, openSftp } = openConnectionApi;
const { createFileOpsApi } = require("./sftpBridge/fileOps.cjs");
const fileOpsApi = createFileOpsApi({
  get sftpClients() { return sftpClients; },
  get electronModule() { return electronModule; },
  activeSftpUploads, fileWatcherBridge, fs, path, Buffer, console, setTimeout, clearTimeout,
  jumpConnectionsMap, sftpEncodingState, normalizeEncoding, isAsciiString,
  requireSftpChannel, resolveEncodingForRequest, updateResolvedEncoding, encodePath, decodeName,
  detectEncodingFromList, statResultFromAttrs, normalizeRemotePathString, collectReadable, writeToWritable,
  throwIfAborted, pipeStreams, ensureRemoteDirForSession, removeRemotePathInternal, renameRemotePath,
  realpathAsync, statAsync, readdirAsync, mkdirAsync, rmdirAsync, unlinkAsync, openFileAsync,
  writeFileChunkAsync, closeFileAsync, createAbortError, copySftpEncodingState, clearSftpEncodingState,
  safeSend, tempDirBridge, randomUUID,
});
const {
  listSftp,
  readSftp,
  readSftpBinary,
  writeSftp,
  writeSftpBinary,
  writeSftpBinaryWithProgress,
  cancelSftpUpload,
  closeSftp,
  mkdirSftp,
  execSshCommand,
  deleteSftp,
  renameSftp,
  statSftp,
  chmodSftp,
  getSftpHomeDir,
} = fileOpsApi;

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
  buildSftpAlgorithms,
  _resetAlgorithmSupportCacheForTests,
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
