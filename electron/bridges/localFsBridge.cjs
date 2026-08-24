/**
 * Local Filesystem Bridge - Handles local file operations
 * Extracted from main.cjs for single responsibility
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const MAX_LOCAL_TREE_DIRECTORIES = 50_000;
const MAX_LOCAL_TREE_ENTRIES = 200_000;
const WINDOWS_ATTRIB_TIMEOUT_MS = 15_000;

function normalizeLocalTreeLimit(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

let cachedLocalUserInfo;
function localOwnerFromStat(stat) {
  if (process.platform === "win32") return undefined;
  if (!stat || typeof stat.uid !== "number") return undefined;
  try {
    cachedLocalUserInfo ??= os.userInfo();
    if (cachedLocalUserInfo.uid === stat.uid && cachedLocalUserInfo.username) {
      return cachedLocalUserInfo.username;
    }
  } catch {
    // userInfo() can throw when the process has no passwd entry.
  }
  return String(stat.uid);
}

function createLocalTreeTraversalBudget(limits = {}) {
  return {
    directories: 0,
    entries: 0,
    maxDirectories: normalizeLocalTreeLimit(limits.maxDirectories, MAX_LOCAL_TREE_DIRECTORIES),
    maxEntries: normalizeLocalTreeLimit(limits.maxEntries, MAX_LOCAL_TREE_ENTRIES),
  };
}

function claimLocalTreeDirectory(budget) {
  if (budget.directories >= budget.maxDirectories) {
    throw new Error(
      `Local directory traversal directory limit exceeded (${budget.maxDirectories}). Select a smaller folder to upload.`,
    );
  }
  budget.directories += 1;
}

function accountLocalTreeEntries(budget, count) {
  const next = budget.entries + Math.max(0, Number(count) || 0);
  if (next > budget.maxEntries) {
    throw new Error(
      `Local directory traversal entry limit exceeded (${budget.maxEntries}). Select a smaller folder to upload.`,
    );
  }
  budget.entries = next;
}

/**
 * Parse the output of `attrib.exe <dir>\*` into a set of basenames whose
 * `H` (hidden) flag is set. Exposed separately so the parser can be
 * unit-tested without spawning a real subprocess.
 *
 * Example attrib output (one entry per line):
 *   A            C:\path\file1.txt
 *        H      C:\path\file2.txt
 *   A    H  R   C:\path\file3.txt
 *        H      C:\path\hidden_dir                [DIR]
 */
function parseAttribOutput(stdout) {
  const hidden = new Set();
  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line) continue;
    // Flags occupy the leading columns. Locate the path by the first
    // drive letter ("C:\") or UNC prefix ("\\server\share"). The `\\\\`
    // alternative has no leading anchor because attrib output has the
    // path inside the line, not at column 0 (leading whitespace holds
    // the attribute flags).
    const pathStart = line.search(/[A-Za-z]:[\\/]|\\\\/);
    if (pathStart < 0) continue;
    const attrPart = line.substring(0, pathStart).toUpperCase();
    if (!attrPart.includes("H")) continue;
    const fullPath = line.substring(pathStart).trim();
    // Some Windows versions append a trailing literal "[DIR]" marker
    // when attrib is invoked with /d. Strip only that exact marker —
    // not any arbitrary bracketed suffix — so legitimate filenames
    // ending in brackets ("Notes [old]", "Draft [v2].md") survive
    // intact and still get matched by hiddenSet.has(entry.name).
    const cleaned = fullPath.replace(/\s+\[DIR\]\s*$/, "");
    // Always use the win32 basename here — attrib output uses backslash
    // separators, and the parser must work under CI on non-Windows hosts.
    const basename = path.win32.basename(cleaned);
    if (basename) hidden.add(basename);
  }
  return hidden;
}

