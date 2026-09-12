/**
 * Temp Directory Bridge - Manages Netcatty's dedicated temp directory
 * 
 * All temporary files (SFTP downloads, etc.) are stored in a dedicated
 * Netcatty folder within the system temp directory for easier cleanup.
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

// Keep the legacy name when the OS already provides a private per-user temp
// root. Shared temp roots fall back to a stable directory under the user's home
// so another OS user cannot claim Netcatty's path before startup.
const NETCATTY_TEMP_DIR_NAME = "Netcatty";
const MAX_TOOL_OUTPUT_TEMP_CHARS = 4_000_000;
const MAX_TOOL_OUTPUT_TEMP_BYTES = 8_000_000;
const TOOL_OUTPUT_ORPHAN_TTL_MS = 30 * 60 * 1_000;
const TOOL_OUTPUT_PERSISTED_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const TOOL_OUTPUT_MANIFEST_MAX_BYTES = 16_384;
const TOOL_OUTPUT_MAX_HANDLES_PER_SESSION = 64;
const TOOL_OUTPUT_MAX_CHARS_PER_SESSION = 8_000_000;
const TOOL_OUTPUT_MAX_HANDLES_GLOBAL = 256;
const TOOL_OUTPUT_MAX_CHARS_GLOBAL = 32_000_000;
const TOOL_OUTPUT_READ_MAX_CHARS = 12_000;
const TOOL_OUTPUT_SEARCH_CONTEXT_CHARS = 320;
const TOOL_OUTPUT_SEARCH_MAX_MATCHES = 20;
const TOOL_OUTPUT_SIGNING_KEY_FILE = ".tool-output-signing-key";
const TOOL_OUTPUT_TEMP_DIR_REBOUND = "NETCATTY_TEMP_DIR_REBOUND";

// Cached temp directory path
let cachedTempDir = null;
let cachedTempDirIdentity = null;
let tempFileCounter = 0;
let toolOutputSigningKeyPromise = Promise.resolve(crypto.randomBytes(32));
let toolOutputSigningKeyRecoveryPromise = null;
let toolOutputSigningKeyRecoveryGeneration = null;
let toolOutputSafeStorage = null;
let tempDirRebindGeneration = 0;
const toolOutputSessionDeletions = new Map();
const toolOutputChatDeletionGenerations = new Map();
const closedToolOutputTerminalSessions = new Set();

function isSecureToolOutputStorageAvailable(safeStorage, platform = process.platform) {
  if (!safeStorage?.isEncryptionAvailable?.()) return false;
  if (platform !== "linux" || typeof safeStorage.getSelectedStorageBackend !== "function") return true;
  const backend = safeStorage.getSelectedStorageBackend();
  return backend !== "basic_text" && backend !== "unknown";
}

function getToolOutputChatDeletionGeneration(chatSessionId) {
  return toolOutputChatDeletionGenerations.get(chatSessionId) ?? 0;
}

function createTempDirReboundError() {
  const error = new Error("Temporary directory was replaced while saving output.");
  error.code = TOOL_OUTPUT_TEMP_DIR_REBOUND;
  return error;
}

async function readFileAtMost(file, maxBytes) {
  const buffer = Buffer.alloc(maxBytes + 1);
  const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
  return bytesRead > maxBytes ? null : buffer.subarray(0, bytesRead);
}

async function listPendingSigningKeyFiles(keyPath) {
  try {
    const files = await fs.promises.readdir(path.dirname(keyPath));
    return files.filter(file => (
      file.startsWith(`${TOOL_OUTPUT_SIGNING_KEY_FILE}.`)
      && file.endsWith(".pending")
    )).map(file => path.join(path.dirname(keyPath), file));
  } catch {
    return [];
  }
}

async function hasPendingSigningKeyFile(keyPath, expectedStat) {
  const keyStat = expectedStat ?? await fs.promises.lstat(keyPath).catch(() => null);
  if (!keyStat) return false;
  for (const pendingPath of await listPendingSigningKeyFiles(keyPath)) {
    try {
      const pendingStat = await fs.promises.lstat(pendingPath);
      if (pendingStat.dev === keyStat.dev && pendingStat.ino === keyStat.ino) return true;
    } catch {
      // Another publisher may have removed the pending link concurrently.
    }
  }
  return false;
}

async function cleanupPendingSigningKeyFiles(keyPath, expectedStat) {
  const keyStat = expectedStat ?? await fs.promises.lstat(keyPath).catch(() => null);
  if (!keyStat) return;
  for (const pendingPath of await listPendingSigningKeyFiles(keyPath)) {
    try {
      const pendingStat = await fs.promises.lstat(pendingPath);
      if (pendingStat.dev === keyStat.dev && pendingStat.ino === keyStat.ino) {
        await safeUnlink(pendingPath);
      }
    } catch {
      // Best effort; the key remains usable even if cleanup loses a race.
    }
  }
}

async function loadOrCreateToolOutputSigningKey(safeStorage) {
  if (!isSecureToolOutputStorageAvailable(safeStorage)) return null;
  const keyPath = path.join(getTempDir(), TOOL_OUTPUT_SIGNING_KEY_FILE);
  const generation = tempDirRebindGeneration;
  const isCurrentGeneration = () => generation === tempDirRebindGeneration;
  const isCurrentTempDir = () => {
    try {
      return isCurrentGeneration() && getTempDir() === path.dirname(keyPath);
    } catch {
      return false;
    }
  };
  try {
    const stat = await fs.promises.lstat(keyPath);
    if (stat.isFile() && !stat.isSymbolicLink() && (stat.nlink === 1 || stat.nlink === 2) && stat.size <= 4096) {
      const opened = await openSafeToolOutputFile(keyPath, 4096, false, true);
      if (!opened) return null;
      try {
        const encrypted = await readFileAtMost(opened.file, 4096);
        if (!encrypted) return null;
        if (!isCurrentTempDir()) return null;
        const decoded = Buffer.from(safeStorage.decryptString(encrypted), "base64");
        if (decoded.length === 32 && isCurrentTempDir()) {
          if (stat.nlink === 2) await cleanupPendingSigningKeyFiles(keyPath, stat);
          return decoded;
        }
      } catch {
        // A locked or temporarily unavailable OS keychain must not destroy the
        // only key capable of verifying previously persisted output.
        return null;
      } finally {
        await opened.file.close().catch(() => {});
      }
    }
    if (!isCurrentTempDir()) return null;
    if ((stat.isFile() || stat.isSymbolicLink())) {
      await fs.promises.unlink(keyPath);
    } else {
      return null;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") return null;
  }

  const key = crypto.randomBytes(32);
  const pendingPath = `${keyPath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.pending`;
  try {
    if (!isCurrentTempDir()) return null;
    const encrypted = safeStorage.encryptString(key.toString("base64"));
    await fs.promises.writeFile(pendingPath, encrypted, { mode: 0o600, flag: "wx" });
    if (!isCurrentTempDir()) return null;
    await fs.promises.link(pendingPath, keyPath);
    await safeUnlink(pendingPath);
    return key;
  } catch (error) {
    await safeUnlink(pendingPath);
    if (error?.code !== "EEXIST") return null;
    if (!isCurrentTempDir()) return null;
    try {
      const opened = await openSafeToolOutputFile(keyPath, 4096, false);
      if (!opened) return null;
      try {
        const encrypted = await readFileAtMost(opened.file, 4096);
        if (!encrypted) return null;
        if (!isCurrentTempDir()) return null;
        const decoded = Buffer.from(safeStorage.decryptString(encrypted), "base64");
        if (decoded.length !== 32 || !isCurrentTempDir()) return null;
        await cleanupPendingSigningKeyFiles(keyPath, await fs.promises.lstat(keyPath).catch(() => null));
        return decoded;
      } finally {
        await opened.file.close().catch(() => {});
      }
    } catch {
      return null;
    }
  }
}

function configureToolOutputSigningKey(electronModule) {
  if (!electronModule) return;
  toolOutputSafeStorage = electronModule.safeStorage;
  toolOutputSigningKeyPromise = loadOrCreateToolOutputSigningKey(toolOutputSafeStorage);
}

async function getToolOutputSigningKey({ retry = true } = {}) {
  const generation = tempDirRebindGeneration;
  const key = await toolOutputSigningKeyPromise.catch(() => null);
  if (generation !== tempDirRebindGeneration) {
    return retry ? getToolOutputSigningKey({ retry }) : null;
  }
  if (key || !retry || !toolOutputSafeStorage) return key;
  if (toolOutputSigningKeyRecoveryPromise && toolOutputSigningKeyRecoveryGeneration === generation) {
    return toolOutputSigningKeyRecoveryPromise;
  }
  const recovery = loadOrCreateToolOutputSigningKey(toolOutputSafeStorage).catch(() => null);
  const recoveryGeneration = tempDirRebindGeneration;
  toolOutputSigningKeyRecoveryPromise = recovery;
  toolOutputSigningKeyRecoveryGeneration = recoveryGeneration;
  try {
    const recovered = await recovery;
    if (recoveryGeneration !== tempDirRebindGeneration) {
      return retry ? getToolOutputSigningKey({ retry }) : null;
    }
    toolOutputSigningKeyPromise = Promise.resolve(recovered);
    return recovered;
  } finally {
    if (toolOutputSigningKeyRecoveryPromise === recovery) {
      toolOutputSigningKeyRecoveryPromise = null;
      toolOutputSigningKeyRecoveryGeneration = null;
    }
  }
}

async function ensureToolOutputSigningKeyFile(key, expectedGeneration = tempDirRebindGeneration) {
  if (!isSecureToolOutputStorageAvailable(toolOutputSafeStorage)) return true;
  const keyPath = path.join(getTempDir(), TOOL_OUTPUT_SIGNING_KEY_FILE);
  const mustRevalidateKey = expectedGeneration !== tempDirRebindGeneration;
  try {
    const stat = await fs.promises.lstat(keyPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return false;
    if (stat.nlink !== 1 && !(stat.nlink === 2 && await hasPendingSigningKeyFile(keyPath, stat))) return false;
    if (!mustRevalidateKey) return true;
    const opened = await openSafeToolOutputFile(keyPath, 4096, false);
    if (!opened) return false;
    try {
      const encrypted = await readFileAtMost(opened.file, 4096);
      if (!encrypted) return false;
      const persistedKey = Buffer.from(toolOutputSafeStorage.decryptString(encrypted), "base64");
      return persistedKey.length === key.length
        && crypto.timingSafeEqual(persistedKey, key);
    } finally {
      await opened.file.close().catch(() => {});
    }
  } catch (error) {
    if (error?.code !== "ENOENT" || mustRevalidateKey) return false;
  }
  if (mustRevalidateKey) {
    return false;
  }
  try {
    const encrypted = toolOutputSafeStorage.encryptString(key.toString("base64"));
    await fs.promises.writeFile(keyPath, encrypted, { mode: 0o600, flag: "wx" });
    return true;
  } catch (error) {
    return error?.code === "EEXIST";
  }
}

function unsignedToolOutputManifest(manifest) {
  return {
    record: manifest.record,
    contentFile: manifest.contentFile,
    contentBytes: manifest.contentBytes,
    contentSha256: manifest.contentSha256,
  };
}

function signToolOutputManifest(manifest, key) {
  return crypto.createHmac("sha256", key)
    .update(JSON.stringify(unsignedToolOutputManifest(manifest)))
    .digest("hex");
}

async function hasValidToolOutputManifestSignature(manifest, signingKey) {
  const key = signingKey ?? await getToolOutputSigningKey();
  if (!key || !isBoundedString(manifest.signature, 64) || !/^[a-f0-9]{64}$/.test(manifest.signature)) return false;
  const expected = Buffer.from(signToolOutputManifest(manifest, key), "hex");
  const actual = Buffer.from(manifest.signature, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function resolvePrivateTempDir(systemTempDir = os.tmpdir(), homeDir = os.homedir()) {
  if (typeof process.getuid !== "function") {
    return path.join(systemTempDir, NETCATTY_TEMP_DIR_NAME);
  }
  try {
    const stat = fs.lstatSync(systemTempDir);
    const isPrivate = stat.isDirectory()
      && !stat.isSymbolicLink()
      && stat.uid === process.getuid()
      && (stat.mode & 0o077) === 0;
    if (isPrivate) return path.join(systemTempDir, NETCATTY_TEMP_DIR_NAME);
  } catch {
    // Fall through to the stable per-user directory.
  }
  return path.join(homeDir, ".netcatty", "tmp", NETCATTY_TEMP_DIR_NAME);
}

/**
 * Get the Netcatty temp directory path
 * Creates the directory if it doesn't exist
 */
