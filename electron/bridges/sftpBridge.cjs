/**
 * SFTP Bridge - Handles SFTP connections and file operations
 * Extracted from main.cjs for single responsibility
 */

const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { createHash, randomUUID } = require("node:crypto");
const { pipeline } = require("node:stream/promises");
const { TextDecoder } = require("node:util");
const { StringDecoder } = require("node:string_decoder");
const { executeBoundedSshCommand } = require("./boundedSshExec.cjs");
const { openBoundedSftpChannel } = require("./boundedSftpOpen.cjs");
const { invalidateSshTransport } = require("./sshTransportInvalidation.cjs");
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
const REMOTE_DELETE_EXEC_OPEN_TIMEOUT_MS = 15_000;
const REMOTE_DELETE_EXEC_RUN_TIMEOUT_MS = 10 * 60_000;
const REMOTE_DELETE_EXEC_MAX_OUTPUT_BYTES = 64 * 1024;
const REMOTE_BACKUP_DELETE_ATTEMPTS = 3;

// Storage for jump host connections that need to be cleaned up
const jumpConnectionsMap = new Map(); // connId -> { connections: SSHClient[], socket: stream }

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

function isAbortError(error) {
  if (!error) return false;
  if (error.name === "AbortError") return true;
  const message = String(error.message || error);
  return /abort|cancel/i.test(message);
}

const tryOpenSftpChannel = (client, options = {}) =>
  openBoundedSftpChannel(client?.client, options);

const getSftpChannel = async (client, options = {}) => {
  if (!client) return null;
  if (client.__netcattyDisposed) return null;

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
    return waitForSharedSftpReopen(client._reopeningPromise, options.signal || null);
  }

  const reopeningPromise = (async () => {
    try {
      // Reopening belongs to the connection, not to whichever transfer reached
      // it first. Each waiter cancels only its own wait below.
      const reopened = await tryOpenSftpChannel(client, { timeoutMs: options.timeoutMs });
      if (hasSftpChannelApi(reopened)) {
        if (client.__netcattyDisposed) {
          try { reopened.end?.(); } catch {}
          try { reopened.close?.(); } catch {}
          return null;
        }
        client.sftp = reopened;
        return reopened;
      }
    } catch (err) {
      console.warn("[SFTP] Failed to recover SFTP channel", err?.message || String(err));
    }
    return null;
  })();
  client._reopeningPromise = reopeningPromise;
  void reopeningPromise.finally(() => {
    if (client._reopeningPromise === reopeningPromise) {
      client._reopeningPromise = null;
    }
  });
  return waitForSharedSftpReopen(reopeningPromise, options.signal || null);
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

const readlinkAsync = (sftp, targetPath) =>
  new Promise((resolve, reject) => {
    if (typeof sftp.readlink !== "function") {
      const error = new Error("SFTP readlink is not available");
      error.code = "ENOTSUP";
      reject(error);
      return;
    }
    sftp.readlink(targetPath, (err, linkPath) => (err ? reject(err) : resolve(linkPath)));
  });

const readdirAsync = (sftp, targetPath) =>
  new Promise((resolve, reject) => {
    sftp.readdir(targetPath, (err, items) => (err ? reject(err) : resolve(items || [])));
  });

const mkdirAsync = (sftp, targetPath) =>
  new Promise((resolve, reject) => {
    sftp.mkdir(targetPath, (err) => (err ? reject(err) : resolve()));
  });