/**
 * Batch-list hidden filenames in a Windows directory.
 *
 * Previously we called `attrib` once per entry inside the concurrency
 * worker loop. On a directory with ~800 files, that spawns ~800 subprocesses
 * and takes ~30 s (see #766). One subprocess call with a wildcard returns
 * the hidden attribute for every entry at once, so we replace the per-file
 * check with a single upfront pass and a Set lookup in the worker.
 *
 * Returns the set of hidden basenames (empty on non-Windows or on failure).
 */
async function listWindowsHiddenBasenames(dirPath) {
  if (process.platform !== "win32") return new Set();
  try {
    const pattern = path.join(dirPath, "*");
    // `/d` is required so attrib.exe also reports directory entries —
    // without it the wildcard is file-centric and hidden folders would
    // be silently omitted from the set, causing the SFTP browser to
    // show them as not-hidden (a regression from the per-file path
    // that passed each entry's full path directly).
    const { stdout } = await execFileAsync("attrib.exe", [pattern, "/d"], {
      maxBuffer: 64 * 1024 * 1024,
      timeout: WINDOWS_ATTRIB_TIMEOUT_MS,
      windowsHide: true,
    });
    return parseAttribOutput(stdout);
  } catch (err) {
    console.warn(`[localFsBridge] Batch attrib failed for ${dirPath}:`, err.message);
    return new Set();
  }
}

/**
 * List files in a local directory
 * Properly handles symlinks by resolving their target type
 * On Windows, also detects hidden files using the hidden attribute
 */
async function listLocalDir(event, payload) {
  const dirPath = payload.path;
  const isWindows = process.platform === "win32";

  // Read directory entries and the Windows hidden-attribute set in
  // parallel. The hidden lookup is a single subprocess that covers every
  // entry in the directory; per-file attrib calls were the ~30 s hotspot
  // that #766 reported on an 800-file directory.
  const [entries, hiddenSet] = await Promise.all([
    fs.promises.readdir(dirPath, { withFileTypes: true }),
    isWindows ? listWindowsHiddenBasenames(dirPath) : Promise.resolve(new Set()),
  ]);

  // Stat entries in parallel with a small concurrency limit.
  // Serial stats can be very slow on Windows for large dirs.
  const CONCURRENCY = 32;
  const result = new Array(entries.length);
  let cursor = 0;

  const worker = async () => {
    while (true) {
      const i = cursor++;
      if (i >= entries.length) return;
      const entry = entries[i];
      try {
        const fullPath = path.join(dirPath, entry.name);
        // fs.promises.stat follows symlinks, so we get the target's stats
        const stat = await fs.promises.stat(fullPath);

        let type;
        let linkTarget = null;

        if (entry.isSymbolicLink()) {
          // This is a symlink - mark it as such and record the target type
          type = "symlink";
          // stat follows symlinks, so stat.isDirectory() tells us if target is a directory
          linkTarget = stat.isDirectory() ? "directory" : "file";
        } else if (entry.isDirectory()) {
          type = "directory";
        } else {
          type = "file";
        }

        // Windows hidden attribute: resolved from the batched lookup.
        const hidden = isWindows ? hiddenSet.has(entry.name) : false;

        // Follow the target for size/mtime/type; owner is the directory entry itself.
        const ownerStat = type === "symlink" ? await fs.promises.lstat(fullPath) : stat;
        const owner = localOwnerFromStat(ownerStat);
        result[i] = {
          name: entry.name,
          type,
          linkTarget,
          size: `${stat.size} bytes`,
          lastModified: stat.mtime.toISOString(),
          hidden,
          ...(owner ? { owner } : {}),
        };
      } catch (err) {
        // Handle broken symlinks - lstat doesn't follow symlinks
        if (err.code === 'ENOENT' || err.code === 'ELOOP') {
          const brokenEntry = entries[i];
          try {
            const fullPath = path.join(dirPath, brokenEntry.name);
            const lstat = await fs.promises.lstat(fullPath);
            if (lstat.isSymbolicLink()) {
              // Broken symlink
              const hidden = isWindows ? hiddenSet.has(brokenEntry.name) : false;
              const owner = localOwnerFromStat(lstat);
              result[i] = {
                name: brokenEntry.name,
                type: "symlink",
                linkTarget: null, // Broken link - target unknown
                size: `${lstat.size} bytes`,
                lastModified: lstat.mtime.toISOString(),
                hidden,
                ...(owner ? { owner } : {}),
              };
              return;
            }
          } catch (lstatErr) {
            console.warn(`Could not lstat ${brokenEntry.name}:`, lstatErr.message);
          }
        }
        console.warn(`Could not stat ${entries[i].name}:`, err.message);
        result[i] = null;
      }
    }
  };

  const workers = Array.from(
    { length: Math.min(CONCURRENCY, entries.length) },
    () => worker(),
  );
  await Promise.all(workers);

  return result.filter(Boolean);
}

