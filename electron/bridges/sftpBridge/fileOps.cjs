/* eslint-disable no-undef */
function createFileOpsApi(ctx) {
  with (ctx) {
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
            // recursive SFTP path so SDK agent Stop and command timeouts can interrupt
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

    return {
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
    };
  }
}

module.exports = { createFileOpsApi };