const raceReadAgainstAbort = async (operation, signal) => {
  throwIfAborted(signal);
  if (!signal) return operation;
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(createAbortError(signal, "SFTP directory setup was aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
};

const waitForSharedSftpReopen = async (reopeningPromise, signal) => {
  try {
    return await raceReadAgainstAbort(reopeningPromise, signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
};

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

const ensureRemoteDirInternal = async (sftp, dirPath, encoding, options = {}) => {
  const signal = options.signal || null;
  throwIfAborted(signal);
  if (!dirPath || dirPath === ".") return;
  const normalized = normalizeRemoteDirPath(dirPath);
  if (!normalized || normalized === ".") return;

  // Optimization: Check if the full path already exists to avoid O(N) round trips
  // This is the common case (e.g. uploading multiple files to the same directory)
  const encodedFull = encodePath(normalized, encoding);
  throwIfAborted(signal);
  try {
    const stats = await raceReadAgainstAbort(statAsync(sftp, encodedFull), signal);
    throwIfAborted(signal);
    if (stats.isDirectory()) {
      return;
    }
  } catch (err) {
    throwIfAborted(signal);
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
    throwIfAborted(signal);
    if (isWindowsPath) {
      const base = current.replace(/[\\]+$/, "");
      current = `${base}\\${part}`;
    } else {
      current = current === "/" ? `/${part}` : (current ? `${current}/${part}` : part);
    }
    const encodedCurrent = encodePath(current, encoding);
    try {
      const stats = await raceReadAgainstAbort(statAsync(sftp, encodedCurrent), signal);
      throwIfAborted(signal);
      if (!stats.isDirectory()) {
        throw new Error(`Remote path is not a directory: ${current}`);
      }
    } catch (err) {
      throwIfAborted(signal);
      if (err && (err.code === 2 || err.code === 4)) {
        throwIfAborted(signal);
        await mkdirAsync(sftp, encodedCurrent);
        throwIfAborted(signal);
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

/**
 * Run a one-shot remote shell command on the SSH connection underlying an SFTP client.
 * Used for fast directory delete (`rm -rf`) when SFTP-protocol recursion would be slow.
 */
function terminateRemoteShellStream(stream) {
  if (!stream) return;
  try { stream.once?.("error", () => {}); } catch { /* ignore */ }
  try { stream.stderr?.once?.("error", () => {}); } catch { /* ignore */ }
  try { stream.close?.(); } catch { /* ignore */ }
  try { stream.end?.(); } catch { /* ignore */ }
  try { stream.destroy?.(); } catch { /* ignore */ }
}

async function execRemoteShellCommand(sshClient, command, optionsOrSignal = null) {
  if (!sshClient || typeof sshClient.exec !== "function") {
    throw new Error("SSH exec unavailable");
  }
  const isAbortSignal = optionsOrSignal
    && typeof optionsOrSignal === "object"
    && typeof optionsOrSignal.addEventListener === "function"
    && typeof optionsOrSignal.aborted === "boolean";
  const options = isAbortSignal ? { signal: optionsOrSignal } : (optionsOrSignal || {});
  const signal = options.signal || null;
  const openingTimeoutMs = Math.max(
    1,
    Number(options.openingTimeoutMs) || REMOTE_DELETE_EXEC_OPEN_TIMEOUT_MS,
  );
  const runTimeoutMs = Math.max(
    1,
    Number(options.runTimeoutMs) || REMOTE_DELETE_EXEC_RUN_TIMEOUT_MS,
  );
  const maxOutputBytes = Math.max(
    1,
    Number(options.maxOutputBytes) || REMOTE_DELETE_EXEC_MAX_OUTPUT_BYTES,
  );
  const discardStdout = options.discardStdout === true;
  return await new Promise((resolve, reject) => {
    let settled = false;
    let streamRef = null;
    let openingTimer = null;
    let runTimer = null;
    let outputBytes = 0;
    let stdout = "";
    let stderr = "";
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let decodersEnded = false;
    const cleanup = () => {
      if (openingTimer) clearTimeout(openingTimer);
      if (runTimer) clearTimeout(runTimer);
      openingTimer = null;
      runTimer = null;
      if (signal) {
        try { signal.removeEventListener("abort", onAbort); } catch { /* ignore */ }
      }
    };
    const finish = (error, code = 0) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        terminateRemoteShellStream(streamRef);
        reject(error);
        return;
      }
      if (!decodersEnded) {
        decodersEnded = true;
        stdout += stdoutDecoder.end();
        stderr += stderrDecoder.end();
      }
      if (code === 0) {
        resolve({ stdout, stderr, code });
        return;
      }
      reject(new Error(
        `Remote command failed (code ${code})${stderr ? `: ${String(stderr).trim()}` : ""}`,
      ));
    };
    const onAbort = () => {
      finish(createAbortError(signal, "Remote command was aborted"));
      if (!streamRef) invalidateSshTransport(sshClient);
    };
    const appendOutput = (target, chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      if (target === "stdout" && discardStdout) return;
      outputBytes += buffer.length;
      if (outputBytes > maxOutputBytes) {
        finish(new Error(`Remote command output exceeded ${maxOutputBytes} bytes`));
        return;
      }
      if (target === "stdout") stdout += stdoutDecoder.write(buffer);
      else stderr += stderrDecoder.write(buffer);
    };
    if (signal) {
      if (signal.aborted) {
        finish(createAbortError(signal, "Remote command was aborted"));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    openingTimer = setTimeout(() => {
      finish(new Error(`Remote command open timed out after ${openingTimeoutMs} ms`));
      invalidateSshTransport(sshClient);
    }, openingTimeoutMs);
    try {
      sshClient.exec(command, (error, stream) => {
        if (openingTimer) clearTimeout(openingTimer);
        openingTimer = null;
        if (settled) {
          terminateRemoteShellStream(stream);
          return;
        }
        if (error) {
          finish(error);
          return;
        }
        streamRef = stream;
        runTimer = setTimeout(() => {
          finish(new Error(`Remote command execution timed out after ${runTimeoutMs} ms`));
        }, runTimeoutMs);
        stream.on("data", (chunk) => { appendOutput("stdout", chunk); });
        if (stream.stderr && typeof stream.stderr.on === "function") {
          stream.stderr.on("data", (chunk) => { appendOutput("stderr", chunk); });
          stream.stderr.on("error", (streamError) => finish(streamError));
        }
        stream.on("close", (code) => finish(null, code ?? 0));
        stream.on("error", (streamError) => finish(streamError));
      });
    } catch (error) {
      finish(error);
    }
  });
}

/**
 * Fast directory delete via shell `rm -rf`, verified through the SFTP channel.
 * Returns true only when SFTP confirms the path is gone. Never trust shell exit
 * alone — shell cwd/root can diverge from the SFTP view of the same path.
 *
 * Non-UTF-8 encodings skip this path (shell quoting of legacy encodings is unsafe).
 */
async function tryFastShellDirectoryDelete(client, remotePath, encoding = "utf-8", signal = null) {
  const sshClient = client?.client;
  if (!sshClient || typeof sshClient.exec !== "function") return false;
  const enc = !encoding || encoding === "auto" ? "utf-8" : encoding;
  if (enc !== "utf-8") return false;
  if (typeof remotePath !== "string" || !remotePath || remotePath === "/" || remotePath === ".") {
    return false;
  }

  let command;
  try {
    const { buildDeleteCommand } = require("./sftpBridge/scpShell.cjs");
    command = buildDeleteCommand(remotePath, { recursive: true, encoding: "utf-8" });
  } catch {
    return false;
  }

  try {
    await execRemoteShellCommand(sshClient, command, { signal });
  } catch {
    return false;
  }

  throwIfAborted(signal);
  // Confirm via the same SFTP channel the browser uses.
  try {
    const sftp = await requireSftpChannel(client, { signal });
    const encoded = encodePath(remotePath, "utf-8");
    await lstatAsync(sftp, encoded);
    // Still present — shell did not remove the SFTP-visible path.
    return false;
  } catch (err) {
    if (err && (err.code === 2 || err.code === "ENOENT")) return true;
    if (err && /no such file/i.test(String(err.message || ""))) return true;
    return false;
  }
}

/**
 * Remove a remote directory: prefer verified shell `rm -rf`, fall back to
 * protocol-level recursive walk when shell is unavailable or unverified.
 */
async function removeRemoteDirectory(client, remotePath, encoding = "utf-8", signal = null) {
  throwIfAborted(signal);
  const enc = !encoding || encoding === "auto" ? "utf-8" : encoding;
  if (await tryFastShellDirectoryDelete(client, remotePath, enc, signal)) {
    return;
  }
  throwIfAborted(signal);
  const sftp = await requireSftpChannel(client, { signal });
  const normalized = await normalizeRemotePathString(client, remotePath);
  throwIfAborted(signal);
  await removeRemotePathInternal(sftp, normalized, enc, signal);
}

const ensureRemoteDirForSession = async (sftpId, dirPath, requestedEncoding, options = {}) => {
  const client = sftpClients.get(sftpId);
  if (!client) throw new Error("SFTP session not found");

  if (!dirPath || dirPath === ".") return true;

  const { isScpModeClient, getScpBackendForClient } = require("./sftpBridge/scpBackend.cjs");
  if (isScpModeClient(client)) {
    const encoding = resolveEncodingForRequest(sftpId, requestedEncoding);
    await getScpBackendForClient(client).mkdir(dirPath, {
      recursive: true,
      encoding: encoding === "auto" ? "utf-8" : encoding,
      signal: options.signal || null,
    });
    return true;
  }

  const encoding = resolveEncodingForRequest(sftpId, requestedEncoding);
  const signal = options.signal || null;
  const sftp = await requireSftpChannel(client, { signal });
  throwIfAborted(signal);

  // Always walk the path segment-by-segment. This lets sftp.stat() follow
  // symlinked directory segments before deciding whether the next mkdir is
  // valid, which avoids recursive mkdir failures on paths like /link/subdir.
  const normalizedPath = await raceReadAgainstAbort(
    normalizeRemotePathString(client, dirPath),
    signal,
  );
  throwIfAborted(signal);
  await ensureRemoteDirInternal(sftp, normalizedPath, encoding, { signal });
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

function findRemoteSftpSourceByEndpoint(sourceSessionId, expectedEndpoint) {
  const requested = sessions?.get(sourceSessionId);
  const matchesExpectedEndpoint = (session) => {
    const actualEndpoint = session?._reuseEndpoint || session?.connRef?.endpoint;
    return Boolean(
      actualEndpoint
      && endpointAllowsReuse(expectedEndpoint, actualEndpoint, "channel"),
    );
  };
  const hasLiveSftpConnection = (session) => {
    const sshClient = session?.conn || session?.sshClient;
    return Boolean(sshClient && typeof sshClient.sftp === "function");
  };

  if (requested && matchesExpectedEndpoint(requested) && hasLiveSftpConnection(requested)) {
    return { sessionId: sourceSessionId, session: requested, sshClient: requested.conn || requested.sshClient };
  }

  // The renderer only has endpoint fields when it chooses a sourceSessionId;
  // route, proxy, credential and host-key fingerprints live in the main
  // process. Treat its id as a hint, then choose the newest live session whose
  // authoritative transport identity matches in full.
  let matchingSource = null;
  for (const [candidateId, candidate] of sessions || []) {
    if (candidateId === sourceSessionId) continue;
    if (!matchesExpectedEndpoint(candidate) || !hasLiveSftpConnection(candidate)) continue;
    matchingSource = {
      sessionId: candidateId,
      session: candidate,
      sshClient: candidate.conn || candidate.sshClient,
    };
  }
  return matchingSource;
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
  // One stable recovery path per destination prevents repeated retries from
  // leaving a new random backup each time cleanup is temporarily unavailable.
  // ".netcatty-backup-" (17) + 16 hex + "-" (1) + ".bak" (4) = 38
  const safeBaseName = clipRemoteBaseName(baseName, 38);
  const targetHash = createHash("sha256").update(String(remotePath)).digest("hex").slice(0, 16);
  const backupName = `.netcatty-backup-${targetHash}-${safeBaseName}.bak`;
  return dir ? `${dir}${backupName}` : backupName;
}

function createRemoteBackupCleanupError(cleanupError, paths = {}) {
  const error = new Error(
    `Remote upload completed, but the original backup could not be removed. `
      + `Final: ${String(paths.finalPath || "unknown")}; backup: ${String(paths.backupPath || "unknown")}: `
      + `${cleanupError?.message || String(cleanupError)}`,
    { cause: cleanupError },
  );
  error.recoverable = true;
  error.remoteBackupPath = paths.backupPath || null;
  error.remoteFinalPath = paths.finalPath || null;
  return error;
}

async function deleteRemoteBackupWithRetry(deleteBackup, paths = {}, options = {}) {
  const attempts = Math.max(1, Number(options.attempts) || REMOTE_BACKUP_DELETE_ATTEMPTS);
  const delay = options.delay || ((attempt) => new Promise((resolve) => {
    setTimeout(resolve, attempt * 25);
  }));
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await deleteBackup();
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await delay(attempt);
    }
  }
  throw createRemoteBackupCleanupError(lastError, paths);
}

async function readRemotePathIfPresent(statPath) {
  try {
    return await statPath();
  } catch (error) {
    if (isRemoteMissingError(error)) return null;
    throw error;
  }
}

async function reconcileRemoteUploadBackup(options) {
  const backup = await readRemotePathIfPresent(options.statBackup);
  if (!backup) return;
  const target = await readRemotePathIfPresent(options.statTarget);
  if (!target) {
    // An interrupted promotion left the backup as the only known-good copy.
    await options.restoreBackup();
    return;
  }
  // The final target is live, so the stable backup belongs to an earlier
  // committed upload. Remove it before this attempt creates a new backup.
  await deleteRemoteBackupWithRetry(options.deleteBackup, {
    finalPath: options.finalPath,
    backupPath: options.backupPath,
  });
}

function isRemoteMissingError(err) {
  const code = err?.code;
  return code === 2
    || code === "ENOENT"
    || code === "NO_SUCH_FILE"
    || code === "SSH_FX_NO_SUCH_FILE"
    || String(err?.message || "").trim() === "ENOENT";
}

function isRemoteUnsupportedError(err) {
  const code = err?.code;
  return code === 8
    || code === "ENOTSUP"
    || code === "EOPNOTSUPP"
    || code === "SSH_FX_OP_UNSUPPORTED";
}

async function inspectRemoteRecoveryEntry(sftp, targetPath) {
  try {
    return await lstatAsync(sftp, targetPath);
  } catch (error) {
    // Some SFTP v3 servers expose lstat but reject the request at runtime.
    // A Netcatty-created recovery artifact is always a regular file, so stat
    // remains a safe compatibility fallback for this narrow inspection.
    if (typeof sftp?.lstat === "function" && isRemoteUnsupportedError(error)) {
      return statAsync(sftp, targetPath);
    }
    throw error;
  }
}

function attrsIndicateSymlink(attrs) {
  if (!attrs) return false;
  if (typeof attrs.isSymbolicLink === "function") return !!attrs.isSymbolicLink();
  if (typeof attrs.isSymbolicLink === "boolean") return attrs.isSymbolicLink;
  const mode = Number(attrs.mode);
  return Number.isFinite(mode) && (mode & 0o170000) === 0o120000;
}

async function distinguishMissingTargetFromBrokenSymlink(sftp, encodedPath) {
  try {
    await readlinkAsync(sftp, encodedPath);
    return { writeInPlace: true, existingMode: null, destinationExisted: true };
  } catch (error) {
    if (isRemoteMissingError(error)) {
      return { writeInPlace: false, existingMode: null, destinationExisted: false };
    }
    const unsafeError = new Error(
      "Cannot safely distinguish a missing upload target from a broken symbolic link",
      { cause: error },
    );
    unsafeError.unsafeUploadTarget = true;
    throw unsafeError;
  }
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
async function planRemoteUploadReplace(client, encodedPath, remotePath, signal = null) {
  try {
    const sftp = await requireSftpChannel(client);
    const hasNativeLstat = typeof sftp?.lstat === "function";

    if (hasNativeLstat) {
      let attrs = null;
      try {
        attrs = await lstatAsync(sftp, encodedPath);
      } catch (lstatError) {
        if (isRemoteMissingError(lstatError)) {
          return { writeInPlace: false, existingMode: null, destinationExisted: false, destinationSnapshot: null };
        }
        // Some SFTP servers expose lstat client-side but reject it at runtime.
        // A successful stat proves the destination exists, but cannot tell us
        // whether it is a symlink, so preserve it with an in-place write.
        try {
          attrs = await statAsync(sftp, encodedPath);
          if (attrs) return { writeInPlace: true, existingMode: null, destinationExisted: true };
        } catch (statError) {
          if (isRemoteMissingError(statError)) {
            return distinguishMissingTargetFromBrokenSymlink(sftp, encodedPath);
          }
          // Unknown inspection failure: do not risk rename-replacing a link.
          return { writeInPlace: true, existingMode: null, destinationExisted: null };
        }
      }
      if (!attrs) return { writeInPlace: false, existingMode: null, destinationExisted: false, destinationSnapshot: null };
      if (attrsIndicateSymlink(attrs)) {
        return { writeInPlace: true, existingMode: null, destinationExisted: true };
      }
      const mode = Number(attrs.mode);
      const existingMode = Number.isFinite(mode) && mode > 0
        ? (mode & 0o7777)
        : null;
      return {
        writeInPlace: false,
        existingMode,
        destinationExisted: true,
        destinationSnapshot: await finalizeDestinationSnapshot(
          client,
          encodedPath,
          remotePath,
          snapshotRemoteTarget(attrs),
          { scpMode: false, signal },
        ),
      };
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
        return { writeInPlace: true, existingMode, destinationExisted: true };
      }
    } catch (statError) {
      if (!isRemoteMissingError(statError)) {
        // Unknown existing-path state: preserve a possible symlink.
        return { writeInPlace: true, existingMode: null, destinationExisted: null };
      }
      return distinguishMissingTargetFromBrokenSymlink(sftp, encodedPath);
    }
  } catch (error) {
    if (error?.unsafeUploadTarget) throw error;
    // Unknown target state: preserve a possible symlink instead of replacing it.
    return { writeInPlace: true, existingMode: null, destinationExisted: null };
  }
  return { writeInPlace: false, existingMode: null, destinationExisted: false, destinationSnapshot: null };
}

function attrsIndicateDirectory(attrs) {
  if (!attrs) return false;
  if (typeof attrs.isDirectory === "function") return !!attrs.isDirectory();
  if (typeof attrs.isDirectory === "boolean") return attrs.isDirectory;
  const mode = Number(attrs.mode);
  return Number.isFinite(mode) && (mode & 0o170000) === 0o040000;
}

function snapshotRemoteTarget(attrs) {
  if (!attrs) return null;
  const snapshot = {};
  for (const field of ["size", "mode", "uid", "gid", "mtime", "modifyTime", "ino", "dev", "fileId", "permissions", "type"]) {
    const value = attrs[field];
    if (["number", "string", "bigint", "boolean"].includes(typeof value)) {
      snapshot[field] = String(value);
    }
  }
  return snapshot;
}

function remoteTargetMatchesSnapshot(attrs, snapshot) {
  if (!snapshot) return true;
  return Object.entries(snapshot).every(([field, expected]) => {
    // contentDigest is verified separately via a re-hash of the destination.
    if (field === "contentDigest") return true;
    return attrs[field] != null && String(attrs[field]) === expected;
  });
}

async function hashReadableForDigest(readable, signal = null) {
  throwIfAborted(signal);
  const hash = createHash("sha256");
  const onAbort = () => {
    try {
      readable.destroy?.(createAbortError(signal, "Remote target verification was aborted"));
    } catch {
      /* ignore */
    }
  };
  if (signal) {
    signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    for await (const chunk of readable) {
      throwIfAborted(signal);
      hash.update(chunk);
    }
    throwIfAborted(signal);
    return hash.digest("hex");
  } finally {
    if (signal) {
      try { signal.removeEventListener("abort", onAbort); } catch { /* ignore */ }
    }
    if (signal?.aborted) {
      try { readable.destroy?.(); } catch { /* ignore */ }
    }
  }
}

async function tryRemoteSha256Sum(sshClient, remotePath, signal = null) {
  if (!sshClient || typeof sshClient.exec !== "function") return null;
  const escapedPath = String(remotePath).replace(/'/g, "'\\''");
  try {
    const result = await executeBoundedSshCommand(
      sshClient,
      `sha256sum -- '${escapedPath}'`,
      {
        signal,
        openingTimeoutMs: 15_000,
        runTimeoutMs: 10 * 60_000,
        maxOutputBytes: 64 * 1024,
      },
    );
    const match = result.stdout.match(/^([a-fA-F0-9]{64})\s/);
    return result.code === 0 && match ? match[1].toLowerCase() : null;
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) {
      throw createAbortError(signal, "Remote target verification was aborted");
    }
    return null;
  }
}

/**
 * Prefer server-side sha256sum; fall back to streaming the destination over SFTP.
 * Returns null when neither path is available (metadata-only residual risk).
 */
async function computeRemoteContentDigest(client, encodedPath, remotePath, options = {}) {
  const signal = options.signal || null;
  throwIfAborted(signal);
  const digest = await tryRemoteSha256Sum(client?.client, remotePath, signal);
  if (digest) {
    throwIfAborted(signal);
    return digest;
  }
  try {
    throwIfAborted(signal);
    const sftp = client?.sftp || await requireSftpChannel(client);
    if (typeof sftp?.createReadStream === "function") {
      return await hashReadableForDigest(sftp.createReadStream(encodedPath), signal);
    }
    if (typeof client?.get === "function") {
      const buffer = await client.get(encodedPath);
      throwIfAborted(signal);
      return createHash("sha256")
        .update(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer))
        .digest("hex");
    }
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) throw createAbortError(signal, "Remote target verification was aborted");
    return null;
  }
  return null;
}

/**
 * Always prefer a content digest when possible. Metadata (including ino/fileId)
 * alone cannot detect same-size in-place rewrites on SFTP v3 or coarse SCP mtime.
 */
async function finalizeDestinationSnapshot(client, encodedPath, remotePath, snapshot, options = {}) {
  if (!snapshot) return snapshot;
  const digest = await computeRemoteContentDigest(client, encodedPath, remotePath, options);
  if (!digest) return snapshot;
  return { ...snapshot, contentDigest: digest };
}

async function assertDestinationContentUnchanged(client, encodedPath, remotePath, snapshot, options = {}) {
  if (!snapshot?.contentDigest) return;
  const digest = await computeRemoteContentDigest(client, encodedPath, remotePath, options);
  if (!digest || digest !== snapshot.contentDigest) {
    throw new Error(`Remote destination changed during upload: ${remotePath}`);
  }
}

async function assertTargetStillMissingWithoutLstat(sftp, encodedPath, remotePath) {
  try {
    const attrs = await statAsync(sftp, encodedPath);
    if (attrs) throw new Error(`Remote destination appeared during upload: ${remotePath}`);
  } catch (error) {
    if (!isRemoteMissingError(error)) throw error;
    try {
      await readlinkAsync(sftp, encodedPath);
      throw new Error(`Remote destination changed to a symlink during upload: ${remotePath}`);
    } catch (readlinkError) {
      if (isRemoteMissingError(readlinkError)) return;
      throw readlinkError;
    }
  }
}

async function assertStagedPromotionTargetSafe(
  client,
  encodedPath,
  remotePath,
  expectedExisted,
  expectedSnapshot,
  signal = null,
) {
  throwIfAborted(signal);
  const sftp = await requireSftpChannel(client);
  if (typeof sftp?.lstat !== "function") {
    if (expectedExisted !== false) {
      throw new Error(`Cannot safely recheck remote destination before replace: ${remotePath}`);
    }
    await assertTargetStillMissingWithoutLstat(sftp, encodedPath, remotePath);
    return;
  }
  let attrs = null;
  try {
    attrs = await lstatAsync(sftp, encodedPath);
  } catch (err) {
    if (isRemoteMissingError(err)) {
      attrs = null;
    } else if (expectedExisted === false) {
      // Runtime lstat may be unsupported despite the method existing. A plain
      // stat may only authorize promotion when it still proves true absence.
      await assertTargetStillMissingWithoutLstat(sftp, encodedPath, remotePath);
      return;
    } else {
      throw err;
    }
  }
  const existsNow = !!attrs;
  if (expectedExisted === false && existsNow) {
    throw new Error(`Remote destination appeared during upload: ${remotePath}`);
  }
  if (expectedExisted === true && !existsNow) {
    throw new Error(`Remote destination disappeared during upload: ${remotePath}`);
  }
  if (attrsIndicateSymlink(attrs)) {
    throw new Error(`Remote destination changed to a symlink during upload: ${remotePath}`);
  }
  if (attrsIndicateDirectory(attrs)) {
    throw new Error(`Remote path is a directory: ${remotePath}`);
  }
  if (existsNow && !remoteTargetMatchesSnapshot(attrs, expectedSnapshot)) {
    throw new Error(`Remote destination changed during upload: ${remotePath}`);
  }
  if (existsNow) {
    await assertDestinationContentUnchanged(
      client,
      encodedPath,
      remotePath,
      expectedSnapshot,
      { signal },
    );
  }
}

async function restoreRemoteMode(client, encodedPath, mode, options = {}) {
  if (mode == null || !Number.isFinite(mode)) return;
  const bestEffort = options?.bestEffort !== false;
  try {
    const { isScpModeClient, getScpBackendForClient } = require("./sftpBridge/scpBackend.cjs");
    if (isScpModeClient(client)) {
      // SCP-only servers have no SFTP channel; chmod via shell backend.
      const encoding = options?.encoding || "utf-8";
      const remotePath = options?.remotePath
        || (Buffer.isBuffer(encodedPath) ? decodeName(encodedPath, encoding) : String(encodedPath));
      await getScpBackendForClient(client).chmod(remotePath, mode, {
        encoding,
        signal: options?.signal || null,
      });
      return;
    }
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

async function planScpRemoteUploadReplace(client, remotePath, encoding, signal = null) {
  const { getScpBackendForClient } = require("./sftpBridge/scpBackend.cjs");
  const backend = getScpBackendForClient(client);
  let attrs = null;
  try {
    attrs = await backend.stat(remotePath, { encoding, signal });
  } catch (error) {
    if (!isRemoteMissingError(error)) throw error;
  }
  if (!attrs) {
    return { writeInPlace: false, existingMode: null, destinationExisted: false, destinationSnapshot: null };
  }
  if (attrs.isDirectory || attrs.type === "directory") {
    throw new Error(`Remote path is a directory: ${remotePath}`);
  }
  if (attrs.isSymbolicLink || attrs.isSymlink || attrs.type === "symlink") {
    return { writeInPlace: true, existingMode: null, destinationExisted: true };
  }
  const encodedPath = encodePath(remotePath, encoding);
  return {
    writeInPlace: false,
    // `permissions` distinguishes a real mode 000 from an unparseable mode,
    // both of which otherwise appear as numeric zero.
    existingMode: attrs.permissions && Number.isFinite(attrs.mode)
      ? (attrs.mode & 0o7777)
      : null,
    destinationExisted: true,
    destinationSnapshot: await finalizeDestinationSnapshot(
      client,
      encodedPath,
      remotePath,
      snapshotRemoteTarget(attrs),
      { scpMode: true, encoding, signal },
    ),
  };
}

async function promoteScpStagedUpload(
  client,
  stagedPath,
  targetPath,
  backupPath,
  encoding,
  expectedExisted,
  expectedSnapshot,
  existingMode,
  assertCanPromote,
  commitPromotion,
  runCancelablePreflight,
  signal,
) {
  const { getScpBackendForClient } = require("./sftpBridge/scpBackend.cjs");
  const backend = getScpBackendForClient(client);
  const encodedTargetPath = encodePath(targetPath, encoding);
  const assertTargetSafe = async () => {
    let latestTarget = null;
    try {
      latestTarget = await runCancelablePreflight(
        () => backend.stat(targetPath, { encoding, signal }),
      );
    } catch (error) {
      if (!isRemoteMissingError(error)) throw error;
    }
    if (latestTarget?.isDirectory || latestTarget?.type === "directory") {
      throw new Error(`Remote path is a directory: ${targetPath}`);
    }
    if (latestTarget?.isSymbolicLink || latestTarget?.isSymlink || latestTarget?.type === "symlink") {
      throw new Error(`Remote destination changed to a symlink during upload: ${targetPath}`);
    }
    if (expectedExisted === false && latestTarget) {
      throw new Error(`Remote destination appeared during upload: ${targetPath}`);
    }
    if (expectedExisted === true && !latestTarget) {
      throw new Error(`Remote destination disappeared during upload: ${targetPath}`);
    }
    if (latestTarget && !remoteTargetMatchesSnapshot(latestTarget, expectedSnapshot)) {
      throw new Error(`Remote destination changed during upload: ${targetPath}`);
    }
    if (latestTarget) {
      await assertDestinationContentUnchanged(
        client,
        encodedTargetPath,
        targetPath,
        expectedSnapshot,
        { scpMode: true, encoding, signal },
      );
    }
    return latestTarget;
  };
  let latest = await assertTargetSafe();
  assertCanPromote();
  if (Number.isFinite(existingMode)) {
    await backend.chmod(stagedPath, existingMode, { encoding, signal });
    assertCanPromote();
    latest = await assertTargetSafe();
    assertCanPromote();
  }

  // Promotion starts mutating the destination at the first rename. Mark the
  // commit boundary before that point so a cancel arriving during either
  // rename cannot be accepted and then reported after publication.
  commitPromotion();
  let movedExisting = false;
  if (latest) {
    await backend.rename(targetPath, backupPath, { encoding });
    movedExisting = true;
  }
  try {
    assertCanPromote();
    await backend.rename(stagedPath, targetPath, { encoding });
  } catch (promotionError) {
    if (movedExisting) {
      try {
        await backend.rename(backupPath, targetPath, { encoding });
      } catch (restoreError) {
        throw createRemoteRecoveryError(promotionError, restoreError, {
          stagePath: stagedPath,
          backupPath,
          finalPath: targetPath,
        });
      }
    }
    throw promotionError;
  }
  if (movedExisting) {
    await deleteRemoteBackupWithRetry(
      () => backend.remove(backupPath, { recursive: false, encoding }),
      { finalPath: targetPath, backupPath },
    );
  }
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
async function runRemoteUploadTransaction(client, localPath, remotePath, options = {}) {
  const signal = options?.signal || null;
  const expectedSize = options?.expectedSize;
  const encoding = options?.encoding || "utf-8";
  const customUpload = typeof options?.uploadFile === "function" ? options.uploadFile : null;
  const assertCanPromote = typeof options?.assertCanPromote === "function"
    ? options.assertCanPromote
    : () => throwIfAborted(signal);
  const commitPromotion = typeof options?.commitPromotion === "function"
    ? options.commitPromotion
    : () => {};
  const runCancelablePreflight = typeof options?.runCancelablePreflight === "function"
    ? options.runCancelablePreflight
    : (operation) => operation();
  const preserveStageOnUploadError = options?.preserveStageOnUploadError === true;
  const { isScpModeClient, getScpBackendForClient } = require("./sftpBridge/scpBackend.cjs");
  const scpMode = isScpModeClient(client);
  const encodedPath = encodePath(remotePath, encoding);
  // Build stable recovery paths before inspecting the destination. A previous
  // interrupted/unclean promotion must be reconciled before we snapshot the
  // target for this upload.
  const stagedLogical = options?.stagedPath || buildStagedRemotePath(remotePath);
  const backupLogical = options?.backupPath || buildBackupRemotePath(remotePath);
  const encodedStagedPath = encodePath(stagedLogical, encoding);
  const encodedBackupPath = encodePath(backupLogical, encoding);
  if (scpMode) {
    const backend = getScpBackendForClient(client);
    await reconcileRemoteUploadBackup({
      finalPath: remotePath,
      backupPath: backupLogical,
      statTarget: () => runCancelablePreflight(() => backend.stat(remotePath, { encoding, signal })),
      statBackup: () => runCancelablePreflight(() => backend.stat(backupLogical, { encoding, signal })),
      restoreBackup: () => backend.rename(backupLogical, remotePath, { encoding }),
      deleteBackup: () => backend.remove(backupLogical, { recursive: false, encoding }),
    });
  } else {
    // Inspect recovery artifacts through the raw channel. Every production
    // client has one, while `client.stat` is only a convenience supplied by
    // some adapters. Recovery must not make otherwise-valid raw SFTP clients
    // fail before the normal upload plan can run.
    const recoverySftp = await requireSftpChannel(client, { signal });
    await reconcileRemoteUploadBackup({
      finalPath: remotePath,
      backupPath: backupLogical,
      statTarget: () => runCancelablePreflight(() => inspectRemoteRecoveryEntry(recoverySftp, encodedPath)),
      statBackup: () => runCancelablePreflight(() => inspectRemoteRecoveryEntry(recoverySftp, encodedBackupPath)),
      restoreBackup: () => client.rename(encodedBackupPath, encodedPath),
      deleteBackup: () => (
        typeof client.delete === "function"
          ? client.delete(encodedBackupPath)
          : unlinkAsync(recoverySftp, encodedBackupPath)
      ),
    });
  }
  const plan = await runCancelablePreflight(() => (
    scpMode
      ? planScpRemoteUploadReplace(client, remotePath, encoding, signal)
      : planRemoteUploadReplace(client, encodedPath, remotePath, signal)
  ));
  const fastPutOptions = { ...options };
  delete fastPutOptions.expectedSize;
  delete fastPutOptions.encoding;
  delete fastPutOptions.uploadFile;
  delete fastPutOptions.assertCanPromote;
  delete fastPutOptions.commitPromotion;
  delete fastPutOptions.runCancelablePreflight;
  delete fastPutOptions.allowInPlaceFallback;
  delete fastPutOptions.stagedPath;
  delete fastPutOptions.backupPath;
  delete fastPutOptions.preserveStageOnUploadError;

  const uploadTo = async (logicalPath, encodedUploadPath, generatedStagePath) => {
    if (customUpload) {
      // SCP shell commands encode logical string paths themselves. Passing an
      // SFTP-style Buffer here loses non-UTF-8 path information.
      await customUpload(scpMode ? logicalPath : encodedUploadPath, {
        logicalPath,
        generatedStagePath,
        plan,
      });
      return;
    }
    await pipelinedUploadLocalFile(client, localPath, encodedUploadPath, {
      ...fastPutOptions,
      generatedStagePath,
    });
  };

  const uploadDirect = async () => {
    await uploadTo(remotePath, encodedPath, false);
    assertCanPromote();
    // An in-place upload has already published its bytes and cannot be rolled
    // back. Stop accepting cancellation before the final size verification so
    // a late request cannot report the completed overwrite as cancelled.
    commitPromotion();
    // Some servers recreate the inode on OPEN|CREAT|TRUNC. Restore captured
    // permission bits after an in-place overwrite (incl. stage→in-place
    // fallback) so executable/setuid bits are not left at umask defaults.
    // Do not forward the transfer AbortSignal: promotion already committed, and
    // a late cancel must not abort required mode restoration (best-effort would
    // otherwise swallow the failure and leave umask defaults).
    if (Number.isFinite(plan.existingMode)) {
      await restoreRemoteMode(client, encodedPath, plan.existingMode, {
        bestEffort: false,
        remotePath,
        encoding,
      });
    }
    // SCP stat reports the link node itself. After an in-place symlink upload,
    // it cannot reliably verify the followed target's byte count.
    if (Number.isFinite(expectedSize) && expectedSize >= 0 && !(scpMode && plan.writeInPlace)) {
      const st = scpMode
        ? await getScpBackendForClient(client).stat(remotePath, { encoding })
        : typeof client.stat === "function" ? await client.stat(encodedPath) : null;
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

  const cleanupStage = async () => {
    try {
      if (scpMode) {
        await getScpBackendForClient(client).remove(stagedLogical, {
          recursive: false,
          encoding,
        });
      } else if (typeof client.delete === "function") {
        await client.delete(encodedStagedPath);
      }
    } catch {
      // Best-effort cleanup of a partial stage.
    }
  };

  try {
    await uploadTo(stagedLogical, encodedStagedPath, true);
  } catch (err) {
    if (!preserveStageOnUploadError) {
      await cleanupStage();
    }
    throw err;
  }

  try {
    assertCanPromote();
    if (Number.isFinite(expectedSize) && expectedSize >= 0) {
      const stagedStat = await runCancelablePreflight(() => (
        scpMode
          ? getScpBackendForClient(client).stat(stagedLogical, { encoding, signal })
          : typeof client.stat === "function" ? client.stat(encodedStagedPath) : null
      ));
      const stagedSize = Number(stagedStat?.size);
      if (Number.isFinite(stagedSize) && stagedSize !== expectedSize) {
        throw new Error(
          `Upload size mismatch for ${remotePath}: expected ${expectedSize} bytes, got ${stagedSize}`,
        );
      }
    }
    // Cancel may arrive during the awaited size verify; recheck before promote.
    assertCanPromote();
    if (scpMode) {
      await promoteScpStagedUpload(
        client,
        stagedLogical,
        remotePath,
        backupLogical,
        encoding,
        plan.destinationExisted,
        plan.destinationSnapshot,
        plan.existingMode,
        assertCanPromote,
        commitPromotion,
        runCancelablePreflight,
        signal,
      );
    } else {
      await runCancelablePreflight(() => assertStagedPromotionTargetSafe(
          client,
          encodedPath,
          remotePath,
          plan.destinationExisted,
          plan.destinationSnapshot,
          signal,
        ));
      assertCanPromote();
      // Apply the old mode to the stage before promotion. A failed chmod must not
      // replace an executable final with a non-executable file and report success.
      await restoreRemoteMode(client, encodedStagedPath, plan.existingMode, {
        bestEffort: false,
      });
      assertCanPromote();
      await runCancelablePreflight(() => assertStagedPromotionTargetSafe(
          client,
          encodedPath,
          remotePath,
          plan.destinationExisted,
          plan.destinationSnapshot,
          signal,
        ));
      assertCanPromote();
      commitPromotion();
      await renameRemotePath(client, encodedStagedPath, encodedPath, encodedBackupPath, {
        stagePath: stagedLogical,
        backupPath: backupLogical,
        finalPath: remotePath,
      });
    }
    return { staged: true };
  } catch (err) {
    if (!err?.preserveStagedUpload) {
      await cleanupStage();
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

async function renameRemotePath(client, fromPath, toPath, backupPath = null, recoveryPaths = {}) {
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
            stagePath: recoveryPaths.stagePath || fromPath,
            backupPath: recoveryPaths.backupPath || backupPath,
            finalPath: recoveryPaths.finalPath || toPath,
          });
        }
      }
      throw fallbackErr;
    }

    if (movedExistingTarget) {
      await deleteRemoteBackupWithRetry(
        () => client.delete(backupPath),
        {
          finalPath: recoveryPaths.finalPath || toPath,
          backupPath: recoveryPaths.backupPath || backupPath,
        },
      );
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
    __netcattyDisposed: false,
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
     * inherit client.fastPut — expose the channel method so uploadLocal keeps
     * the high-throughput path (#2449).
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
      if (recursive) {
        // Prefer verified shell `rm -rf` (fast); fall back to SFTP walk.
        await removeRemoteDirectory(client, remotePath, "utf-8", signal);
        return;
      }
      const sftp = await requireSftpChannel(client, { signal });
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
      client.__netcattyDisposed = true;
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
  let sourceSessionId = sessionId;
  let source;
  if (payload?.expectedEndpoint) {
    const expectedEndpoint = buildConnectionReuseEndpoint(payload.expectedEndpoint);
    source = findRemoteSftpSourceByEndpoint(sessionId, expectedEndpoint);
    if (!source) {
      const err = new Error("Source session SSH route does not match the requested SFTP endpoint");
      err.code = "ERR_SFTP_SOURCE_ROUTE_MISMATCH";
      throw err;
    }
    sourceSessionId = source.sessionId;
  } else {
    source = { sessionId, ...ensureRemoteSftpSupport(sessionId) };
  }
  const { session, sshClient } = source;
  const actualEndpoint = session._reuseEndpoint || session.connRef?.endpoint;
  const sftpId = `${sourceSessionId}-sftp-${randomUUID()}`;
  const refHolder = { id: sftpId, __sshLeaseKind: "sftp" };
  if (session.connRef && typeof acquireConnectionRef === "function") {
    acquireConnectionRef(refHolder, session.connRef);
  }
  const client = createSessionBackedSftpClient(sourceSessionId, sshClient, {
    refHolder,
    sourceSessionId,
  });
  client.__netcattyEndpointKey = session.connRef?.endpointKey || buildEndpointKey(actualEndpoint);
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
  const sudoRequested = Boolean(payload?.sudo);

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
    // Forced SCP cannot provide sudo elevation; reject before touching the channel
    // so session reuse matches the fresh openSftp contract.
    if (sudoRequested && fileProtocol === "scp") {
      throw new Error(
        "Sudo Mode is not supported with File Protocol set to SCP. Disable Sudo Mode or use Auto/SFTP.",
      );
    }

    if (sudoRequested) {
      let sftpWrapper;
      let sudoActive = true;
      try {
        sftpWrapper = await connectSudoSftp(sshClient, payload?.password || "");
      } catch (e) {
        // Fallback: if sftp-server binary is missing (exit code 127), try the
        // standard SFTP subsystem instead of failing completely. Mirrors openSftp
        // (ESXi / hosts without a standalone sftp-server). Keeps the reused SSH
        // transport so MFA is not repeated.
        if (e?.message && e.message.includes("exit code 127")) {
          console.warn(
            "[SFTP] openSftpForSession sftp-server not found, falling back to standard SFTP subsystem",
          );
          sudoActive = false;
          sftpWrapper = await requireSftpChannel(client, {
            signal: payload?.abortSignal,
            timeoutMs: payload?.timeoutMs,
          });
        } else {
          throw e;
        }
      }
      client.sftp = sftpWrapper;
      client.__netcattyFileProtocol = "sftp";
      client.__netcattySudoMode = sudoActive;
      if (sudoActive) {
        sftpWrapper.on?.("close", () => client.end());
      }
      throwIfAborted(payload?.abortSignal);
      copySftpEncodingState(payload?.encodingStateKey, sftpId);
      sftpClients.set(sftpId, client);
      return { ok: true, sftpId, fileProtocol: "sftp", sourceSessionId };
    }

    if (fileProtocol === "scp") {
      client.__netcattyFileProtocol = "scp";
      client.sftp = null;
      // Probe must succeed: SCP mode requires working SSH exec + scp binary.
      await probeScpCapability();
      throwIfAborted(payload?.abortSignal);
      copySftpEncodingState(payload?.encodingStateKey, sftpId);
      sftpClients.set(sftpId, client);
      return { ok: true, sftpId, fileProtocol: "scp", sourceSessionId };
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
      return { ok: true, sftpId, fileProtocol: "scp", sourceSessionId };
    }

    throwIfAborted(payload?.abortSignal);
    copySftpEncodingState(payload?.encodingStateKey, sftpId);
    sftpClients.set(sftpId, client);
    return { ok: true, sftpId, fileProtocol: "sftp", sourceSessionId };
  } catch (err) {
    try {
      await client.end();
    } catch {
      // Ignore cleanup failures while discarding a one-off session-backed handle.
    }
    throw err;
  }
}

async function runUnifiedSftpTransfer(payload, direction) {
  const client = sftpClients.get(payload.sftpId);
  if (!client) throw new Error("SFTP session not found");
  throwIfAborted(payload.abortSignal);

  // High-level file transfers have one implementation. sftpBridge remains the
  // session/filesystem adapter; transferBridge owns scheduling, integrity,
  // staging, promotion, recovery, progress and cancellation.
  const transferBridge = require("./transferBridge.cjs");
  transferBridge.init({ sftpClients });
  const transferId = payload.transferId || `sftp-${direction}-${randomUUID()}`;
  const sender = {
    send(channel, eventPayload) {
      payload.onTransferEvent?.(channel, eventPayload);
    },
  };
  const transferPayload = direction === "upload"
    ? {
        transferId,
        sourcePath: payload.localPath,
        targetPath: payload.remotePath,
        sourceType: "local",
        targetType: "sftp",
        targetSftpId: payload.sftpId,
        targetEncoding: payload.encoding,
        resumable: payload.resumable === true,
        sourceIsOwnedTemp: payload.sourceIsOwnedTemp === true,
        abortSignal: payload.abortSignal || null,
      }
    : {
        transferId,
        sourcePath: payload.remotePath,
        targetPath: payload.localPath,
        sourceType: "sftp",
        targetType: "local",
        sourceSftpId: payload.sftpId,
        sourceEncoding: payload.encoding,
        resumable: payload.resumable !== false,
        abortSignal: payload.abortSignal || null,
      };
  const cancel = () => {
    void transferBridge.cancelTransfer(null, { transferId });
  };
  payload.abortSignal?.addEventListener?.("abort", cancel, { once: true });
  try {
    const result = await transferBridge.startTransfer({ sender }, transferPayload);
    if (result?.error) {
      if (result.cancelled || result.error === "Transfer cancelled") {
        throw createAbortError(payload.abortSignal, "Transfer cancelled");
      }
      throw new Error(result.error);
    }
    return direction === "upload"
      ? { success: true, transferId, remotePath: payload.remotePath }
      : { success: true, transferId, localPath: payload.localPath };
  } finally {
    payload.abortSignal?.removeEventListener?.("abort", cancel);
  }
}

async function downloadSftpToLocal(_event, payload) {
  return runUnifiedSftpTransfer(payload, "download");
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
  return runUnifiedSftpTransfer(payload, "upload");
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
  createTransport,
  borrowTransport,
  findTransportByEndpoint,
  beginTransportDial,
  waitForTransportDial,
  completeTransportDial,
  failTransportDial,
  buildEndpointKey,
  buildConnectionReuseEndpoint,
  resolveConnectionKeepalivePolicy,
  endpointAllowsReuse,
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
  createTransport, borrowTransport, findTransportByEndpoint,
  beginTransportDial, waitForTransportDial, completeTransportDial, failTransportDial,
  buildEndpointKey,
  buildConnectionReuseEndpoint,
  resolveConnectionKeepalivePolicy,
});
const { connectThroughChainForSftp, connectSudoSftp, openSftp } = openConnectionApi;
const { createFileOpsApi } = require("./sftpBridge/fileOps.cjs");
const fileOpsApi = createFileOpsApi({
  get sftpClients() { return sftpClients; },
  get electronModule() { return electronModule; },
  fileWatcherBridge, fs, path, Buffer, console, setTimeout, clearTimeout,
  jumpConnectionsMap, sftpEncodingState, normalizeEncoding, isAsciiString,
  requireSftpChannel, resolveEncodingForRequest, updateResolvedEncoding, encodePath, decodeName,
  detectEncodingFromList, statResultFromAttrs, normalizeRemotePathString, collectReadable, writeToWritable,
  throwIfAborted, pipeStreams, ensureRemoteDirForSession, removeRemotePathInternal, removeRemoteDirectory,
  tryFastShellDirectoryDelete, execRemoteShellCommand, renameRemotePath,
  buildStagedRemotePath, buildBackupRemotePath,
  realpathAsync, statAsync, lstatAsync, readdirAsync, mkdirAsync, rmdirAsync, unlinkAsync, openFileAsync,
  writeFileChunkAsync, closeFileAsync, createAbortError, copySftpEncodingState, clearSftpEncodingState,
  safeSend, tempDirBridge, randomUUID,
  runUnifiedSftpTransfer,
});
const {
  listSftp,
  realpathSftp,
  readSftp,
  readSftpBinary,
  writeSftp,
  writeSftpBinary,
  closeSftp,
  mkdirSftp,
  deleteSftp,
  renameSftp,
  statSftp,
  lstatSftp,
  chmodSftp,
  extractSftpArchive,
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

function createRendererSftpOwnership(closeOwnedSftp) {
  const owners = new Map();
  const isOpenChannel = (channel) => (
    channel === "netcatty:sftp:open" || channel === "netcatty:sftp:openForSession"
  );
  const cleanupOwnerIfDone = (entry) => {
    if (!entry?.destroyed || entry.pendingOpens > 0 || entry.sftpIds.size > 0) return;
    owners.delete(entry.senderId);
  };
  const closeForOwner = async (entry, sftpId) => {
    entry.sftpIds.delete(sftpId);
    try {
      await closeOwnedSftp(sftpId, entry.senderId);
    } catch (error) {
      console.warn(`[SFTP] Failed to close renderer-owned session ${sftpId}:`, error?.message || error);
    } finally {
      cleanupOwnerIfDone(entry);
    }
  };
  const getOwner = (sender) => {
    const senderId = sender?.id;
    if (!Number.isSafeInteger(senderId)) return null;
    let entry = owners.get(senderId);
    if (entry) return entry;
    entry = {
      senderId,
      sender,
      destroyed: sender?.isDestroyed?.() === true,
      pendingOpens: 0,
      sftpIds: new Set(),
    };
    owners.set(senderId, entry);
    if (!entry.destroyed && typeof sender?.once === "function") {
      sender.once("destroyed", () => {
        entry.destroyed = true;
        for (const sftpId of [...entry.sftpIds]) {
          void closeForOwner(entry, sftpId);
        }
        cleanupOwnerIfDone(entry);
      });
    }
    return entry;
  };
  return {
    shouldRememberOpenResult(sender, sftpId) {
      const senderId = sender?.id;
      if (!Number.isSafeInteger(senderId)) return true;
      return owners.get(senderId)?.sftpIds.has(sftpId) === true;
    },
    async run(channel, event, payload, handler) {
      if (isOpenChannel(channel)) {
        const entry = getOwner(event?.sender);
        if (!entry) return handler();
        entry.pendingOpens += 1;
        try {
          const result = await handler();
          const sftpId = result?.sftpId;
          if (sftpId) {
            if (entry.destroyed || entry.sender?.isDestroyed?.() === true) {
              entry.destroyed = true;
              await closeForOwner(entry, sftpId);
            } else {
              entry.sftpIds.add(sftpId);
            }
          }
          return result;
        } finally {
          entry.pendingOpens -= 1;
          cleanupOwnerIfDone(entry);
        }
      }
      if (channel === "netcatty:sftp:close" && payload?.sftpId) {
        const claimedEntries = [];
        for (const entry of owners.values()) {
          if (entry.sftpIds.delete(payload.sftpId)) {
            claimedEntries.push(entry);
          }
          cleanupOwnerIfDone(entry);
        }
        try {
          return await handler();
        } catch (error) {
          await Promise.all(claimedEntries.map(async (entry) => {
            if (entry.destroyed || entry.sender?.isDestroyed?.() === true) {
              entry.destroyed = true;
              await closeForOwner(entry, payload.sftpId);
            } else {
              entry.sftpIds.add(payload.sftpId);
            }
          }));
          throw error;
        }
      }
      return handler();
    },
  };
}

function registerActivityHandle(ipcMain, channel, handler, ownership = null) {
  ipcMain.handle(channel, async (event, payload) => {
    const sourceSessionId = resolveRendererSftpSourceSession(channel, payload);
    reportSftpActivity(sourceSessionId, "begin");
    try {
      const invoke = () => handler(event, payload);
      const result = ownership
        ? await ownership.run(channel, event, payload, invoke)
        : await invoke();
      const sftpId = result?.sftpId;
      const resolvedSourceSessionId = result?.sourceSessionId
        || sftpClients?.get?.(sftpId)?.__netcattySourceSessionId
        || sourceSessionId;
      if (
        resolvedSourceSessionId
        && sftpId
        && (!ownership || ownership.shouldRememberOpenResult(event?.sender, sftpId))
      ) {
        rendererSftpSourceSessions.set(sftpId, resolvedSourceSessionId);
        if (resolvedSourceSessionId !== sourceSessionId) {
          reportSftpActivity(resolvedSourceSessionId, "touch");
        }
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

function registerWorkerHandle(ipcMain, terminalWorkerManager, channel, ownership) {
  registerActivityHandle(ipcMain, channel, (event, payload) => (
    terminalWorkerManager.request(channel, payload, {
      webContentsId: event?.sender?.id,
    })
  ), ownership);
}

/**
 * Register IPC handlers for SFTP operations
 */
function registerHandlers(ipcMain, options = {}) {
  const terminalWorkerManager = options.terminalWorkerManager || null;
  const ownership = createRendererSftpOwnership((sftpId, webContentsId) => {
    rendererSftpSourceSessions.delete(sftpId);
    return terminalWorkerManager
      ? terminalWorkerManager.request(
        "netcatty:sftp:close",
        { sftpId },
        { webContentsId },
      )
      : closeSftp(null, { sftpId });
  });
  if (terminalWorkerManager) {
    [
      "netcatty:sftp:open",
      "netcatty:sftp:openForSession",
      "netcatty:sftp:list",
      "netcatty:sftp:realpath",
      "netcatty:sftp:read",
      "netcatty:sftp:readBinary",
      "netcatty:sftp:write",
      "netcatty:sftp:writeBinary",
      "netcatty:sftp:downloadToLocal",
      "netcatty:sftp:uploadLocal",
      "netcatty:sftp:close",
      "netcatty:sftp:mkdir",
      "netcatty:sftp:delete",
      "netcatty:sftp:rename",
      "netcatty:sftp:stat",
      "netcatty:sftp:lstat",
      "netcatty:sftp:chmod",
      "netcatty:sftp:extract",
      "netcatty:sftp:homeDir",
    ].forEach((channel) => registerWorkerHandle(ipcMain, terminalWorkerManager, channel, ownership));
    return;
  }
  [
    ["netcatty:sftp:open", openSftp],
    ["netcatty:sftp:openForSession", openSftpForSession],
    ["netcatty:sftp:list", listSftp],
    ["netcatty:sftp:realpath", realpathSftp],
    ["netcatty:sftp:read", readSftp],
    ["netcatty:sftp:readBinary", readSftpBinary],
    ["netcatty:sftp:write", writeSftp],
    ["netcatty:sftp:writeBinary", writeSftpBinary],
    ["netcatty:sftp:downloadToLocal", downloadSftpToLocal],
    ["netcatty:sftp:uploadLocal", uploadLocalToSftp],
    ["netcatty:sftp:close", closeSftp],
    ["netcatty:sftp:mkdir", mkdirSftp],
    ["netcatty:sftp:delete", deleteSftp],
    ["netcatty:sftp:rename", renameSftp],
    ["netcatty:sftp:stat", statSftp],
    ["netcatty:sftp:lstat", lstatSftp],
    ["netcatty:sftp:chmod", chmodSftp],
    ["netcatty:sftp:extract", extractSftpArchive],
    ["netcatty:sftp:homeDir", getSftpHomeDir],
  ].forEach(([channel, handler]) => registerActivityHandle(ipcMain, channel, handler, ownership));
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
  _createRendererSftpOwnershipForTests: createRendererSftpOwnership,
  listSftp,
  realpathSftp,
  readSftp,
  readSftpBinary,
  writeSftp,
  writeSftpBinary,
  downloadSftpToLocal,
  uploadLocalToSftp,
  pipelinedUploadLocalFile,
  runRemoteUploadTransaction,
  _renameRemotePathForTests: renameRemotePath,
  _buildBackupRemotePathForTests: buildBackupRemotePath,
  _deleteRemoteBackupWithRetryForTests: deleteRemoteBackupWithRetry,
  _reconcileRemoteUploadBackupForTests: reconcileRemoteUploadBackup,
  closeSftp,
  mkdirSftp,
  deleteSftp,
  renameSftp,
  statSftp,
  lstatSftp,
  chmodSftp,
  extractSftpArchive,
  getSftpHomeDir,
  resolveEncodingForRequest,
  _execRemoteShellCommandForTests: execRemoteShellCommand,
  _tryRemoteSha256SumForTests: tryRemoteSha256Sum,
};