/**
 * Read a local file.
 *
 * Optional `maxBytes` returns only the trailing bytes of the file (used by
 * Local Terminal histfile seeding so multi-MB shell histories do not stall
 * the renderer IPC path).
 */
async function readLocalFile(event, payload) {
  const maxBytes =
    Number.isFinite(payload?.maxBytes) && payload.maxBytes > 0
      ? Math.floor(payload.maxBytes)
      : null;
  if (!maxBytes) {
    return fs.promises.readFile(payload.path);
  }

  const handle = await fs.promises.open(payload.path, "r");
  try {
    const { size } = await handle.stat();
    if (size <= maxBytes) {
      const buffer = Buffer.alloc(size);
      await handle.read(buffer, 0, size, 0);
      return buffer;
    }
    const buffer = Buffer.alloc(maxBytes);
    await handle.read(buffer, 0, maxBytes, size - maxBytes);
    return buffer;
  } finally {
    await handle.close();
  }
}

/**
 * Write to a local file
 */
async function writeLocalFile(event, payload) {
  await fs.promises.writeFile(payload.path, Buffer.from(payload.content));
  return true;
}

/**
 * Delete a local file or directory
 */
async function deleteLocalFile(event, payload) {
  const stat = await fs.promises.lstat(payload.path);
  const actualType = stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "file";
  if (payload.expectedType && actualType !== payload.expectedType) {
    const error = new Error(
      `Local target changed before replace: expected ${payload.expectedType}, found ${actualType}`,
    );
    error.code = "ESTALE";
    throw error;
  }
  if (actualType === "directory") {
    await fs.promises.rm(payload.path, { recursive: true, force: true });
  } else {
    await fs.promises.unlink(payload.path);
  }
  return true;
}

/**
 * Rename a local file or directory
 */
async function renameLocalFile(event, payload) {
  await fs.promises.rename(payload.oldPath, payload.newPath);
  return true;
}

/**
 * Create a local directory
 */
async function mkdirLocal(event, payload) {
  try {
    await fs.promises.mkdir(payload.path, { recursive: true });
  } catch (err) {
    // On Windows, mkdir on drive roots (e.g. "E:\") throws EPERM.
    // If the directory already exists, that's fine — ignore the error.
    try {
      const stat = await fs.promises.stat(payload.path);
      if (stat.isDirectory()) return true;
    } catch { /* stat failed, re-throw original */ }
    throw err;
  }
  return true;
}

/**
 * Get local file statistics (follows symlinks — size/mtime of the target).
 * Resume and upload sizing rely on target bytes, not the link node.
 */
async function statLocal(event, payload) {
  const stat = await fs.promises.stat(payload.path);
  return {
    name: path.basename(payload.path),
    type: stat.isDirectory() ? "directory" : "file",
    size: stat.size,
    lastModified: stat.mtime.getTime(),
  };
}

/**
 * Get local path metadata without following symlinks.
 * Conflict resolution needs this so Replace can unlink a link instead of
 * writing through it via writeLocalFile.
 */
async function lstatLocal(event, payload) {
  const stat = await fs.promises.lstat(payload.path);
  return {
    name: path.basename(payload.path),
    type: stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "file",
    size: stat.size,
    lastModified: stat.mtime.getTime(),
  };
}

