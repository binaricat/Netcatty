/**
 * Local Filesystem Bridge - Handles local file operations
 * Extracted from main.cjs for single responsibility
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

/**
 * List files in a local directory
 */
async function listLocalDir(event, payload) {
  const dirPath = payload.path;
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

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
        const stat = await fs.promises.stat(fullPath);
        result[i] = {
          name: entry.name,
          type: entry.isDirectory()
            ? "directory"
            : entry.isSymbolicLink()
              ? "symlink"
              : "file",
          size: `${stat.size} bytes`,
          lastModified: stat.mtime.toISOString(),
        };
      } catch (err) {
        console.warn(`Could not stat ${entry.name}:`, err.message);
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
  await fs.promises.mkdir(payload.path, { recursive: true });
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
  ipcMain.handle("netcatty:local:homedir", getHomeDir);
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
  getHomeDir,
  getSystemInfo,
  readKnownHosts,
};
