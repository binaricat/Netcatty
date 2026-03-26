/**
 * Compress Upload Bridge - Handles folder compression and upload
 * 
 * Compresses folders locally using tar, uploads the archive, then extracts on remote server
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { getTempFilePath } = require("./tempDirBridge.cjs");

/**
 * Escape shell arguments to prevent injection attacks
 * Wraps arguments in single quotes and escapes any existing single quotes
 */
function escapeShellArg(arg) {
  // Replace single quotes with '\'' (end quote, escaped quote, start quote)
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

// Shared references
let sftpClients = null;
let transferBridge = null;

// Active compress operations
const activeCompressions = new Map();

/**
 * Initialize the compress upload bridge with dependencies
 */
function init(deps) {
  sftpClients = deps.sftpClients;
  transferBridge = deps.transferBridge;
}

/**
 * Check if tar command is available on the system
 */
async function checkTarAvailable() {
  return new Promise((resolve) => {
    const tar = spawn('tar', ['--version'], { stdio: 'ignore' });
    tar.on('close', (code) => {
      resolve(code === 0);
    });
    tar.on('error', () => {
      resolve(false);
    });
  });
}

/**
 * Check if tar command is available on remote server
 */
async function checkRemoteTarAvailable(sftpId) {
  try {
    const client = sftpClients.get(sftpId);
    if (!client) throw new Error("SFTP session not found");
    
    // Try to execute tar --version via SSH
    const sshClient = client.client; // Get underlying SSH2 client
    if (!sshClient) throw new Error("SSH client not available");
    
    return new Promise((resolve) => {
      sshClient.exec('tar --version', (err, stream) => {
        if (err) {
          resolve(false);
          return;
        }
        
        let hasOutput = false;
        stream.on('data', () => {
          hasOutput = true;
        });
        
        stream.on('close', (code) => {
          resolve(code === 0 && hasOutput);
        });
        
        stream.on('error', () => {
          resolve(false);
        });
      });
    });
  } catch {
    return false;
  }
}

/**
 * Compress a folder using tar
 */
async function compressFolder(folderPath, outputPath, compressionId, sendProgress) {
  return new Promise((resolve, reject) => {
    const compression = activeCompressions.get(compressionId);
    if (!compression) {
      reject(new Error('Compression cancelled'));
      return;
    }

    // Use tar with gzip compression, excluding macOS resource fork files
    // -czf: create, gzip, file
    // -C: change to directory (so we don't include the full path in archive)
    // --exclude='._*': exclude macOS resource fork files
    // --exclude='.DS_Store': exclude macOS folder metadata files
    const folderName = path.basename(folderPath);
    const parentDir = path.dirname(folderPath);
    
    const tar = spawn('tar', [
      '-czf', outputPath, 
      '-C', parentDir, 
      '--exclude=._*',
      '--exclude=.DS_Store',
      '--exclude=.Spotlight-V100',
      '--exclude=.Trashes',
      folderName
    ], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    compression.process = tar;
    let stderr = '';

    // Monitor progress by checking output file size periodically
    const progressInterval = setInterval(async () => {
      if (compression.cancelled) {
        clearInterval(progressInterval);
        return;
      }
      
      try {
        const stat = await fs.promises.stat(outputPath);
        // We don't know the final size, so we'll show indeterminate progress
        sendProgress(stat.size, 0); // 0 means indeterminate
      } catch {
        // File doesn't exist yet, ignore
      }
    }, 500);

    tar.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    tar.on('close', (code) => {
      clearInterval(progressInterval);
      
      if (compression.cancelled) {
        // Clean up output file if cancelled
        fs.promises.unlink(outputPath).catch(() => {});
        reject(new Error('Compression cancelled'));
        return;
      }
      
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Tar compression failed: ${stderr}`));
      }
    });

    tar.on('error', (err) => {
      clearInterval(progressInterval);
      reject(new Error(`Failed to start tar: ${err.message}`));
    });
  });
}

/**
 * Extract archive on remote server
 * @param {string} sftpId - SFTP session ID
 * @param {string} archivePath - Path to the archive on remote server
 * @param {string} targetDir - Target directory for extraction
 * @param {number} [archiveSize] - Size of the archive in bytes (optional, for timeout calculation)
 */
async function extractRemoteArchive(sftpId, archivePath, targetDir, archiveSize) {
  const client = sftpClients.get(sftpId);
  if (!client) throw new Error("SFTP session not found");

  const sshClient = client.client;
  if (!sshClient) throw new Error("SSH client not available");

  // Calculate timeout based on archive size
  // Base: 60 seconds minimum
  // Add 30 seconds per 10MB of archive size
  // Maximum: 10 minutes to prevent excessively long waits
  const baseTimeout = 60000; // 60 seconds minimum
  const maxTimeout = 600000; // 10 minutes maximum
  const sizeBasedTimeout = archiveSize ? Math.ceil(archiveSize / (10 * 1024 * 1024)) * 30000 : 0;
  const extractionTimeout = Math.min(maxTimeout, Math.max(baseTimeout, baseTimeout + sizeBasedTimeout));

  return new Promise((resolve, reject) => {
    // Create target directory, extract, then always clean up the archive
    // Use && for tar success, then always try cleanup regardless of tar result
    // Also exclude any ._* files that might have been included despite our compression exclusions
    // Properly escape shell arguments to prevent injection attacks
    const escapedTargetDir = escapeShellArg(targetDir);
    const escapedArchivePath = escapeShellArg(archivePath);
    const command = `mkdir -p ${escapedTargetDir} && cd ${escapedTargetDir} && tar -xzf ${escapedArchivePath} --exclude='._*' --exclude='.DS_Store' && rm -f ${escapedArchivePath} || (rm -f ${escapedArchivePath}; exit 1)`;

    sshClient.exec(command, (err, stream) => {
      if (err) {
        reject(new Error(`Failed to execute extraction command: ${err.message}`));
        return;
      }

      let stderr = '';
      let resolved = false;

      stream.on('data', () => {
        // stdout not needed, just consume the data
      });

      stream.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      
      stream.on('close', (code) => {
        if (resolved) return;
        resolved = true;

        clearTimeout(timeout);

        // The command uses `;` and `||` so cleanup should always run
        // We only care about the tar extraction success (first part of command)
        // The rm commands are just cleanup and their failure doesn't matter

        // For most cases, code 0 means success
        // If code is not 0, check if it's just cleanup failure
        if (code === 0) {
          resolve();
        } else {
          // Check if the error is from tar extraction or just cleanup
          // If stderr contains tar errors, it's a real extraction failure
          if (stderr.includes('tar:') || stderr.includes('gzip:') || stderr.includes('Cannot open:') || stderr.includes('not found in archive')) {
            reject(new Error(`Remote extraction failed: ${stderr || 'Tar extraction error'}`));
          } else {
            // Likely just cleanup failure - consider it successful if no tar-specific errors
            resolve();
          }
        }
      });
      
      stream.on('error', (err) => {
        if (resolved) return;
        resolved = true;

        clearTimeout(timeout);
        reject(new Error(`Stream error: ${err.message}`));
      });

      // Add timeout to prevent hanging (uses dynamic timeout based on archive size)
      const timeout = setTimeout(() => {
        if (resolved) return;
        resolved = true;

        reject(new Error(`Remote extraction timed out after ${extractionTimeout / 1000} seconds`));
      }, extractionTimeout);
    });
  });
}

/**
 * Start compressed folder upload
 */
async function startCompressedUpload(event, payload) {
  const {
    compressionId,
    folderPath,
    targetPath,
    sftpId,
    folderName
  } = payload;
  const sender = event.sender;

  // Register compression for cancellation
  const compression = { cancelled: false, process: null };
  activeCompressions.set(compressionId, compression);

  const sendProgress = (phase, transferred, total) => {
    if (compression.cancelled) return;
    sender.send("netcatty:compress:progress", { 
      compressionId, 
      phase, 
      transferred, 
      total 
    });
  };

  const sendComplete = () => {
    // Send final 100% progress before completion
    if (!compression.cancelled) {
      sender.send("netcatty:compress:progress", {
        compressionId,
        phase: 'extracting',
        transferred: 100,
        total: 100
      });
    }
    activeCompressions.delete(compressionId);
    sender.send("netcatty:compress:complete", { compressionId });
  };

  const sendError = (error) => {
    activeCompressions.delete(compressionId);
    sender.send("netcatty:compress:error", { 
      compressionId, 
      error: error.message || String(error) 
    });
  };

  // Declare tempArchivePath in outer scope for cleanup access
  let tempArchivePath = null;

  try {
    // Check if tar is available locally and remotely
    const localTarAvailable = await checkTarAvailable();
    if (!localTarAvailable) {
      throw new Error("tar command not available on local system. Please install tar.");
    }

    const remoteTarAvailable = await checkRemoteTarAvailable(sftpId);
    if (!remoteTarAvailable) {
      throw new Error("tar command not available on remote server. Please install tar on the remote system.");
    }

    // Phase 1: Compression (0-30%)
    sendProgress('compressing', 0, 100);
    
    tempArchivePath = getTempFilePath(`${folderName}.tar.gz`);
    
    await compressFolder(folderPath, tempArchivePath, compressionId, (transferred) => {
      // Show compression progress (0-30%)
      sendProgress('compressing', Math.min(30, transferred / 1024 / 1024), 100);
    });

    if (compression.cancelled) {
      try {
        await fs.promises.unlink(tempArchivePath);
      } catch {
        // Ignore cleanup errors
      }
      throw new Error('Upload cancelled');
    }

    // Get compressed file size
    const stat = await fs.promises.stat(tempArchivePath);
    const compressedSize = stat.size;
    
    sendProgress('compressing', 30, 100);

    // Phase 2: Upload (30-90%)
    sendProgress('uploading', 30, 100);

    const remoteArchivePath = `${targetPath}/${folderName}.tar.gz`;

    // Use existing transfer bridge for upload with progress
    const transferId = `compress-${compressionId}`;

    // Progress callback to map upload progress to 30-90%
    const onUploadProgress = (transferred, total, _speed) => {
      if (compression.cancelled) return;
      const uploadProgress = Math.min(60, (transferred / total) * 60);
      sendProgress('uploading', 30 + uploadProgress, 100);
    };

    // Start the transfer with progress callback
    await transferBridge.startTransfer(event, {
      transferId,
      sourcePath: tempArchivePath,
      targetPath: remoteArchivePath,
      sourceType: 'local',
      targetType: 'sftp',
      targetSftpId: sftpId,
      totalBytes: compressedSize
    }, onUploadProgress);

    if (compression.cancelled) {
      await fs.promises.unlink(tempArchivePath).catch(() => {});
      throw new Error('Upload cancelled');
    }

    // Upload completed, update to 90%
    sendProgress('uploading', 90, 100);

    // Phase 3: Extraction (90-100%)
    sendProgress('extracting', 90, 100);

    await extractRemoteArchive(sftpId, remoteArchivePath, targetPath, compressedSize);

    // Update progress to 95% after extraction
    sendProgress('extracting', 95, 100);

    // Perform cleanup operations asynchronously without blocking completion
    // Note: These cleanup operations are best-effort; if the SFTP session closes before
    // cleanup completes, errors will be silently ignored
    setImmediate(async () => {
      // Additional cleanup: remove any ._* files that might have been extracted
      try {
        const client = sftpClients.get(sftpId);
        // Check both that client exists and connection is still open
        if (client && client.client && client.client.writable !== false) {
          const cleanupCommand = `find ${escapeShellArg(targetPath)} -name "._*" -type f -delete 2>/dev/null || true`;
          client.client.exec(cleanupCommand, (err, stream) => {
            if (err) {
              // Silently ignore - session may have closed
              return;
            }

            stream.on('close', () => {
              // Cleanup completed
            });

            stream.on('error', () => {
              // Silently ignore cleanup errors
            });
          });
        }
      } catch {
        // Silently ignore cleanup errors
      }

      // Additional cleanup attempt - ensure remote archive is removed
      try {
        const client = sftpClients.get(sftpId);
        if (client && client.client && client.client.writable !== false) {
          client.client.exec(`rm -f ${escapeShellArg(remoteArchivePath)}`, (err, stream) => {
            if (err) {
              // Silently ignore - session may have closed
              return;
            }

            stream.on('close', () => {
              // Cleanup completed
            });

            stream.on('error', () => {
              // Silently ignore cleanup errors
            });
          });
        }
      } catch {
        // Silently ignore cleanup errors
      }
    });

    // Clean up local temp file
    try {
      await fs.promises.unlink(tempArchivePath);
    } catch {
      // Ignore cleanup errors
    }

    // Check if cancelled during extraction before reporting completion
    if (compression.cancelled) {
      sender.send("netcatty:compress:cancelled", { compressionId });
      return { compressionId, cancelled: true };
    }

    sendComplete();

    return { compressionId, success: true };
  } catch (err) {
    // Clean up local temp file if it exists
    if (tempArchivePath) {
      try {
        await fs.promises.unlink(tempArchivePath);
      } catch {
        // Ignore cleanup errors
      }
    }

    if (err.message === 'Upload cancelled' || err.message === 'Compression cancelled' || err.message === 'Transfer cancelled') {
      activeCompressions.delete(compressionId);
      sender.send("netcatty:compress:cancelled", { compressionId });
    } else {
      sendError(err.message || 'Unknown error occurred');
    }
    return { compressionId, error: err.message };
  } finally {
    // Always clean up the active compression entry
    activeCompressions.delete(compressionId);
  }
}

/**
 * Cancel a compression operation
 */
async function cancelCompression(event, payload) {
  const { compressionId } = payload;
  const compression = activeCompressions.get(compressionId);

  if (compression) {
    compression.cancelled = true;

    // Kill the tar process if running
    if (compression.process) {
      try {
        compression.process.kill('SIGTERM');
      } catch {
        // Ignore errors when killing process
      }
    }

    // Cancel the associated transfer if it's running
    const transferId = `compress-${compressionId}`;
    if (transferBridge && transferBridge.cancelTransfer) {
      try {
        await transferBridge.cancelTransfer(event, { transferId });
      } catch {
        // Ignore errors when cancelling transfer
      }
    }
  }

  return { success: true };
}

/**
 * Check if compressed upload is supported (tar available on both local and remote)
 */
async function checkCompressedUploadSupport(event, payload) {
  const { sftpId } = payload;
  
  try {
    const localSupport = await checkTarAvailable();
    const remoteSupport = await checkRemoteTarAvailable(sftpId);
    
    return {
      supported: localSupport && remoteSupport,
      localTar: localSupport,
      remoteTar: remoteSupport
    };
  } catch (err) {
    return {
      supported: false,
      localTar: false,
      remoteTar: false,
      error: err.message
    };
  }
}

/**
 * Register IPC handlers
 */
function registerHandlers(ipcMain) {
  ipcMain.handle("netcatty:compress:start", startCompressedUpload);
  ipcMain.handle("netcatty:compress:cancel", cancelCompression);
  ipcMain.handle("netcatty:compress:checkSupport", checkCompressedUploadSupport);
}

module.exports = {
  init,
  registerHandlers,
};