function throwIfLocalTreeCancelled(isCancelled) {
  if (typeof isCancelled === "function" && isCancelled()) {
    const error = new Error("Local directory traversal cancelled");
    error.code = "ERR_LOCAL_TREE_CANCELLED";
    throw error;
  }
}

const LOCAL_TREE_ENTRY_BATCH_SIZE = 64;

async function collectLocalTreeEntries(rootPath, limits = {}, onProgress, isCancelled, onEntries) {
  const rootStat = await fs.promises.stat(rootPath);
  if (!rootStat.isDirectory()) {
    throw new Error("Selected path is not a directory");
  }
  throwIfLocalTreeCancelled(isCancelled);

  const traversalBudget = createLocalTreeTraversalBudget(limits);
  claimLocalTreeDirectory(traversalBudget);
  const rootName = path.basename(rootPath);
  const rootRealPath = await fs.promises.realpath(rootPath);
  const rootEntry = {
    localPath: rootPath,
    relativePath: rootName,
    type: "directory",
    size: rootStat.size,
    lastModified: rootStat.mtime.getTime(),
  };
  // When streaming batches, avoid retaining the full tree in memory for 100k+
  // drops. Callers that only need the complete array still get it below.
  const retainAll = typeof onEntries !== "function";
  const entries = retainAll ? [rootEntry] : null;
  let pendingBatch = [rootEntry];
  const flushBatch = (force = false) => {
    if (typeof onEntries !== "function") return;
    if (!force && pendingBatch.length < LOCAL_TREE_ENTRY_BATCH_SIZE) return;
    if (pendingBatch.length === 0) return;
    const batch = pendingBatch;
    pendingBatch = [];
    onEntries(batch);
  };
  flushBatch(true);

  const queue = [{
    localPath: rootPath,
    relativePath: rootName,
    ancestorRealPaths: new Set([rootRealPath]),
  }];
  let queueIndex = 0;
  let fileCount = 0;
  let directoryCount = 1;
  let lastReportedTotal = 0;
  const reportProgress = (force = false) => {
    if (typeof onProgress !== "function") return;
    const entryCount = fileCount + directoryCount;
    if (!force && entryCount - lastReportedTotal < 32) return;
    lastReportedTotal = entryCount;
    onProgress({ fileCount, directoryCount, entryCount });
  };
  reportProgress(true);

  while (queueIndex < queue.length) {
    throwIfLocalTreeCancelled(isCancelled);
    const current = queue[queueIndex++];
    const children = await fs.promises.readdir(current.localPath, { withFileTypes: true });
    accountLocalTreeEntries(traversalBudget, children.length);
    children.sort((a, b) => a.name.localeCompare(b.name));

    const metadataConcurrency = 32;
    for (let start = 0; start < children.length; start += metadataConcurrency) {
      throwIfLocalTreeCancelled(isCancelled);
      const inspected = (await Promise.all(
        children.slice(start, start + metadataConcurrency).map(async (child) => {
          const childPath = path.join(current.localPath, child.name);
          const childRelativePath = `${current.relativePath}/${child.name}`;
          try {
            // Use lstat to distinguish links, then stat the target. Directory
            // links retain the established folder-upload behavior, while the
            // real-path ancestor chain prevents junction/symlink cycles.
            const linkStat = await fs.promises.lstat(childPath);
            const stat = linkStat.isSymbolicLink()
              ? await fs.promises.stat(childPath).catch(() => linkStat)
              : linkStat;
            const isDirectory = stat.isDirectory();
            const realPath = isDirectory
              ? await fs.promises.realpath(childPath)
              : null;
            const isCycle = !!realPath && current.ancestorRealPaths.has(realPath);
            const ancestorRealPaths = realPath
              ? new Set([...current.ancestorRealPaths, realPath])
              : current.ancestorRealPaths;
            return {
              childPath,
              childRelativePath,
              stat,
              isDirectory,
              isCycle,
              ancestorRealPaths,
            };
          } catch (error) {
            // A folder can change while it is being scanned. Match the
            // tolerant browser traversal and skip entries that disappear or
            // become inaccessible instead of aborting the whole drop.
            console.warn(`Could not inspect ${childPath}:`, error.message);
            return null;
          }
        }),
      )).filter(Boolean);

      // Promise.all preserves the sorted child order, so restart manifests stay
      // deterministic while metadata I/O is parallelized.
      for (const child of inspected) {
        // Count every directory-shaped alias before cycle suppression. Otherwise
        // a non-cyclic symlink fan-out can expand one real tree thousands of
        // times without consuming the global directory budget.
        if (child.isDirectory) claimLocalTreeDirectory(traversalBudget);
        // Cyclic links cannot be represented by a finite copied tree. Skip the
        // loop itself instead of misreporting it as a file that later fails.
        if (child.isCycle) continue;
        const row = {
          localPath: child.childPath,
          relativePath: child.childRelativePath,
          type: child.isDirectory ? "directory" : "file",
          size: child.stat.size,
          lastModified: child.stat.mtime.getTime(),
        };
        if (retainAll) entries.push(row);
        pendingBatch.push(row);
        if (child.isDirectory) {
          directoryCount += 1;
          queue.push({
            localPath: child.childPath,
            relativePath: child.childRelativePath,
            ancestorRealPaths: child.ancestorRealPaths,
          });
        } else {
          fileCount += 1;
        }
      }
      flushBatch();
      reportProgress();
    }
  }

  throwIfLocalTreeCancelled(isCancelled);
  flushBatch(true);
  reportProgress(true);
  return retainAll ? entries : [];
}

