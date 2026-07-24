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
require("./boringSslDhCompat.cjs").installBoringSslDhCompat();
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
const hostKeyVerifier = require("./hostKeyVerifier.cjs");
const tempDirBridge = require("./tempDirBridge.cjs");
const { createProxySocket } = require("./proxyUtils.cjs");
const {
  buildAuthHandler,
  createKeyboardInteractiveHandler,
  applyAuthToConnOpts,
  shouldSkipKiPasswordAutoFill,
  safeSend: authSafeSend,
  isKeyEncrypted,
  findAllDefaultPrivateKeys: findAllDefaultPrivateKeysFromHelper,
  getAvailableAgentSocket,
  prepareSystemSshAgentForAuth,
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
let reportOpenedSessionActivity = null;
const rendererSftpSourceSessions = new Map();

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

/** Resolve the effective filename encoding for a live SFTP/SCP session. */
const getResolvedFilenameEncoding = (sftpId, requestedEncoding) => {
  if (!sftpId) return requestedEncoding || "utf-8";
  return resolveEncodingForRequest(sftpId, requestedEncoding);
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

const lstatAsync = (sftp, targetPath) =>
  new Promise((resolve, reject) => {
    const inspect = typeof sftp.lstat === "function" ? sftp.lstat.bind(sftp) : sftp.stat.bind(sftp);
    inspect(targetPath, (err, stats) => (err ? reject(err) : resolve(stats)));
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
  if (inputPath === "..") {
    const root = await client.realPath("..");
    return `${root}/`;
  }
  if (inputPath.startsWith("../") || inputPath.startsWith("..\\")) {
    const root = await client.realPath("..");
    return `${root}/${inputPath.slice(3)}`;
  }
  if (inputPath === ".") {
    const root = await client.realPath(".");
    return `${root}/`;
  }
  if (inputPath.startsWith("./") || inputPath.startsWith(".\\")) {
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
    stats = await lstatAsync(sftp, encodedTarget);
  } catch (err) {
    if (err && err.code === 2) return;
    throw err;
  }
  throwIfAborted(signal);

  if (stats.isSymbolicLink?.()) {
    await unlinkAsync(sftp, encodedTarget);
  } else if (stats.isDirectory()) {
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

  const { isScpModeClient, getScpBackendForClient } = require("./sftpBridge/scpBackend.cjs");
  if (isScpModeClient(client)) {
    const encoding = resolveEncodingForRequest(sftpId, requestedEncoding);
    await getScpBackendForClient(client).mkdir(dirPath, {
      recursive: true,
      encoding: encoding === "auto" ? "utf-8" : encoding,
    });
    return true;
  }

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
  reportOpenedSessionActivity = typeof deps.reportOpenedSessionActivity === "function"
    ? deps.reportOpenedSessionActivity
    : null;
  rendererSftpSourceSessions.clear();
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

// Common remote NAME_MAX; keep stage/backup basenames within this budget.
const REMOTE_BASENAME_MAX = 255;

function clipRemoteBaseName(baseName, overhead) {
  const raw = baseName || "upload";
  const maxBase = Math.max(8, REMOTE_BASENAME_MAX - overhead);
  if (Buffer.byteLength(raw, "utf8") <= maxBase) return raw;
  // Prefer character-safe clip: shrink until utf8 bytes fit.
  let clipped = raw;
  while (clipped.length > 1 && Buffer.byteLength(clipped, "utf8") > maxBase) {
    clipped = clipped.slice(0, -1);
  }
  return clipped || "upload";
}

function buildStagedRemotePath(remotePath) {
  const lastSeparatorIndex = Math.max(remotePath.lastIndexOf("/"), remotePath.lastIndexOf("\\"));
  const dir = lastSeparatorIndex >= 0 ? remotePath.slice(0, lastSeparatorIndex + 1) : "";
  const baseName = lastSeparatorIndex >= 0 ? remotePath.slice(lastSeparatorIndex + 1) : remotePath;
  // ".netcatty-upload-" (17) + 8 hex + "-" (1) + ".part" (5) = 31
  const safeBaseName = clipRemoteBaseName(baseName, 31);
  const stagedName = `.netcatty-upload-${randomUUID().slice(0, 8)}-${safeBaseName}.part`;
  return dir ? `${dir}${stagedName}` : stagedName;
}

function buildBackupRemotePath(remotePath) {
  const lastSeparatorIndex = Math.max(remotePath.lastIndexOf("/"), remotePath.lastIndexOf("\\"));
  const dir = lastSeparatorIndex >= 0 ? remotePath.slice(0, lastSeparatorIndex + 1) : "";
  const baseName = lastSeparatorIndex >= 0 ? remotePath.slice(lastSeparatorIndex + 1) : remotePath;
  // ".netcatty-backup-" (17) + 8 hex + "-" (1) + ".bak" (4) = 30
  const safeBaseName = clipRemoteBaseName(baseName, 30);
  const backupName = `.netcatty-backup-${randomUUID().slice(0, 8)}-${safeBaseName}.bak`;
  return dir ? `${dir}${backupName}` : backupName;
}

function isRemotePermissionError(err) {
  // Codes only — do not match message substrings (filenames may contain
  // "permission"/"access"/"denied" and must not trigger in-place fallback).
  const code = err?.code;
  return code === 3
    || code === "EACCES"
    || code === "EPERM"
    || code === "ERR_PERMISSION"
    || code === "SSH_FX_PERMISSION_DENIED";
}

function isRemoteMissingError(err) {
  const code = err?.code;
  return code === 2
    || code === "ENOENT"
    || code === "NO_SUCH_FILE"
    || code === "SSH_FX_NO_SUCH_FILE"
    || String(err?.message || "").trim() === "ENOENT";
}

function attrsIndicateSymlink(attrs) {
  if (!attrs) return false;
  if (typeof attrs.isSymbolicLink === "function") return !!attrs.isSymbolicLink();
  if (typeof attrs.isSymbolicLink === "boolean") return attrs.isSymbolicLink;
  const mode = Number(attrs.mode);
  return Number.isFinite(mode) && (mode & 0o170000) === 0o120000;
}

/**
 * Plan overwrite strategy for a remote upload target.
 * - Confirmed symlinks: write in-place so the server follows the link.
 * - When lstat is unavailable but the path exists: write in-place so we never
 *   replace an unknown link node via stage+rename.
 * - Confirmed regular files (new or existing): stage + rename so cancel cannot
 *   keep mutating the final destination. Restore mode bits after promotion
 *   (SFTP v3 cannot portably preserve owner/ACL/xattr/hard-links).
 */
async function planRemoteUploadReplace(client, encodedPath) {
  try {
    const sftp = await requireSftpChannel(client);
    const hasNativeLstat = typeof sftp?.lstat === "function";

    if (hasNativeLstat) {
      let attrs = null;
      try {
        attrs = await lstatAsync(sftp, encodedPath);
      } catch (lstatError) {
        if (isRemoteMissingError(lstatError)) {
          return { writeInPlace: false, existingMode: null };
        }
        // Some SFTP servers expose lstat client-side but reject it at runtime.
        // A successful stat proves the destination exists, but cannot tell us
        // whether it is a symlink, so preserve it with an in-place write.
        try {
          attrs = await statAsync(sftp, encodedPath);
          if (attrs) return { writeInPlace: true, existingMode: null };
        } catch (statError) {
          if (isRemoteMissingError(statError)) {
            return { writeInPlace: false, existingMode: null };
          }
          // Unknown inspection failure: do not risk rename-replacing a link.
          return { writeInPlace: true, existingMode: null };
        }
      }
      if (!attrs) return { writeInPlace: false, existingMode: null };
      if (attrsIndicateSymlink(attrs)) {
        return { writeInPlace: true, existingMode: null };
      }
      const mode = Number(attrs.mode);
      const existingMode = Number.isFinite(mode) && mode > 0
        ? (mode & 0o7777)
        : null;
      return { writeInPlace: false, existingMode };
    }

    // No lstat: if the path exists via stat, write in-place so a symlink is not
    // replaced by rename when we cannot inspect the link node.
    try {
      const attrs = await statAsync(sftp, encodedPath);
      if (attrs) {
        const mode = Number(attrs.mode);
        const existingMode = Number.isFinite(mode) && mode > 0
          ? (mode & 0o7777)
          : null;
        return { writeInPlace: true, existingMode };
      }
    } catch (statError) {
      if (!isRemoteMissingError(statError)) {
        // Unknown existing-path state: preserve a possible symlink.
        return { writeInPlace: true, existingMode: null };
      }
      // Confirmed missing destination — stage a new file.
    }
  } catch {
    // Unknown target state: preserve a possible symlink instead of replacing it.
    return { writeInPlace: true, existingMode: null };
  }
  return { writeInPlace: false, existingMode: null };
}

async function restoreRemoteMode(client, encodedPath, mode, options = {}) {
  if (mode == null || !Number.isFinite(mode)) return;
  const bestEffort = options?.bestEffort !== false;
  try {
    if (typeof client.chmod === "function") {
      await client.chmod(encodedPath, mode);
      return;
    }
    const sftp = await requireSftpChannel(client);
    await new Promise((resolve, reject) => {
      if (typeof sftp.chmod === "function") {
        sftp.chmod(encodedPath, mode, (err) => (err ? reject(err) : resolve()));
        return;
      }
      if (typeof sftp.setstat === "function") {
        sftp.setstat(encodedPath, { mode }, (err) => (err ? reject(err) : resolve()));
        return;
      }
      reject(new Error("Remote server does not support restoring file mode"));
    });
  } catch (err) {
    if (!bestEffort) throw err;
  }
}

function createRemoteRecoveryError(promotionError, restoreError, paths = {}) {
  const recoveryLocations = [
    paths.backupPath ? `backup=${String(paths.backupPath)}` : null,
    paths.stagePath ? `staged=${String(paths.stagePath)}` : null,
  ].filter(Boolean).join(", ");
  const error = new Error(
    `Remote upload promotion failed and the original destination could not be restored (${recoveryLocations}): ${restoreError?.message || String(restoreError)}`,
    { cause: promotionError },
  );
  error.preserveStagedUpload = true;
  error.remoteStagePath = paths.stagePath || null;
  error.remoteBackupPath = paths.backupPath || null;
  error.remoteFinalPath = paths.finalPath || null;
  return error;
}

/**
 * Pipelined upload with optional stage+rename.
 * - Confirmed regular files: stage then rename (cancel-safe finals) + mode restore.
 * - Symlinks / unknown-existing (no lstat): write in-place.
 * - Parent-dir permission on stage: fall back to in-place (code-based only).
 *
 * `remotePath` must be the logical (pre-encode) path string. Encoding is applied
 * here so staged/backup names are not built from Buffer path bytes.
 */
async function pipelinedUploadWithOptionalStaging(client, localPath, remotePath, options = {}) {
  const signal = options?.signal || null;
  const expectedSize = options?.expectedSize;
  const encoding = options?.encoding || "utf-8";
  const encodedPath = encodePath(remotePath, encoding);
  const plan = await planRemoteUploadReplace(client, encodedPath);
  const fastPutOptions = { ...options };
  delete fastPutOptions.expectedSize;
  delete fastPutOptions.encoding;

  const uploadDirect = async () => {
    await pipelinedUploadLocalFile(client, localPath, encodedPath, fastPutOptions);
    throwIfAborted(signal);
    if (Number.isFinite(expectedSize) && expectedSize >= 0 && typeof client.stat === "function") {
      const st = await client.stat(encodedPath);
      const size = Number(st?.size);
      if (Number.isFinite(size) && size !== expectedSize) {
        throw new Error(
          `Upload size mismatch for ${remotePath}: expected ${expectedSize} bytes, got ${size}`,
        );
      }
    }
    return { staged: false };
  };

  if (plan.writeInPlace) {
    return uploadDirect();
  }

  // Build stage/backup names from the logical string, then encode each path.
  const stagedLogical = buildStagedRemotePath(remotePath);
  const backupLogical = buildBackupRemotePath(remotePath);
  const encodedStagedPath = encodePath(stagedLogical, encoding);
  const encodedBackupPath = encodePath(backupLogical, encoding);
  try {
    await pipelinedUploadLocalFile(client, localPath, encodedStagedPath, {
      ...fastPutOptions,
      generatedStagePath: true,
    });
    throwIfAborted(signal);
    if (Number.isFinite(expectedSize) && expectedSize >= 0 && typeof client.stat === "function") {
      const stagedStat = await client.stat(encodedStagedPath);
      const stagedSize = Number(stagedStat?.size);
      if (Number.isFinite(stagedSize) && stagedSize !== expectedSize) {
        throw new Error(
          `Upload size mismatch for ${remotePath}: expected ${expectedSize} bytes, got ${stagedSize}`,
        );
      }
    }
    // Cancel may arrive during the awaited size verify; recheck before promote.
    throwIfAborted(signal);
    // Apply the old mode to the stage before promotion. A failed chmod must not
    // replace an executable final with a non-executable file and report success.
    await restoreRemoteMode(client, encodedStagedPath, plan.existingMode, {
      bestEffort: false,
    });
    await renameRemotePath(client, encodedStagedPath, encodedPath, encodedBackupPath);
    return { staged: true };
  } catch (err) {
    if (!err?.preserveStagedUpload) {
      try {
        if (typeof client.delete === "function") {
          await client.delete(encodedStagedPath);
        }
      } catch {
        // Best-effort cleanup of a partial stage.
      }
    }
    // Parent dir not writable but existing file may still be: fall back to in-place.
    if (isRemotePermissionError(err)) {
      console.warn(
        "[SFTP] Staged upload unavailable (permission); falling back to in-place overwrite:",
        err?.message || String(err),
      );
      return uploadDirect();
    }
    throw err;
  }
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
        } catch (restoreErr) {
          throw createRemoteRecoveryError(fallbackErr, restoreErr, {
            stagePath: fromPath,
            backupPath,
            finalPath: toPath,
          });
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

function createSessionBackedSftpClient(sessionId, sshClient, options = {}) {
  const refHolder = options?.refHolder || null;
  let ended = false;
  const client = {
    client: sshClient,
    sftp: null,
    __netcattySessionBacked: true,
    __netcattySourceSessionId: options?.sourceSessionId,
    __netcattyRefHolder: refHolder,
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
    /**
     * Pipelined local→remote upload via the raw ssh2 SFTP channel.
     * Session-backed clients are not ssh2-sftp-client instances and do not
     * inherit client.fastPut — expose the channel method so uploadLocal /
     * writeSftpBinaryWithProgress keep the high-throughput path (#2449).
     *
     * When `options.signal` is provided, open a disposable SFTP channel so
     * abort can end the transfer without killing the browse session.
     */
    async fastPut(localPath, remotePath, options = {}) {
      return runAbortableFastPut(client, localPath, remotePath, options);
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
      if (ended) return;
      ended = true;
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
        if (refHolder && typeof releaseConnectionRef === "function") {
          releaseConnectionRef(refHolder);
        }
      }
    },
  };

  return client;
}

async function openSftpForSession(_event, payload) {
  const { sessionId } = payload || {};
  if (!sessionId) throw new Error("sessionId is required");

  throwIfAborted(payload?.abortSignal);
  const { session, sshClient } = ensureRemoteSftpSupport(sessionId);
  const sftpId = `${sessionId}-sftp-${randomUUID()}`;
  const refHolder = {};
  if (session.connRef && typeof acquireConnectionRef === "function") {
    acquireConnectionRef(refHolder, session.connRef);
  }
  const client = createSessionBackedSftpClient(sessionId, sshClient, {
    refHolder,
    sourceSessionId: sessionId,
  });
  const { normalizeFileProtocol } = require("./sftpBridge/scpShell.cjs");
  const { getScpBackendForClient } = require("./sftpBridge/scpBackend.cjs");
  // Prefer explicit payload, then the host preference stored when the SSH
  // session started (Catty/MCP/clipboard open without fileProtocol).
  const fileProtocol = normalizeFileProtocol(
    payload?.fileProtocol
      ?? session?.sftpFileProtocol
      ?? session?.fileProtocol,
  );
  const {
    createBoundedProbeSignal,
    SCP_PROBE_TIMEOUT_MS,
  } = require("./sftpBridge/openConnection.cjs");
  const probeTimeoutMs = Number.isFinite(payload?.timeoutMs) && payload.timeoutMs > 0
    ? payload.timeoutMs
    : SCP_PROBE_TIMEOUT_MS;

  async function probeScpCapability() {
    const bounded = createBoundedProbeSignal(payload?.abortSignal || null, probeTimeoutMs);
    try {
      await getScpBackendForClient(client).homeDir({ signal: bounded.signal });
      const { createSshExecAdapters } = require("./sftpBridge/scpBackend.cjs");
      const adapters = createSshExecAdapters(sshClient);
      const scpProbe = await adapters.exec(
        "command -v scp >/dev/null 2>&1 || which scp >/dev/null 2>&1",
        { signal: bounded.signal },
      );
      if (scpProbe.code !== 0) {
        throw new Error("SCP binary not available on remote host");
      }
    } catch (err) {
      if (bounded.timedOut && !payload?.abortSignal?.aborted) {
        throw new Error(`SCP mode probe timed out after ${probeTimeoutMs}ms`);
      }
      throw err;
    } finally {
      bounded.dispose();
    }
  }

  try {
    if (fileProtocol === "scp") {
      client.__netcattyFileProtocol = "scp";
      client.sftp = null;
      // Probe must succeed: SCP mode requires working SSH exec + scp binary.
      await probeScpCapability();
      throwIfAborted(payload?.abortSignal);
      copySftpEncodingState(payload?.encodingStateKey, sftpId);
      sftpClients.set(sftpId, client);
      return { ok: true, sftpId, fileProtocol: "scp" };
    }

    try {
      await requireSftpChannel(client, {
        signal: payload?.abortSignal,
        timeoutMs: payload?.timeoutMs,
      });
      client.__netcattyFileProtocol = "sftp";
    } catch (sftpErr) {
      if (fileProtocol === "sftp") throw sftpErr;
      // Auto: SCP-mode fallback for hosts without SFTP subsystem (e.g. some NAS/root)
      console.warn(
        `[SFTP] openSftpForSession SFTP channel failed for ${sessionId}; falling back to SCP mode:`,
        sftpErr?.message || String(sftpErr),
      );
      client.__netcattyFileProtocol = "scp";
      client.sftp = null;
      try {
        await probeScpCapability();
      } catch (probeErr) {
        throw new Error(
          `SFTP unavailable and SCP-mode probe failed: ${probeErr?.message || String(probeErr)}`,
        );
      }
      throwIfAborted(payload?.abortSignal);
      copySftpEncodingState(payload?.encodingStateKey, sftpId);
      sftpClients.set(sftpId, client);
      return { ok: true, sftpId, fileProtocol: "scp" };
    }

    throwIfAborted(payload?.abortSignal);
    copySftpEncodingState(payload?.encodingStateKey, sftpId);
    sftpClients.set(sftpId, client);
    return { ok: true, sftpId, fileProtocol: "sftp" };
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

  const {
    isScpModeClient,
    getScpBackendForClient,
    createTransferFromAbortSignal,
  } = require("./sftpBridge/scpBackend.cjs");
  if (isScpModeClient(client)) {
    throwIfAborted(payload.abortSignal);
    const transfer = createTransferFromAbortSignal(payload.abortSignal);
    // Stage to a temp path first so a failed/cancelled transfer never truncates
    // an existing local destination (matches SFTP branch behavior).
    const stagedFilePath = tempDirBridge.getTempFilePath(
      path.basename(payload.localPath || payload.remotePath || "download"),
    );
    try {
      const encoding = resolveEncodingForRequest(payload.sftpId, payload.encoding);
      await getScpBackendForClient(client).downloadFile(payload.remotePath, stagedFilePath, {
        transfer,
        encoding: encoding === "auto" ? "utf-8" : encoding,
        signal: payload.abortSignal || null,
      });
      throwIfAborted(payload.abortSignal);
      if (transfer?.cancelled) {
        throw createAbortError(payload.abortSignal, "Transfer cancelled");
      }
      try {
        await fs.promises.rename(stagedFilePath, payload.localPath);
      } catch (err) {
        if (err?.code !== "EXDEV" && err?.code !== "EEXIST" && err?.code !== "EPERM") {
          throw err;
        }
        await fs.promises.copyFile(stagedFilePath, payload.localPath);
        await fs.promises.unlink(stagedFilePath);
      }
      return { success: true, localPath: payload.localPath };
    } catch (err) {
      try { await fs.promises.unlink(stagedFilePath); } catch { /* ignore */ }
      throw err;
    } finally {
      try { transfer?.detachAbortSignal?.(); } catch { /* ignore */ }
    }
  }

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

/**
 * Open a disposable SFTP channel for cancelable pipelined uploads when possible.
 * Falls back to the shared browse channel (not disposable) for sudo / missing SSH client.
 */
async function acquireUploadSftpChannel(client, options = {}) {
  if (client?.__netcattySudoMode) {
    const sftp = await requireSftpChannel(client, options);
    return { sftp, dispose: false };
  }
  const sshClient = client?.client;
  if (sshClient && typeof sshClient.sftp === "function") {
    // Prefer a disposable channel for cancel, but never fail the whole upload
    // when MaxSessions / server policy refuses another subsystem — fall back to
    // the existing browse channel (Codex PR review).
    try {
      throwIfAborted(options?.signal);
      const sftp = await tryOpenSftpChannel(client, options);
      if (sftp && typeof sftp.fastPut === "function") {
        return { sftp, dispose: true };
      }
      try { sftp?.end?.(); } catch { /* ignore */ }
    } catch (err) {
      if (options?.signal?.aborted) throw err;
      console.warn(
        "[SFTP] Disposable upload channel unavailable, using shared SFTP channel:",
        err?.message || String(err),
      );
    }
  }
  const shared = await requireSftpChannel(client, options);
  return { sftp: shared, dispose: false };
}

/**
 * Run ssh2 SFTP fastPut with optional AbortSignal.
 * Always waits for the fastPut callback (or a short dispose grace period) before
 * settling so local temp files are not unlinked while ssh2 still holds them.
 * Disposable channels are ended on abort; shared channels only mark cancelled.
 */
function runFastPutOnChannel(sftp, localPath, remotePath, options = {}, channelControl = {}) {
  const { dispose = false, signal = null, generatedStagePath = false } = channelControl;
  throwIfAborted(signal);
  if (typeof sftp?.fastPut !== "function") {
    throw new Error(
      "SFTP pipelined upload (fastPut) is not available on this session",
    );
  }
  const { signal: _ignoredSignal, onChannel, ...fastPutOptions } = options || {};
  return new Promise((resolve, reject) => {
    let settled = false;
    let abortRequested = false;
    let pendingError = null;
    let forceFinishTimer = null;
    const clearForceFinish = () => {
      if (forceFinishTimer) {
        clearTimeout(forceFinishTimer);
        forceFinishTimer = null;
      }
    };
    const scheduleForceFinish = (err) => {
      clearForceFinish();
      forceFinishTimer = setTimeout(() => {
        // Shared channel: best-effort unlink only paths explicitly created by
        // our staging planner. A caller's final name may resemble a stage path.
        if (
          !dispose
          && (abortRequested || signal?.aborted || pendingError)
          && generatedStagePath
        ) {
          try { sftp.unlink?.(remotePath, () => {}); } catch { /* ignore */ }
        }
        finish(err || new Error("SFTP channel closed"));
      }, 2000);
    };
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearForceFinish();
      if (signal && onAbort) {
        try { signal.removeEventListener("abort", onAbort); } catch { /* ignore */ }
      }
      try { sftp.removeListener?.("error", onChannelError); } catch { /* ignore */ }
      if (dispose) {
        try { sftp.end?.(); } catch { /* ignore */ }
      }
      if (err) reject(err);
      else resolve();
    };
    // Channel errors must not finish immediately: wait for fastPut callback (or
    // force timeout) so local temp files are not unlinked while still open.
    // Shared channels also get force-settle (without sftp.end) so a stalled
    // callback after error cannot hang the upload forever.
    const onChannelError = (err) => {
      pendingError = err || new Error("SFTP channel error");
      if (dispose) {
        try { sftp.end?.(); } catch { /* ignore */ }
      }
      scheduleForceFinish(pendingError);
    };
    const onAbort = () => {
      abortRequested = true;
      if (dispose) {
        try { sftp.end?.(); } catch { /* ignore */ }
        scheduleForceFinish(createAbortError(signal, "Upload cancelled"));
        return;
      }
      // Shared browse/sudo channel: do not sftp.end() (would kill the session).
      // Still bound cancellation so a stalled fastPut cannot hang forever.
      scheduleForceFinish(createAbortError(signal, "Upload cancelled"));
    };
    try { sftp.on?.("error", onChannelError); } catch { /* ignore */ }
    if (typeof onChannel === "function") {
      try { onChannel(sftp, { dispose, abort: onAbort }); } catch { /* ignore */ }
    }
    if (signal) {
      if (signal.aborted) {
        finish(createAbortError(signal, "Upload cancelled"));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      sftp.fastPut(localPath, remotePath, fastPutOptions, (err) => {
        if (abortRequested || signal?.aborted) {
          finish(createAbortError(signal, "Upload cancelled"));
          return;
        }
        if (pendingError) {
          finish(pendingError);
          return;
        }
        finish(err || null);
      });
    } catch (err) {
      finish(err);
    }
  });
}

async function runAbortableFastPut(client, localPath, remotePath, options = {}) {
  const signal = options?.signal || null;
  const generatedStagePath = options?.generatedStagePath === true;
  const fastPutOptions = { ...options };
  delete fastPutOptions.generatedStagePath;
  throwIfAborted(signal);
  const { sftp, dispose } = await acquireUploadSftpChannel(client, { signal });
  return runFastPutOnChannel(sftp, localPath, remotePath, fastPutOptions, {
    dispose,
    signal,
    generatedStagePath,
  });
}

/**
 * Pipelined local→remote upload.
 * - Prefer disposable-channel fastPut when abortable / session-backed
 * - ssh2-sftp-client.fastPut when no signal and method exists
 * Never falls back to serial createWriteStream/put (#2449).
 */
async function pipelinedUploadLocalFile(client, localPath, remotePath, options = {}) {
  const signal = options?.signal || null;
  // Always use abortable channel path when a signal is present, or when the
  // client is session-backed (wrapper fastPut → disposable channel).
  if (signal || client?.__netcattySessionBacked || typeof client?.fastPut !== "function") {
    return runAbortableFastPut(client, localPath, remotePath, options);
  }
  // ssh2-sftp-client without abort: native fastPut on the shared connection.
  const fastPutOptions = { ...options };
  delete fastPutOptions.generatedStagePath;
  return client.fastPut(localPath, remotePath, fastPutOptions);
}

async function uploadLocalToSftp(_event, payload) {
  const client = sftpClients.get(payload.sftpId);
  if (!client) throw new Error("SFTP session not found");

  const {
    isScpModeClient,
    getScpBackendForClient,
    createTransferFromAbortSignal,
  } = require("./sftpBridge/scpBackend.cjs");
  if (isScpModeClient(client)) {
    throwIfAborted(payload.abortSignal);
    const transfer = createTransferFromAbortSignal(payload.abortSignal);
    const backend = getScpBackendForClient(client);
    const encodingRaw = resolveEncodingForRequest(payload.sftpId, payload.encoding);
    const encoding = encodingRaw === "auto" ? "utf-8" : encodingRaw;

    // Symlinks must be written in-place so scp follows the link target. Staging
    // + rename would replace the link node itself (Codex PR review).
    let existing = null;
    try {
      existing = await backend.stat(payload.remotePath, { encoding });
    } catch (statErr) {
      if (!isRemoteMissingError(statErr)) throw statErr;
    }
    if (existing?.isDirectory) {
      throw new Error(`Remote path is a directory: ${payload.remotePath}`);
    }
    const existingIsSymlink = !!(
      existing?.isSymbolicLink
      || existing?.isSymlink
      || existing?.type === "symlink"
    );

    if (existingIsSymlink) {
      try {
        await backend.uploadFile(payload.localPath, payload.remotePath, {
          transfer,
          encoding,
          signal: payload.abortSignal || null,
        });
        throwIfAborted(payload.abortSignal);
        if (transfer?.cancelled) {
          throw createAbortError(payload.abortSignal, "Transfer cancelled");
        }
        return { success: true, remotePath: payload.remotePath };
      } finally {
        try { transfer?.detachAbortSignal?.(); } catch { /* ignore */ }
      }
    }

    // Upload to a staged remote name, then rename into place so a cancelled or
    // failed transfer cannot leave a truncated original (matches SFTP path).
    const stagedRemotePath = buildStagedRemotePath(payload.remotePath);
    const backupRemotePath = buildBackupRemotePath(payload.remotePath);
    try {
      await backend.uploadFile(payload.localPath, stagedRemotePath, {
        transfer,
        encoding,
        signal: payload.abortSignal || null,
      });
      throwIfAborted(payload.abortSignal);
      if (transfer?.cancelled) {
        throw createAbortError(payload.abortSignal, "Transfer cancelled");
      }
      // Best-effort atomic replace: move existing target aside, then promote staged.
      // Never move a directory aside — uploading a file onto a directory path would
      // otherwise end up recursively deleting the whole tree via backup cleanup.
      let movedExisting = false;
      try {
        let latestExisting = null;
        try {
          latestExisting = await backend.stat(payload.remotePath, { encoding });
        } catch (statErr) {
          if (!isRemoteMissingError(statErr)) throw statErr;
        }
        if (latestExisting?.isDirectory) {
          throw new Error(`Remote path is a directory: ${payload.remotePath}`);
        }
        if (
          latestExisting?.isSymbolicLink
          || latestExisting?.isSymlink
          || latestExisting?.type === "symlink"
        ) {
          throw new Error(`Remote destination changed to a symlink during upload: ${payload.remotePath}`);
        }
        if (latestExisting) {
          await backend.rename(payload.remotePath, backupRemotePath, { encoding });
          movedExisting = true;
        }
      } catch (statOrRenameErr) {
        throw statOrRenameErr;
      }
      try {
        await backend.rename(stagedRemotePath, payload.remotePath, { encoding });
      } catch (renameErr) {
        if (movedExisting) {
          try {
            await backend.rename(backupRemotePath, payload.remotePath, { encoding });
          } catch (restoreErr) {
            throw createRemoteRecoveryError(renameErr, restoreErr, {
              stagePath: stagedRemotePath,
              backupPath: backupRemotePath,
              finalPath: payload.remotePath,
            });
          }
        }
        throw renameErr;
      }
      if (movedExisting) {
        try { await backend.remove(backupRemotePath, { recursive: false, encoding }); } catch { /* ignore */ }
      }
      return { success: true, remotePath: payload.remotePath };
    } catch (err) {
      if (!err?.preserveStagedUpload) {
        try { await backend.remove(stagedRemotePath, { recursive: false, encoding }); } catch { /* ignore */ }
      }
      throw err;
    } finally {
      try { transfer?.detachAbortSignal?.(); } catch { /* ignore */ }
    }
  }

  await requireSftpChannel(client);
  const encoding = resolveEncodingForRequest(payload.sftpId, payload.encoding);
  throwIfAborted(payload.abortSignal);
  const {
    TRANSFER_CHUNK_SIZE,
    UPLOAD_TRANSFER_CONCURRENCY,
  } = require("./transferLimits.cjs");
  let expectedSize = null;
  try {
    expectedSize = Number((await fs.promises.stat(payload.localPath))?.size);
  } catch { /* ignore — fall through without size check if local vanished */ }
  // Logical path in; helper encodes stage/final so non-UTF-8 dirs stay intact.
  await pipelinedUploadWithOptionalStaging(client, payload.localPath, payload.remotePath, {
    chunkSize: TRANSFER_CHUNK_SIZE,
    concurrency: UPLOAD_TRANSFER_CONCURRENCY,
    signal: payload.abortSignal,
    encoding,
    expectedSize: Number.isFinite(expectedSize) ? expectedSize : undefined,
  });
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
const {
  acquireConnectionRef,
  releaseConnectionRef,
  findReusableSession,
} = require("./sshConnectionPool.cjs");
const openConnectionApi = createOpenConnectionApi({
  get sftpClients() { return sftpClients; },
  get sessions() { return sessions; },
  get electronModule() { return electronModule; },
  jumpConnectionsMap, SftpClient, SSHClient, NetcattyAgent, keyboardInteractiveHandler, passphraseHandler,
  hostKeyVerifier,
  fs, path, net, Buffer, process, console, setTimeout, clearTimeout,
  SFTPWrapper, createProxySocket, buildSftpAlgorithms, getAvailableAgentSocket,
  preparePrivateKeyForAuth, loadFirstIdentityFileForAuth, prepareSystemSshAgentForAuth, findAllDefaultPrivateKeysFromHelper,
  buildAuthHandler, applyAuthToConnOpts, createKeyboardInteractiveHandler, shouldSkipKiPasswordAutoFill, passphraseHandler,
  isKeyEncrypted, randomUUID,
  sendSftpProgress, safeSend, authSafeSend, copySftpEncodingState, clearSftpEncodingState, normalizeEncoding,
  resolveEncodingForRequest, updateResolvedEncoding, requireSftpChannel, realpathAsync,
  connectSudoSftp: undefined,
  acquireConnectionRef, releaseConnectionRef, findReusableSession, createSessionBackedSftpClient,
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
  buildStagedRemotePath, buildBackupRemotePath,
  realpathAsync, statAsync, lstatAsync, readdirAsync, mkdirAsync, rmdirAsync, unlinkAsync, openFileAsync,
  writeFileChunkAsync, closeFileAsync, createAbortError, copySftpEncodingState, clearSftpEncodingState,
  safeSend, tempDirBridge, randomUUID,
  pipelinedUploadLocalFile,
  pipelinedUploadWithOptionalStaging,
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
  deleteSftp,
  renameSftp,
  statSftp,
  chmodSftp,
  getSftpHomeDir,
} = fileOpsApi;

function resolveRendererSftpSourceSession(channel, payload = {}) {
  if (channel === "netcatty:sftp:openForSession") return payload.sessionId || null;
  if (channel === "netcatty:sftp:open") return payload.sourceSessionId || null;
  const sftpId = payload.sftpId;
  if (!sftpId) return null;
  return rendererSftpSourceSessions.get(sftpId)
    || sftpClients?.get?.(sftpId)?.__netcattySourceSessionId
    || null;
}

function reportSftpActivity(sessionId, phase) {
  if (!sessionId) return;
  try {
    reportOpenedSessionActivity?.({ sessionId, phase });
  } catch {
    // Activity tracking must not interfere with SFTP operations.
  }
}

function registerActivityHandle(ipcMain, channel, handler) {
  ipcMain.handle(channel, async (event, payload) => {
    const sourceSessionId = resolveRendererSftpSourceSession(channel, payload);
    reportSftpActivity(sourceSessionId, "begin");
    try {
      const result = await handler(event, payload);
      const sftpId = result?.sftpId;
      if (sourceSessionId && sftpId) {
        rendererSftpSourceSessions.set(sftpId, sourceSessionId);
      }
      return result;
    } finally {
      if (channel === "netcatty:sftp:close" && payload?.sftpId) {
        rendererSftpSourceSessions.delete(payload.sftpId);
      }
      reportSftpActivity(sourceSessionId, "end");
    }
  });
}

function registerWorkerHandle(ipcMain, terminalWorkerManager, channel) {
  registerActivityHandle(ipcMain, channel, (event, payload) => (
    terminalWorkerManager.request(channel, payload, {
      webContentsId: event?.sender?.id,
    })
  ));
}

/**
 * Register IPC handlers for SFTP operations
 */
function registerHandlers(ipcMain, options = {}) {
  const terminalWorkerManager = options.terminalWorkerManager || null;
  if (terminalWorkerManager) {
    [
      "netcatty:sftp:open",
      "netcatty:sftp:openForSession",
      "netcatty:sftp:list",
      "netcatty:sftp:read",
      "netcatty:sftp:readBinary",
      "netcatty:sftp:write",
      "netcatty:sftp:writeBinary",
      "netcatty:sftp:writeBinaryWithProgress",
      "netcatty:sftp:downloadToLocal",
      "netcatty:sftp:uploadLocal",
      "netcatty:sftp:cancelUpload",
      "netcatty:sftp:close",
      "netcatty:sftp:mkdir",
      "netcatty:sftp:delete",
      "netcatty:sftp:rename",
      "netcatty:sftp:stat",
      "netcatty:sftp:chmod",
      "netcatty:sftp:homeDir",
    ].forEach((channel) => registerWorkerHandle(ipcMain, terminalWorkerManager, channel));
    return;
  }
  [
    ["netcatty:sftp:open", openSftp],
    ["netcatty:sftp:openForSession", openSftpForSession],
    ["netcatty:sftp:list", listSftp],
    ["netcatty:sftp:read", readSftp],
    ["netcatty:sftp:readBinary", readSftpBinary],
    ["netcatty:sftp:write", writeSftp],
    ["netcatty:sftp:writeBinary", writeSftpBinary],
    ["netcatty:sftp:writeBinaryWithProgress", writeSftpBinaryWithProgress],
    ["netcatty:sftp:downloadToLocal", downloadSftpToLocal],
    ["netcatty:sftp:uploadLocal", uploadLocalToSftp],
    ["netcatty:sftp:cancelUpload", cancelSftpUpload],
    ["netcatty:sftp:close", closeSftp],
    ["netcatty:sftp:mkdir", mkdirSftp],
    ["netcatty:sftp:delete", deleteSftp],
    ["netcatty:sftp:rename", renameSftp],
    ["netcatty:sftp:stat", statSftp],
    ["netcatty:sftp:chmod", chmodSftp],
    ["netcatty:sftp:homeDir", getSftpHomeDir],
  ].forEach(([channel, handler]) => registerActivityHandle(ipcMain, channel, handler));
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
  getResolvedFilenameEncoding,
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
  pipelinedUploadLocalFile,
  _renameRemotePathForTests: renameRemotePath,
  closeSftp,
  mkdirSftp,
  deleteSftp,
  renameSftp,
  statSftp,
  chmodSftp,
  getSftpHomeDir,
  resolveEncodingForRequest,
};
