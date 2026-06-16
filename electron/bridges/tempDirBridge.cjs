/**
 * Temp Directory Bridge - Manages Netcatty's dedicated temp directory
 * 
 * All temporary files (SFTP downloads, etc.) are stored in a dedicated
 * Netcatty folder within the system temp directory for easier cleanup.
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

// Netcatty temp directory name
const NETCATTY_TEMP_DIR_NAME = "Netcatty";

// Cached temp directory path
let cachedTempDir = null;
let tempFileCounter = 0;

/**
 * Get the Netcatty temp directory path
 * Creates the directory if it doesn't exist
 */
function getTempDir() {
  if (cachedTempDir) {
    // Verify it still exists
    try {
      if (fs.existsSync(cachedTempDir)) {
        return cachedTempDir;
      }
    } catch {
      // Directory was deleted, recreate it
    }
  }
  
  const systemTempDir = os.tmpdir();
  const netcattyTempDir = path.join(systemTempDir, NETCATTY_TEMP_DIR_NAME);
  
  try {
    if (!fs.existsSync(netcattyTempDir)) {
      fs.mkdirSync(netcattyTempDir, { recursive: true });
      console.log(`[TempDir] Created Netcatty temp directory: ${netcattyTempDir}`);
    }
    cachedTempDir = netcattyTempDir;
    return netcattyTempDir;
  } catch (err) {
    console.error(`[TempDir] Failed to create temp directory:`, err.message);
    // Fallback to system temp dir
    return systemTempDir;
  }
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
  
  try {
    const files = await fs.promises.readdir(tempDir);
    
    for (const file of files) {
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

/**
 * Register IPC handlers
 */
function registerHandlers(ipcMain, shell) {
  ipcMain.handle("netcatty:tempdir:getInfo", async () => {
    return getTempDirInfo();
  });
  
  ipcMain.handle("netcatty:tempdir:clear", async () => {
    return clearTempDir();
  });
  
  ipcMain.handle("netcatty:tempdir:getPath", () => {
    return getTempDir();
  });
  
  ipcMain.handle("netcatty:tempdir:open", async () => {
    const tempDir = getTempDir();
    if (shell?.openPath) {
      await shell.openPath(tempDir);
      return { success: true };
    }
    return { success: false };
  });
}

module.exports = {
  getTempDir,
  ensureTempDir,
  getTempDirInfo,
  clearTempDir,
  getTempFilePath,
  registerHandlers,
};