async function listLocalTree(event, payload) {
  const progressChannel = typeof payload?.progressChannel === "string" && payload.progressChannel
    ? payload.progressChannel
    : null;
  const cancelChannel = typeof payload?.cancelChannel === "string" && payload.cancelChannel
    ? payload.cancelChannel
    : null;
  let cancelled = false;
  const onCancel = () => {
    cancelled = true;
  };
  // Lazy-require so unit tests can import collectLocalTreeEntries without a
  // full Electron binary (top-level require("electron") breaks node --test).
  let electronIpcMain = null;
  if (cancelChannel) {
    try {
      electronIpcMain = require("electron").ipcMain;
      electronIpcMain.on(cancelChannel, onCancel);
    } catch {
      electronIpcMain = null;
    }
  }
  const onProgress = progressChannel
    ? (stats) => {
      try {
        event.sender.send(progressChannel, stats);
      } catch {
        // Renderer may have gone away mid-scan.
      }
    }
    : undefined;
  const entriesChannel = typeof payload?.entriesChannel === "string" && payload.entriesChannel
    ? payload.entriesChannel
    : null;
  const onEntries = entriesChannel
    ? (batch) => {
      try {
        // Always send plain arrays for entry batches. The stream end marker is
        // a separate object so the preload can keep its listener until every
        // nested batch has been delivered (invoke reply races with send).
        event.sender.send(entriesChannel, batch);
      } catch {
        // Renderer may have gone away mid-scan.
      }
    }
    : undefined;
  try {
    return await collectLocalTreeEntries(
      payload.path,
      payload.limits || {},
      onProgress,
      () => cancelled,
      onEntries,
    );
  } finally {
    // Must be sent after the last entry batch and before the invoke resolves
    // is not enough alone — preload must wait for this marker before removing
    // its listener, otherwise deep nested files (discovered late) are dropped.
    if (entriesChannel) {
      try {
        event.sender.send(entriesChannel, { type: "tree-end" });
      } catch {
        // Renderer may have gone away mid-scan.
      }
    }
    if (cancelChannel && electronIpcMain) {
      electronIpcMain.removeListener(cancelChannel, onCancel);
    }
  }
}

/**
 * Get the home directory
 */