function getTempDir() {
  if (cachedTempDir) {
    try {
      assertSafeTempDir(cachedTempDir, cachedTempDirIdentity);
      return cachedTempDir;
    } catch (error) {
      // ENOENT: OS/temp cleaner removed the directory. Identity mismatch: the
      // path still exists but was deleted and recreated (new inode). Both are
      // recoverable if the replacement still passes full safety checks below.
      const identityChanged = error?.message === "Netcatty temp directory identity changed during this process.";
      if (error?.code !== "ENOENT" && !identityChanged) throw error;
      cachedTempDir = null;
      cachedTempDirIdentity = null;
      // The previous key file lived on the old inode (or vanished with ENOENT).
      // Drop it so the next getToolOutputSigningKey() reloads from the rebound root.
      tempDirRebindGeneration += 1;
      toolOutputSigningKeyPromise = Promise.resolve(null);
    }
  }
  
  const netcattyTempDir = resolvePrivateTempDir();
  
  try {
    if (!fs.existsSync(netcattyTempDir)) {
      fs.mkdirSync(netcattyTempDir, { recursive: true, mode: 0o700 });
      console.log(`[TempDir] Created Netcatty temp directory: ${netcattyTempDir}`);
    }
    const safeStat = assertSafeTempDir(netcattyTempDir);
    cachedTempDir = netcattyTempDir;
    cachedTempDirIdentity = { dev: safeStat.dev, ino: safeStat.ino };
    return netcattyTempDir;
  } catch (err) {
    console.error(`[TempDir] Failed to create temp directory:`, err.message);
    throw err;
  }
}

