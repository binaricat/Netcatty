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

        result[i] = {
          name: entry.name,
          type,
          linkTarget,
          size: `${stat.size} bytes`,
          lastModified: stat.mtime.toISOString(),
          hidden,
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
              result[i] = {
                name: brokenEntry.name,
                type: "symlink",
                linkTarget: null, // Broken link - target unknown
                size: `${lstat.size} bytes`,
                lastModified: lstat.mtime.toISOString(),
                hidden,
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
 * Read a local file
 */
async function readLocalFile(event, payload) {
  const buffer = await fs.promises.readFile(payload.path);
  return buffer;
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
  const stat = await fs.promises.stat(payload.path);
  if (stat.isDirectory()) {
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
 * Get local file statistics
 */
async function statLocal(event, payload) {
  const stat = await fs.promises.stat(payload.path);
  return {
    name: path.basename(payload.path),
    type: stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "file",
    size: stat.size,
    lastModified: stat.mtime.getTime(),
  };
}

async function collectLocalTreeEntries(rootPath) {
  const rootStat = await fs.promises.stat(rootPath);
  if (!rootStat.isDirectory()) {
    throw new Error("Selected path is not a directory");
  }

  const rootName = path.basename(rootPath);
  const entries = [{
    localPath: rootPath,
    relativePath: rootName,
    type: "directory",
    size: rootStat.size,
    lastModified: rootStat.mtime.getTime(),
  }];
  const queue = [{ localPath: rootPath, relativePath: rootName }];

  while (queue.length > 0) {
    const current = queue.shift();
    const children = await fs.promises.readdir(current.localPath, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));

    for (const child of children) {
      const childPath = path.join(current.localPath, child.name);
      const childRelativePath = `${current.relativePath}/${child.name}`;
      const stat = await fs.promises.stat(childPath);
      const isDirectory = stat.isDirectory();

      entries.push({
        localPath: childPath,
        relativePath: childRelativePath,
        type: isDirectory ? "directory" : "file",
        size: stat.size,
        lastModified: stat.mtime.getTime(),
      });

      if (isDirectory) {
        queue.push({ localPath: childPath, relativePath: childRelativePath });
      }
    }
  }

  return entries;
}

async function listLocalTree(event, payload) {
  return collectLocalTreeEntries(payload.path);
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

/**
 * Register IPC handlers for local filesystem operations
 */
function registerHandlers(ipcMain) {
  ipcMain.handle("netcatty:local:list", listLocalDir);
  ipcMain.handle("netcatty:local:read", readLocalFile);
  ipcMain.handle("netcatty:local:write", writeLocalFile);
  ipcMain.handle("netcatty:local:delete", deleteLocalFile);
  ipcMain.handle("netcatty:local:rename", renameLocalFile);
  ipcMain.handle("netcatty:local:mkdir", mkdirLocal);
  ipcMain.handle("netcatty:local:stat", statLocal);
  ipcMain.handle("netcatty:local:tree", listLocalTree);
  ipcMain.handle("netcatty:local:homedir", getHomeDir);
  ipcMain.handle("netcatty:local:drives", listDrives);
  ipcMain.handle("netcatty:system:info", getSystemInfo);
  ipcMain.handle("netcatty:known-hosts:read", readKnownHosts);
}

module.exports = {
  registerHandlers,
  listLocalDir,
  readLocalFile,
  writeLocalFile,
  deleteLocalFile,
  renameLocalFile,
  mkdirLocal,
  statLocal,
  collectLocalTreeEntries,
  listLocalTree,
  getHomeDir,
  listDrives,
  getSystemInfo,
  readKnownHosts,
  parseAttribOutput,
  listWindowsHiddenBasenames,
};