async function getHomeDir() {
  return os.homedir();
}

/**
 * Get system info (username and hostname)
 */
async function getSystemInfo() {
  return {
    username: os.userInfo().username,
    hostname: os.hostname(),
  };
}

/**
 * Read system known_hosts file
 */
async function readKnownHosts() {
  const homeDir = os.homedir();
  const knownHostsPaths = [];

  if (process.platform === "win32") {
    knownHostsPaths.push(path.join(homeDir, ".ssh", "known_hosts"));
    knownHostsPaths.push(path.join(process.env.PROGRAMDATA || "C:\\ProgramData", "ssh", "known_hosts"));
  } else if (process.platform === "darwin") {
    knownHostsPaths.push(path.join(homeDir, ".ssh", "known_hosts"));
    knownHostsPaths.push("/etc/ssh/ssh_known_hosts");
  } else {
    knownHostsPaths.push(path.join(homeDir, ".ssh", "known_hosts"));
    knownHostsPaths.push("/etc/ssh/ssh_known_hosts");
  }

  let combinedContent = "";

  for (const knownHostsPath of knownHostsPaths) {
    try {
      if (fs.existsSync(knownHostsPath)) {
        const content = fs.readFileSync(knownHostsPath, "utf8");
        if (content.trim()) {
          combinedContent += content + "\n";
        }
      }
    } catch (err) {
      console.warn(`Failed to read known_hosts from ${knownHostsPath}:`, err.message);
    }
  }

  return combinedContent || null;
}

async function listDrives() {
  if (process.platform !== "win32") return [];
  const letters = [];
  for (let i = 65; i <= 90; i++) {
    letters.push(String.fromCharCode(i));
  }
  const results = await Promise.allSettled(
    letters.map((letter) => fs.promises.access(letter + ":\\"))
  );
  return letters.filter((_, idx) => results[idx].status === "fulfilled").map((letter) => letter + ":");
}

async function extractLocalArchive(_event, payload) {
  const { extractLocalArchiveFile } = require("./sftpBridge/archiveExtract.cjs");
  return extractLocalArchiveFile(payload?.path);
}

/**
 * Register IPC handlers for local filesystem operations
 */
function registerHandlers(ipcMain) {
  ipcMain.handle("netcatty:local:list", listLocalDir);
  ipcMain.handle("netcatty:local:read", readLocalFile);
  ipcMain.handle("netcatty:local:write", writeLocalFile);
  ipcMain.handle("netcatty:local:delete", deleteLocalFile);
  ipcMain.handle("netcatty:local:rename", renameLocalFile);
  ipcMain.handle("netcatty:local:extract", extractLocalArchive);
  ipcMain.handle("netcatty:local:mkdir", mkdirLocal);
  ipcMain.handle("netcatty:local:stat", statLocal);
  ipcMain.handle("netcatty:local:lstat", lstatLocal);
  ipcMain.handle("netcatty:local:tree", listLocalTree);
  ipcMain.handle("netcatty:local:homedir", getHomeDir);
  ipcMain.handle("netcatty:local:drives", listDrives);
  ipcMain.handle("netcatty:system:info", getSystemInfo);
  ipcMain.handle("netcatty:known-hosts:read", readKnownHosts);
}

module.exports = {
  WINDOWS_ATTRIB_TIMEOUT_MS,
  registerHandlers,
  listLocalDir,
  readLocalFile,
  writeLocalFile,
  deleteLocalFile,
  renameLocalFile,
  extractLocalArchive,
  mkdirLocal,
  statLocal,
  lstatLocal,
  collectLocalTreeEntries,
  createLocalTreeTraversalBudget,
  MAX_LOCAL_TREE_DIRECTORIES,
  MAX_LOCAL_TREE_ENTRIES,
  listLocalTree,
  getHomeDir,
  listDrives,
  getSystemInfo,
  readKnownHosts,
  parseAttribOutput,
  listWindowsHiddenBasenames,
};