function getTempDirRebindGeneration() {
  return tempDirRebindGeneration;
}

function assertSafeTempDir(tempDir, expectedIdentity) {
  const stat = fs.lstatSync(tempDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Netcatty temp path is not a safe directory.");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error("Netcatty temp directory is not owned by the current user.");
  }
  if (expectedIdentity && (stat.dev !== expectedIdentity.dev || stat.ino !== expectedIdentity.ino)) {
    throw new Error("Netcatty temp directory identity changed during this process.");
  }
  fs.chmodSync(tempDir, 0o700);
  const expectedRealPath = path.join(fs.realpathSync(path.dirname(tempDir)), path.basename(tempDir));
  if (fs.realpathSync(tempDir) !== expectedRealPath) {
    throw new Error("Netcatty temp directory must not traverse symbolic links.");
  }
  return stat;
}

/**
 * Ensure the temp directory exists (call on app startup)
 */
function ensureTempDir() {
  const tempDir = getTempDir();
  console.log(`[TempDir] Netcatty temp directory: ${tempDir}`);
  return tempDir;
}

/**
 * Get temp directory info (path, size, file count)
 */
async function getTempDirInfo() {
  const tempDir = getTempDir();
  
  try {
    const files = await fs.promises.readdir(tempDir);
    let totalSize = 0;
    let fileCount = 0;
    
    for (const file of files) {
      if (file === TOOL_OUTPUT_SIGNING_KEY_FILE) continue;
      try {
        const filePath = path.join(tempDir, file);
        const stat = await fs.promises.stat(filePath);
        if (stat.isFile()) {
          totalSize += stat.size;
          fileCount++;
        }
      } catch {
        // Skip files that can't be stat'd
      }
    }
    
    return {
      path: tempDir,
      totalSize,
      fileCount,
    };
  } catch (err) {
    console.error(`[TempDir] Failed to get temp dir info:`, err.message);
    return {
      path: tempDir,
      totalSize: 0,
      fileCount: 0,
    };
  }
}

/**
 * Clear all files in the temp directory
 * Returns the number of files deleted
 */
async function clearTempDir() {
  const tempDir = getTempDir();
  let deletedCount = 0;
  let failedCount = 0;
  const resetUnavailableSigningKey = Boolean(toolOutputSafeStorage)
    && !await getToolOutputSigningKey();
  
  try {
    const files = await fs.promises.readdir(tempDir);
    
    for (const file of files) {
      if (file === TOOL_OUTPUT_SIGNING_KEY_FILE && !resetUnavailableSigningKey) continue;
      try {
        const filePath = path.join(tempDir, file);
        const stat = await fs.promises.stat(filePath);
        
        if (stat.isFile()) {
          await fs.promises.unlink(filePath);
          deletedCount++;
          console.log(`[TempDir] Deleted: ${file}`);
        } else if (stat.isDirectory()) {
          // Recursively delete subdirectories
          await fs.promises.rm(filePath, { recursive: true, force: true });
          deletedCount++;
          console.log(`[TempDir] Deleted directory: ${file}`);
        }
      } catch (err) {
        failedCount++;
        console.log(`[TempDir] Could not delete ${file}: ${err.message}`);
      }
    }

    if (resetUnavailableSigningKey) {
      toolOutputSigningKeyPromise = Promise.resolve(null);
      await getToolOutputSigningKey();
    }
    
    console.log(`[TempDir] Cleanup complete: ${deletedCount} deleted, ${failedCount} failed`);
    return { deletedCount, failedCount };
  } catch (err) {
    console.error(`[TempDir] Failed to clear temp dir:`, err.message);
    return { deletedCount: 0, failedCount: 0, error: err.message };
  }
}

/**
 * Generate a unique temp file path for a given filename
 */
function getTempFilePath(fileName) {
  const tempDir = getTempDir();
  const timestamp = Date.now();
  tempFileCounter = (tempFileCounter + 1) % 1000000;
  const safeFileName = fileName.replace(/[<>:"/\\|?*]/g, "_");
  return path.join(tempDir, `${timestamp}_${tempFileCounter}_${safeFileName}`);
}

function getTransferTempFilePath(transferId, fileName) {
  const tempDir = getTempDir();
  const safeTransferId = String(transferId || "transfer").replace(/[^A-Za-z0-9_-]/g, "_");
  const safeFileName = String(fileName || "file").replace(/[<>:"/\\|?*]/g, "_");
  return path.join(tempDir, `.transfer_${safeTransferId}_${safeFileName}.part`);
}

function isNetcattyTempPath(filePath) {
  if (typeof filePath !== "string" || !filePath) return false;
  const tempDir = path.resolve(getTempDir());
  const resolved = path.resolve(filePath);
  const relative = path.relative(tempDir, resolved);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function openSafeToolOutputFile(
  filePath,
  maxBytes = MAX_TOOL_OUTPUT_TEMP_BYTES,
  requireEvenBytes = true,
  allowSigningKeyPublication = false,
) {
  if (!isNetcattyTempPath(filePath)) return null;
  let file;
  try {
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    file = await fs.promises.open(filePath, fs.constants.O_RDONLY | noFollow);
    const stat = await file.stat();
    assertSafeTempDir(getTempDir(), cachedTempDirIdentity);
    const pathStat = await fs.promises.lstat(filePath);
    if (pathStat.isSymbolicLink() || pathStat.dev !== stat.dev || pathStat.ino !== stat.ino) {
      await file.close();
      return null;
    }
    const publishedSigningKey = allowSigningKeyPublication
      && stat.nlink === 2
      && await hasPendingSigningKeyFile(filePath, stat);
    if (
      !stat.isFile()
      || (!publishedSigningKey && stat.nlink !== 1)
      || stat.size > maxBytes
      || (requireEvenBytes && stat.size % 2 !== 0)
    ) {
      await file.close();
      return null;
    }
    return { file, stat };
  } catch {
    await file?.close().catch(() => {});
    return null;
  }
}

function isBoundedString(value, maxLength, allowEmpty = false) {
  return typeof value === "string"
    && value.length <= maxLength
    && (allowEmpty || value.length > 0);
}

function isSafeToolOutputRecord(record) {
  return record
    && record.schemaVersion === 1
    && isBoundedString(record.handleId, 200)
    && /^[A-Za-z0-9_.-]+$/.test(record.handleId)
    && isBoundedString(record.chatSessionId, 512)
    && isBoundedString(record.capabilityId, 256)
    && (record.terminalSessionId == null || isBoundedString(record.terminalSessionId, 512))
    && Number.isSafeInteger(record.totalChars)
    && record.totalChars >= 0
    && Number.isSafeInteger(record.storedChars)
    && record.storedChars >= 0
    && record.storedChars <= MAX_TOOL_OUTPUT_TEMP_CHARS
    && record.totalChars >= record.storedChars
    && typeof record.sourceTruncated === "boolean"
    && isBoundedString(record.preview, 2_000, true)
    && Number.isFinite(record.storedAt)
    && record.storedAt > 0
    && Number.isFinite(record.accessedAt)
    && record.accessedAt > 0;
}

function toolOutputManifestPath(filePath) {
  return `${filePath}.meta.json`;
}

function toolOutputOwnershipMarker(chatSessionId, terminalSessionId) {
  const digest = value => crypto.createHash("sha256").update(value).digest("hex").slice(0, 24);
  return `_tool-output-${digest(chatSessionId)}-${digest(terminalSessionId ?? "")}-`;
}

async function deleteToolOutputsByOwnership(chatSessionId, terminalSessionId) {
  const tempDir = getTempDir();
  const generation = tempDirRebindGeneration;
  const marker = terminalSessionId == null
    ? `_tool-output-${crypto.createHash("sha256").update(chatSessionId).digest("hex").slice(0, 24)}-`
    : toolOutputOwnershipMarker(chatSessionId, terminalSessionId);
  let deletedCount = 0;
  let files = [];
  try {
    files = await fs.promises.readdir(tempDir);
  } catch {
    return { deletedCount };
  }
  for (const file of files) {
    if (!file.includes(marker) || !file.endsWith(".log")) continue;
    if (await deleteToolOutputPair(path.join(tempDir, file), generation)) deletedCount += 1;
  }
  return { deletedCount };
}

async function deleteToolOutputsByTerminal(terminalSessionId) {
  const tempDir = getTempDir();
  const generation = tempDirRebindGeneration;
  const terminalHash = crypto.createHash("sha256").update(terminalSessionId).digest("hex").slice(0, 24);
  const marker = new RegExp(`_tool-output-[a-f0-9]{24}-${terminalHash}-`);
  let deletedCount = 0;
  let files = [];
  try {
    files = await fs.promises.readdir(tempDir);
  } catch {
    return { deletedCount };
  }
  for (const file of files) {
    if (!marker.test(file) || !file.endsWith(".log")) continue;
    if (await deleteToolOutputPair(path.join(tempDir, file), generation)) deletedCount += 1;
  }
  return { deletedCount };
}

async function safeUnlink(filePath, expectedGeneration) {
  // Deletion must stay bound to the generation that validated this pathname.
  // If the temp root was rebound, the same pathname now addresses the
  // replacement root, so the unlink must abort instead of deleting that data.
  if (expectedGeneration != null && tempDirRebindGeneration !== expectedGeneration) return false;
  if (!isNetcattyTempPath(filePath)) return false;
  try {
    const stat = await fs.promises.lstat(filePath);
    if (expectedGeneration != null && tempDirRebindGeneration !== expectedGeneration) return false;
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    await fs.promises.unlink(filePath);
    return true;
  } catch (error) {
    return error?.code === "ENOENT";
  }
}

async function deleteToolOutputPair(filePath, expectedGeneration) {
  const manifestPath = toolOutputManifestPath(filePath);
  const manifestDeleted = await safeUnlink(manifestPath, expectedGeneration);
  const contentDeleted = await safeUnlink(filePath, expectedGeneration);
  return manifestDeleted && contentDeleted;
}

async function readSafeManifest(manifestPath, signingKey) {
  if (!isNetcattyTempPath(manifestPath) || !manifestPath.endsWith(".log.meta.json")) return null;
  const entryTempDir = getTempDir();
  const entryGeneration = tempDirRebindGeneration;
  let file;
  try {
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    file = await fs.promises.open(manifestPath, fs.constants.O_RDONLY | noFollow);
    const stat = await file.stat();
    const pathStat = await fs.promises.lstat(manifestPath);
    if (
      !stat.isFile()
      || stat.nlink !== 1
      || stat.size > TOOL_OUTPUT_MANIFEST_MAX_BYTES
      || pathStat.isSymbolicLink()
      || pathStat.dev !== stat.dev
      || pathStat.ino !== stat.ino
    ) return null;
    const parsed = JSON.parse(await file.readFile({ encoding: "utf8" }));
    if (!isSafeToolOutputRecord(parsed.record)) return null;
    if (!isBoundedString(parsed.contentFile, 512) || path.basename(parsed.contentFile) !== parsed.contentFile) return null;
    if (!Number.isSafeInteger(parsed.contentBytes) || parsed.contentBytes < 0 || parsed.contentBytes > MAX_TOOL_OUTPUT_TEMP_BYTES) return null;
    if (!isBoundedString(parsed.contentSha256, 64) || !/^[a-f0-9]{64}$/.test(parsed.contentSha256)) return null;
    if (!await hasValidToolOutputManifestSignature(parsed, signingKey)) return null;
    const contentPath = path.join(entryTempDir, parsed.contentFile);
    if (toolOutputManifestPath(contentPath) !== manifestPath) return null;
    if (entryGeneration !== tempDirRebindGeneration || getTempDir() !== entryTempDir) return null;
    return {
      manifest: parsed,
      manifestPath,
      manifestStat: stat,
      contentPath,
      tempDir: entryTempDir,
      tempDirRebindGeneration: entryGeneration,
    };
  } catch {
    return null;
  } finally {
    await file?.close().catch(() => {});
  }
}

async function readSafeManifestWithTempRootRecovery(manifestPath, signingKey, retry = true) {
  const generation = tempDirRebindGeneration;
  const entry = await readSafeManifest(manifestPath, signingKey);
  if (entry || !retry) return entry;
  try {
    getTempDir();
  } catch {
    return null;
  }
  if (generation === tempDirRebindGeneration) return null;
  return readSafeManifest(manifestPath);
}

function isToolOutputEntryStale(entry) {
  if (entry.tempDir != null || entry.tempDirRebindGeneration != null) {
    try {
      if (entry.tempDir != null && entry.tempDir !== getTempDir()) return true;
    } catch {
      // The temp root cannot be resolved right now; treat the entry as stale.
      return true;
    }
    if (entry.tempDirRebindGeneration != null && entry.tempDirRebindGeneration !== tempDirRebindGeneration) {
      return true;
    }
  }
  return false;
}

async function readVerifiedManifestContent(entry) {
  if (isToolOutputEntryStale(entry)) return null;
  const generation = tempDirRebindGeneration;
  const opened = await openSafeToolOutputFile(entry.contentPath);
  if (!opened) return null;
  try {
    // The temp root may be rebound while the content is being read; never
    // verify data across generations because entry.contentPath would then
    // address the replacement root instead of the manifest's own root.
    if (generation !== tempDirRebindGeneration) return null;
    if (opened.stat.size !== entry.manifest.contentBytes) return null;
    const contentBuffer = await opened.file.readFile();
    if (generation !== tempDirRebindGeneration) return null;
    const digest = crypto.createHash("sha256").update(contentBuffer).digest("hex");
    if (digest !== entry.manifest.contentSha256) return null;
    if (generation !== tempDirRebindGeneration) return null;
    return { stat: opened.stat, contentBuffer };
  } finally {
    await opened.file.close();
  }
}

async function verifyManifestContent(entry) {
  return Boolean(await readVerifiedManifestContent(entry));
}

async function listToolOutputManifestEntries(retry = true) {
  const tempDir = getTempDir();
  const generation = tempDirRebindGeneration;
  const entries = [];
  const signingKey = await getToolOutputSigningKey();
  if (generation !== tempDirRebindGeneration) {
    return retry ? listToolOutputManifestEntries(false) : [];
  }
  if (!signingKey) return entries;
  let files = [];
  try {
    files = await fs.promises.readdir(tempDir);
  } catch {
    if (retry) {
      try {
        getTempDir();
      } catch {
        // Return the normal empty result if the temp root cannot recover.
      }
      if (generation !== tempDirRebindGeneration) {
        return listToolOutputManifestEntries(false);
      }
    }
    return entries;
  }
  if (generation !== tempDirRebindGeneration || getTempDir() !== tempDir) {
    return retry ? listToolOutputManifestEntries(false) : [];
  }
  for (const file of files) {
    if (!file.endsWith(".log.meta.json")) continue;
    const entry = await readSafeManifestWithTempRootRecovery(path.join(tempDir, file), signingKey);
    if (generation !== tempDirRebindGeneration || getTempDir() !== tempDir) {
      return retry ? listToolOutputManifestEntries(false) : [];
    }
    if (entry) entries.push(entry);
  }
  if (generation !== tempDirRebindGeneration || getTempDir() !== tempDir) {
    return retry ? listToolOutputManifestEntries(false) : [];
  }
  return entries;
}

async function touchToolOutputEntry(entry, now = new Date()) {
  const tempDir = getTempDir();
  const generation = tempDirRebindGeneration;
  if (
    (entry.tempDir && entry.tempDir !== tempDir)
    || (entry.tempDirRebindGeneration != null && entry.tempDirRebindGeneration !== generation)
    || path.dirname(entry.manifestPath) !== tempDir
  ) return false;
  const key = await getToolOutputSigningKey();
  if (!key || generation !== tempDirRebindGeneration) return false;
  const pendingPath = getTempFilePath(`${entry.manifest.record.handleId}.manifest.pending`);
  if (generation !== tempDirRebindGeneration || path.dirname(pendingPath) !== tempDir) return false;
  const manifest = {
    ...unsignedToolOutputManifest(entry.manifest),
    record: { ...entry.manifest.record, accessedAt: now.getTime() },
  };
  manifest.signature = signToolOutputManifest(manifest, key);
  try {
    await fs.promises.writeFile(pendingPath, JSON.stringify(manifest), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    getTempDir();
    if (generation !== tempDirRebindGeneration) throw createTempDirReboundError();
    await fs.promises.rename(pendingPath, entry.manifestPath);
    getTempDir();
    if (generation !== tempDirRebindGeneration) throw createTempDirReboundError();
    entry.manifest = manifest;
    entry.manifestStat = await fs.promises.stat(entry.manifestPath);
    return true;
  } catch {
    if (generation === tempDirRebindGeneration) await safeUnlink(pendingPath, generation);
    return false;
  }
}

function isToolOutputEntryExpired(entry, now = Date.now()) {
  return now - entry.manifest.record.accessedAt >= TOOL_OUTPUT_PERSISTED_TTL_MS;
}

async function enforcePersistedToolOutputLimits() {
  const entries = await listToolOutputManifestEntries();
  const active = [...entries].sort((a, b) => (
    b.manifest.record.accessedAt - a.manifest.record.accessedAt
  ));
  const kept = [];
  const sessionCounts = new Map();
  const sessionChars = new Map();
  let globalChars = 0;
  for (const entry of active) {
    if (!await verifyManifestContent(entry)) {
      // Never delete a pair whose pathname may now address a rebound root.
      if (!isToolOutputEntryStale(entry)) {
        await deleteToolOutputPair(entry.contentPath, entry.tempDirRebindGeneration);
      }
      continue;
    }
    const { chatSessionId, storedChars } = entry.manifest.record;
    const sessionCount = sessionCounts.get(chatSessionId) ?? 0;
    const sessionTotal = sessionChars.get(chatSessionId) ?? 0;
    const keep = kept.length < TOOL_OUTPUT_MAX_HANDLES_GLOBAL
      && globalChars + storedChars <= TOOL_OUTPUT_MAX_CHARS_GLOBAL
      && sessionCount < TOOL_OUTPUT_MAX_HANDLES_PER_SESSION
      && sessionTotal + storedChars <= TOOL_OUTPUT_MAX_CHARS_PER_SESSION;
    if (!keep) {
      await deleteToolOutputPair(entry.contentPath, entry.tempDirRebindGeneration);
      continue;
    }
    kept.push(entry);
    globalChars += storedChars;
    sessionCounts.set(chatSessionId, sessionCount + 1);
    sessionChars.set(chatSessionId, sessionTotal + storedChars);
  }
}

async function cleanupExpiredToolOutputFiles(now = Date.now()) {
  const tempDir = getTempDir();
  const generation = tempDirRebindGeneration;
  let deletedCount = 0;
  try {
    const files = await fs.promises.readdir(tempDir);
    const signingKeyAvailable = Boolean(await getToolOutputSigningKey());
    const managedContent = new Set();
    for (const file of files) {
      if (
        file.endsWith(".manifest.pending")
        || (file.startsWith(`${TOOL_OUTPUT_SIGNING_KEY_FILE}.`) && file.endsWith(".pending"))
      ) {
        const pendingPath = path.join(tempDir, file);
        try {
          const stat = await fs.promises.lstat(pendingPath);
          if (stat.isFile() && !stat.isSymbolicLink() && now - stat.mtimeMs >= TOOL_OUTPUT_ORPHAN_TTL_MS) {
            if (await safeUnlink(pendingPath, generation)) deletedCount += 1;
          }
        } catch {
          // Best-effort startup cleanup.
        }
        continue;
      }
      if (!file.endsWith(".log.meta.json")) continue;
      const manifestPath = path.join(tempDir, file);
      if (!signingKeyAvailable) {
        try {
          const stat = await fs.promises.lstat(manifestPath);
          if (stat.isSymbolicLink() || !stat.isFile()) continue;
          const contentPath = manifestPath.slice(0, -".meta.json".length);
          if (now - stat.mtimeMs >= TOOL_OUTPUT_PERSISTED_TTL_MS) {
            if (await safeUnlink(manifestPath, generation)) deletedCount += 1;
            if (await safeUnlink(contentPath, generation)) deletedCount += 1;
          } else {
            managedContent.add(path.basename(contentPath));
          }
        } catch {
          // Best-effort startup cleanup.
        }
        continue;
      }
      const entry = await readSafeManifest(manifestPath);
      if (!entry) {
        try {
          const stat = await fs.promises.lstat(manifestPath);
          if (stat.isFile() && !stat.isSymbolicLink() && now - stat.mtimeMs >= TOOL_OUTPUT_ORPHAN_TTL_MS) {
            if (await safeUnlink(manifestPath, generation)) deletedCount += 1;
          }
        } catch {
          // Best-effort startup cleanup.
        }
        continue;
      }
      if (!await verifyManifestContent(entry)) {
        // Never delete a pair whose pathname may now address a rebound root.
        if (!isToolOutputEntryStale(entry)) {
          if (await safeUnlink(entry.manifestPath, generation)) deletedCount += 1;
          if (await safeUnlink(entry.contentPath, generation)) deletedCount += 1;
        }
        continue;
      }
      managedContent.add(path.basename(entry.contentPath));
      if (!isToolOutputEntryExpired(entry, now)) continue;
      if (await safeUnlink(entry.manifestPath, generation)) deletedCount += 1;
      if (await safeUnlink(entry.contentPath, generation)) deletedCount += 1;
    }
    for (const file of files) {
      if (!file.includes("_tool-output-") || !file.endsWith(".log")) continue;
      if (managedContent.has(file)) continue;
      const filePath = path.join(tempDir, file);
      try {
        const stat = await fs.promises.lstat(filePath);
        if (stat.isSymbolicLink() || !stat.isFile()) continue;
        if (now - stat.mtimeMs < TOOL_OUTPUT_ORPHAN_TTL_MS) continue;
        await fs.promises.unlink(filePath);
        deletedCount += 1;
      } catch {
        // Best-effort startup cleanup.
      }
    }
  } catch {
    // Temp persistence is optional; keep startup resilient.
  }
  if (await getToolOutputSigningKey()) {
    await enforcePersistedToolOutputLimits();
  }
  return deletedCount;
}

function safeUtf16SliceBounds(content, requestedStart, requestedEnd) {
  let start = Math.min(content.length, Math.max(0, requestedStart));
  let end = Math.min(content.length, Math.max(start, requestedEnd));
  const isHigh = value => value >= 0xd800 && value <= 0xdbff;
  const isLow = value => value >= 0xdc00 && value <= 0xdfff;
  if (start > 0 && start < content.length && isLow(content.charCodeAt(start))) start -= 1;
  if (end > start && end < content.length && isHigh(content.charCodeAt(end - 1))) end -= 1;
  return [start, end];
}

async function readToolOutputChunk(content, request) {
  const storedChars = content.length;
  const requestedMax = Number.isFinite(request?.maxChars) ? Math.floor(request.maxChars) : TOOL_OUTPUT_READ_MAX_CHARS;
  const maxChars = Math.min(TOOL_OUTPUT_READ_MAX_CHARS, Math.max(1, requestedMax));
  const mode = request?.mode ?? "head";

  if (mode === "search") {
    const query = String(request?.query ?? "");
    if (!query) {
      return { mode, content: "Search query is required.", totalChars: storedChars, startOffset: 0, endOffset: 0, nextOffset: 0, hasMore: false, matchOffsets: [] };
    }
    const haystack = content.toLocaleLowerCase();
    const needle = query.toLocaleLowerCase();
    const offsets = [];
    let cursor = Math.max(0, Math.floor(request?.offset ?? 0));
    while (offsets.length < TOOL_OUTPUT_SEARCH_MAX_MATCHES) {
      const match = haystack.indexOf(needle, cursor);
      if (match < 0) break;
      offsets.push(match);
      cursor = match + Math.max(1, needle.length);
    }
    const excerpts = [];
    const renderedOffsets = [];
    let renderedChars = 0;
    for (const match of offsets) {
      const [start, end] = safeUtf16SliceBounds(content, match - TOOL_OUTPUT_SEARCH_CONTEXT_CHARS, match + query.length + TOOL_OUTPUT_SEARCH_CONTEXT_CHARS);
      const excerpt = `[match offset=${match}]\n${content.slice(start, end)}`;
      const separator = excerpts.length > 0 ? "\n\n" : "";
      const available = maxChars - renderedChars - separator.length;
      if (available <= 0) break;
      if (excerpt.length > available) {
        if (excerpts.length > 0) break;
        const [, safeEnd] = safeUtf16SliceBounds(excerpt, 0, available);
        excerpts.push(excerpt.slice(0, safeEnd));
        renderedOffsets.push(match);
        renderedChars += safeEnd;
        break;
      }
      excerpts.push(excerpt);
      renderedOffsets.push(match);
      renderedChars += separator.length + excerpt.length;
    }
    const nextOffset = renderedOffsets.length
      ? renderedOffsets[renderedOffsets.length - 1] + Math.max(1, query.length)
      : storedChars;
    return {
      mode,
      content: excerpts.join("\n\n") || `No matches found for "${query}".`,
      totalChars: storedChars,
      startOffset: Math.max(0, Math.floor(request?.offset ?? 0)),
      endOffset: nextOffset,
      nextOffset,
      hasMore: haystack.indexOf(needle, nextOffset) >= 0,
      matchOffsets: renderedOffsets,
    };
  }

  let startOffset = mode === "tail"
    ? Math.max(0, storedChars - maxChars)
    : mode === "range" ? Math.min(storedChars, Math.max(0, Math.floor(request?.offset ?? 0))) : 0;
  const readStart = Math.max(0, startOffset - 1);
  const window = content.slice(readStart, Math.min(storedChars, readStart + maxChars + 2));
  const relativeStart = startOffset - readStart;
  const [safeStart, safeEnd] = safeUtf16SliceBounds(window, relativeStart, relativeStart + maxChars);
  startOffset = readStart + safeStart;
  const chunk = window.slice(safeStart, safeEnd);
  const endOffset = startOffset + chunk.length;
  return { mode, content: chunk, totalChars: storedChars, startOffset, endOffset, nextOffset: endOffset, hasMore: endOffset < storedChars };
}

/**
 * Register IPC handlers
 */
function registerHandlers(ipcMain, shell, electronModule) {
  configureToolOutputSigningKey(electronModule);
  void cleanupExpiredToolOutputFiles();
  ipcMain.handle("netcatty:tempdir:getInfo", async () => {
    return getTempDirInfo();
  });
  
  ipcMain.handle("netcatty:tempdir:clear", async () => {
    return clearTempDir();
  });
  
  ipcMain.handle("netcatty:tempdir:getPath", () => {
    return getTempDir();
  });

  ipcMain.handle("netcatty:tempdir:createUploadPath", (_event, payload = {}) => (
    getTransferTempFilePath(payload.transferId, payload.fileName)
  ));
  
  ipcMain.handle("netcatty:tempdir:open", async () => {
    const tempDir = getTempDir();
    if (shell?.openPath) {
      await shell.openPath(tempDir);
      return { success: true };
    }
    return { success: false };
  });

  ipcMain.handle("netcatty:tempdir:toolOutputPersistenceStatus", async () => {
    const durable = Boolean(await getToolOutputSigningKey());
    return {
      durable,
      reason: durable ? undefined : "Secure local storage is unavailable.",
    };
  });

  ipcMain.handle("netcatty:tempdir:toolOutputWrite", async (_event, payload = {}) => {
    const content = String(payload.content ?? "");
    const record = payload.record;
    if (
      !isSafeToolOutputRecord(record)
      || content.length > MAX_TOOL_OUTPUT_TEMP_CHARS
      || record.storedChars !== content.length
    ) {
      return { ok: false, error: "Tool output exceeds the temp-file limit." };
    }
    const contentBuffer = Buffer.from(content, "utf16le");
    if (contentBuffer.length > MAX_TOOL_OUTPUT_TEMP_BYTES) {
      return { ok: false, error: "Tool output exceeds the temp-file limit." };
    }
    const ownershipMarker = toolOutputOwnershipMarker(record.chatSessionId, record.terminalSessionId);
    const chatDeletionGeneration = getToolOutputChatDeletionGeneration(record.chatSessionId);
    const filePath = getTempFilePath(`${ownershipMarker.slice(1)}${record.handleId}.log`);
  const manifestPath = toolOutputManifestPath(filePath);
    const pendingManifestPath = getTempFilePath(`${record.handleId}.manifest.pending`);
    const writeOnce = async attempt => {
      const attemptGeneration = tempDirRebindGeneration;
      let validatedGeneration = attemptGeneration;
      try {
      if (record.terminalSessionId && closedToolOutputTerminalSessions.has(record.terminalSessionId)) {
        throw new Error("Terminal session is already closed.");
      }
      await toolOutputSessionDeletions.get(record.chatSessionId);
      if (getToolOutputChatDeletionGeneration(record.chatSessionId) !== chatDeletionGeneration) {
        throw new Error("Chat session was cleared while output was being saved.");
      }
      let signingKey = await getToolOutputSigningKey();
      if (!signingKey) throw new Error("Secure local storage is unavailable.");
      const signingKeyGeneration = tempDirRebindGeneration;
      if (!await ensureToolOutputSigningKeyFile(signingKey, signingKeyGeneration)) {
        // The temp root may have been rebound after the key was acquired.
        // Reload once so this write cannot sign into the replacement root with
        // a key that only belongs to the old inode.
        toolOutputSigningKeyPromise = Promise.resolve(null);
        signingKey = await getToolOutputSigningKey();
        if (!signingKey || !await ensureToolOutputSigningKeyFile(signingKey, tempDirRebindGeneration)) {
          throw new Error("Unable to prepare secure local storage.");
        }
      }
      validatedGeneration = tempDirRebindGeneration;
      await fs.promises.writeFile(filePath, contentBuffer, { mode: 0o600, flag: "wx" });
      getTempDir();
      if (tempDirRebindGeneration !== validatedGeneration) {
        throw createTempDirReboundError();
      }
      const manifest = {
        record,
        contentFile: path.basename(filePath),
        contentBytes: contentBuffer.length,
        contentSha256: crypto.createHash("sha256").update(contentBuffer).digest("hex"),
      };
      manifest.signature = signToolOutputManifest(manifest, signingKey);
      await fs.promises.writeFile(pendingManifestPath, JSON.stringify(manifest), {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await fs.promises.rename(pendingManifestPath, manifestPath);
      getTempDir();
      if (tempDirRebindGeneration !== validatedGeneration) {
        throw createTempDirReboundError();
      }
      if (getToolOutputChatDeletionGeneration(record.chatSessionId) !== chatDeletionGeneration) {
        await deleteToolOutputPair(filePath, validatedGeneration);
        throw new Error("Chat session was cleared while output was being saved.");
      }
      if (record.terminalSessionId && closedToolOutputTerminalSessions.has(record.terminalSessionId)) {
        await deleteToolOutputPair(filePath, validatedGeneration);
        throw new Error("Terminal session closed while output was being saved.");
      }
      await enforcePersistedToolOutputLimits();
      getTempDir();
      if (tempDirRebindGeneration !== validatedGeneration) {
        throw createTempDirReboundError();
      }
      const persistedEntry = await readSafeManifest(manifestPath);
      if (tempDirRebindGeneration !== validatedGeneration) {
        throw createTempDirReboundError();
      }
      if (!persistedEntry || path.resolve(persistedEntry.contentPath) !== path.resolve(filePath)) {
        throw new Error("Saved output was removed while enforcing storage limits.");
      }
      if (getToolOutputChatDeletionGeneration(record.chatSessionId) !== chatDeletionGeneration) {
        await deleteToolOutputPair(filePath, validatedGeneration);
        throw new Error("Chat session was cleared while output was being saved.");
      }
      if (record.terminalSessionId && closedToolOutputTerminalSessions.has(record.terminalSessionId)) {
        await deleteToolOutputPair(filePath, validatedGeneration);
        throw new Error("Terminal session closed while output was being saved.");
      }
      return { ok: true, path: filePath, manifestPath };
      } catch (error) {
        await Promise.allSettled([
          safeUnlink(pendingManifestPath, validatedGeneration),
          safeUnlink(manifestPath, validatedGeneration),
          safeUnlink(filePath, validatedGeneration),
        ]);
        let tempDirWasRebound = error?.code === TOOL_OUTPUT_TEMP_DIR_REBOUND;
        if (!tempDirWasRebound && error?.code === "ENOENT" && attempt === 0) {
          try {
            getTempDir();
          } catch {
            // The normal error is returned below if the temp root cannot recover.
          }
          tempDirWasRebound = tempDirRebindGeneration !== attemptGeneration;
        }
        if (tempDirWasRebound && attempt === 0) {
          return writeOnce(1);
        }
        return { ok: false, error: error?.message || "Unable to persist tool output." };
      }
    };
    return writeOnce(0);
  });

  ipcMain.handle("netcatty:tempdir:toolOutputRestore", async (_event, payload = {}) => {
    const handleId = String(payload.handleId ?? "");
    const chatSessionId = String(payload.chatSessionId ?? "");
    if (!isBoundedString(handleId, 200) || !isBoundedString(chatSessionId, 512)) return null;
    const restoreOnce = async (attempt) => {
      const chatDeletionGeneration = getToolOutputChatDeletionGeneration(chatSessionId);
      await toolOutputSessionDeletions.get(chatSessionId);
      if (getToolOutputChatDeletionGeneration(chatSessionId) !== chatDeletionGeneration) return null;
      const entries = await listToolOutputManifestEntries();
      const entry = entries.find(candidate => (
        candidate.manifest.record.handleId === handleId
        && candidate.manifest.record.chatSessionId === chatSessionId
      ));
      if (!entry) return null;
      if (
        entry.manifest.record.terminalSessionId
        && closedToolOutputTerminalSessions.has(entry.manifest.record.terminalSessionId)
      ) {
        await deleteToolOutputPair(entry.contentPath, entry.tempDirRebindGeneration);
        return null;
      }
      if (isToolOutputEntryExpired(entry)) {
        await deleteToolOutputPair(entry.contentPath, entry.tempDirRebindGeneration);
        return null;
      }
      if (!await verifyManifestContent(entry)) {
        // A rebound temp root may hold different data at the same pathname;
        // never delete it based on a stale generation's verification failure.
        // Retry enumeration and verification against the current generation
        // instead of reporting a durable handle as missing.
        if (isToolOutputEntryStale(entry)) {
          return attempt === 0 ? restoreOnce(1) : null;
        }
        await deleteToolOutputPair(entry.contentPath, entry.tempDirRebindGeneration);
        return null;
      }
      if (
        entry.manifest.record.terminalSessionId
        && closedToolOutputTerminalSessions.has(entry.manifest.record.terminalSessionId)
      ) {
        await deleteToolOutputPair(entry.contentPath, entry.tempDirRebindGeneration);
        return null;
      }
      await touchToolOutputEntry(entry);
      if (getToolOutputChatDeletionGeneration(chatSessionId) !== chatDeletionGeneration) {
        await deleteToolOutputPair(entry.contentPath, entry.tempDirRebindGeneration);
        return null;
      }
      if (
        entry.manifest.record.terminalSessionId
        && closedToolOutputTerminalSessions.has(entry.manifest.record.terminalSessionId)
      ) {
        await deleteToolOutputPair(entry.contentPath, entry.tempDirRebindGeneration);
        return null;
      }
      return {
        path: entry.contentPath,
        record: entry.manifest.record,
      };
    };
    return restoreOnce(0);
  });

  ipcMain.handle("netcatty:tempdir:toolOutputRead", async (_event, payload = {}) => {
    const filePath = payload.path;
    const readOnce = async (attempt) => {
      const manifestEntry = await readSafeManifestWithTempRootRecovery(toolOutputManifestPath(filePath));
      if (!manifestEntry || path.resolve(manifestEntry.contentPath) !== path.resolve(filePath)) return null;
      const attemptGeneration = manifestEntry.tempDirRebindGeneration;
      // Only remove persisted data while the temp root still matches the
      // manifest's generation; after a rebind the same pathname addresses the
      // replacement root, so the read must be retried instead of deleting
      // current-generation data.
      const deletePairIfCurrentGeneration = async () => {
        if (tempDirRebindGeneration !== attemptGeneration) return;
        await deleteToolOutputPair(manifestEntry.contentPath, attemptGeneration);
      };
      const chatSessionId = manifestEntry.manifest.record.chatSessionId;
      const chatDeletionGeneration = getToolOutputChatDeletionGeneration(chatSessionId);
      await toolOutputSessionDeletions.get(chatSessionId);
      if (getToolOutputChatDeletionGeneration(chatSessionId) !== chatDeletionGeneration) return null;
      if (
        manifestEntry.manifest.record.terminalSessionId
        && closedToolOutputTerminalSessions.has(manifestEntry.manifest.record.terminalSessionId)
      ) {
        await deletePairIfCurrentGeneration();
        return null;
      }
      if (isToolOutputEntryExpired(manifestEntry)) {
        await deletePairIfCurrentGeneration();
        return null;
      }
      const verified = await readVerifiedManifestContent(manifestEntry);
      if (!verified) {
        if (tempDirRebindGeneration !== attemptGeneration) {
          return attempt === 0 ? readOnce(1) : null;
        }
        await deletePairIfCurrentGeneration();
        return null;
      }
      const content = verified.contentBuffer.toString("utf16le");
      const result = !payload.request ? content : await readToolOutputChunk(content, payload.request);
      await touchToolOutputEntry(manifestEntry);
      if (getToolOutputChatDeletionGeneration(chatSessionId) !== chatDeletionGeneration) {
        await deletePairIfCurrentGeneration();
        return null;
      }
      if (
        manifestEntry.manifest.record.terminalSessionId
        && closedToolOutputTerminalSessions.has(manifestEntry.manifest.record.terminalSessionId)
      ) {
        await deletePairIfCurrentGeneration();
        return null;
      }
      return result;
    };
    return readOnce(0);
  });

  ipcMain.handle("netcatty:tempdir:toolOutputDelete", async (_event, payload = {}) => {
    const filePath = payload.path;
    if (!isNetcattyTempPath(filePath)) return { ok: false };
    return { ok: await deleteToolOutputPair(filePath) };
  });

  ipcMain.handle("netcatty:tempdir:toolOutputDeleteSession", async (_event, payload = {}) => {
    const chatSessionId = String(payload.chatSessionId ?? "");
    if (!isBoundedString(chatSessionId, 512)) return { deletedCount: 0 };
    toolOutputChatDeletionGenerations.set(
      chatSessionId,
      getToolOutputChatDeletionGeneration(chatSessionId) + 1,
    );
    const existing = toolOutputSessionDeletions.get(chatSessionId);
    if (existing) return existing;
    const deletion = (async () => {
      return deleteToolOutputsByOwnership(chatSessionId);
    })().finally(() => {
      if (toolOutputSessionDeletions.get(chatSessionId) === deletion) {
        toolOutputSessionDeletions.delete(chatSessionId);
      }
    });
    toolOutputSessionDeletions.set(chatSessionId, deletion);
    return deletion;
  });

  ipcMain.handle("netcatty:tempdir:toolOutputDeleteTerminalSession", async (_event, payload = {}) => {
    const chatSessionId = String(payload.chatSessionId ?? "");
    const terminalSessionId = String(payload.terminalSessionId ?? "");
    if (!isBoundedString(chatSessionId, 512) || !isBoundedString(terminalSessionId, 512)) {
      return { deletedCount: 0 };
    }
    closedToolOutputTerminalSessions.add(terminalSessionId);
    return deleteToolOutputsByOwnership(chatSessionId, terminalSessionId);
  });

  ipcMain.handle("netcatty:tempdir:toolOutputDeleteTerminal", async (_event, payload = {}) => {
    const terminalSessionId = String(payload.terminalSessionId ?? "");
    if (!isBoundedString(terminalSessionId, 512)) return { deletedCount: 0 };
    closedToolOutputTerminalSessions.add(terminalSessionId);
    return deleteToolOutputsByTerminal(terminalSessionId);
  });
}

module.exports = {
  getTempDir,
  getTempDirRebindGeneration,
  ensureTempDir,
  getTempDirInfo,
  clearTempDir,
  getTempFilePath,
  getTransferTempFilePath,
  cleanupExpiredToolOutputFiles,
  registerHandlers,
  resolvePrivateTempDir,
  isSecureToolOutputStorageAvailable,
};
