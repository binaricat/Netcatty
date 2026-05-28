/* eslint-disable no-undef */
function createSftpHandlerApi(ctx) {
  with (ctx) {
    function getSessionSftpEncodingStateKey(chatSessionId, sessionId) {
      if (!chatSessionId || !sessionId) return null;
      return `chat:${chatSessionId}:session:${sessionId}`;
    }
    
    async function withSessionBackedSftp(params, action, options = {}) {
      if (!params?.sessionId) throw new Error("sessionId is required");
      const chatSessionId = typeof params?.chatSessionId === "string" && params.chatSessionId ? params.chatSessionId : null;
      const encodingStateKey = getSessionSftpEncodingStateKey(chatSessionId, params.sessionId);
      const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 0;
      const cancelCleanupGraceMs = Number.isFinite(options.cancelCleanupGraceMs) && options.cancelCleanupGraceMs >= 0
        ? options.cancelCleanupGraceMs
        : 1000;
      const operationName = options.operationName || "SFTP operation";
      const abortController = new AbortController();
      let sftpId = null;
      let timeoutId = null;
      let forceCloseTimer = null;
      let closeRequested = false;
      let closePromise = null;
      let cancellationError = null;
      let timeoutError = null;
      const closeSftpHandle = () => {
        if (!sftpId) {
          return Promise.resolve();
        }
        if (!closePromise) {
          closePromise = Promise.resolve().then(() => sftpBridge.closeSftp(null, { sftpId, encodingStateKey }));
        }
        return closePromise;
      };
      const closeSftpInBackground = () => {
        if (closeRequested) return;
        closeRequested = true;
        void closeSftpHandle().catch(() => {
          // Ignore close failures while cleaning up a cancelled or timed-out handle.
        });
      };
      const requestAbort = (err) => {
        if (!abortController.signal.aborted) {
          abortController.abort(err);
        }
        if (!forceCloseTimer && !closeRequested) {
          forceCloseTimer = setTimeout(() => {
            forceCloseTimer = null;
            closeSftpInBackground();
          }, cancelCleanupGraceMs);
        }
      };
      const unregisterSftpOp = registerSftpOp(chatSessionId, () => {
        if (!cancellationError) {
          cancellationError = new Error("Cancelled");
        }
        requestAbort(cancellationError);
      });
      try {
        if (timeoutMs) {
          timeoutId = setTimeout(() => {
            if (!timeoutError) {
              timeoutError = new Error(`${operationName} timed out after ${timeoutMs}ms`);
            }
            requestAbort(timeoutError);
          }, timeoutMs);
        }
    
        const opened = await sftpBridge.openSftpForSession(null, {
          sessionId: params.sessionId,
          encodingStateKey,
          abortSignal: abortController.signal,
          timeoutMs,
        });
        sftpId = opened?.sftpId;
        if (!sftpId) throw new Error("Failed to open session-backed SFTP handle");
        if (timeoutError) {
          throw timeoutError;
        }
        if (cancellationError) {
          throw cancellationError;
        }
    
        const payload = {
          ...params,
          sftpId,
          abortSignal: abortController.signal,
          timeoutMs,
        };
        const value = await Promise.resolve().then(() => action(payload));
        if (timeoutError) {
          throw timeoutError;
        }
        if (cancellationError) {
          throw cancellationError;
        }
        return value;
      } catch (err) {
        if (timeoutError) {
          throw timeoutError;
        }
        if (cancellationError) {
          throw cancellationError;
        }
        throw err;
      } finally {
        unregisterSftpOp();
        if (timeoutId) clearTimeout(timeoutId);
        if (forceCloseTimer) {
          clearTimeout(forceCloseTimer);
          forceCloseTimer = null;
        }
        try {
          await closeSftpHandle();
        } catch {
          // Ignore close failures for one-off internal SFTP handles.
        }
      }
    }
    
    async function handleSftpList(params) {
      const entries = await withSessionBackedSftp(
        params,
        (payload) => sftpBridge.listSftp(null, payload),
        { timeoutMs: commandTimeoutMs, operationName: "SFTP list" },
      );
      return { ok: true, entries };
    }
    
    async function handleSftpRead(params) {
      if (!params?.path) throw new Error("path is required");
      const content = await withSessionBackedSftp(
        params,
        (payload) => sftpBridge.readSftp(null, payload),
        { timeoutMs: commandTimeoutMs, operationName: "SFTP read" },
      );
      return { ok: true, path: params.path, content };
    }
    
    async function handleSftpWrite(params) {
      if (!params?.path) throw new Error("path is required");
      if (typeof params?.content !== "string") throw new Error("content is required");
      await withSessionBackedSftp(
        params,
        (payload) => sftpBridge.writeSftp(null, payload),
        { timeoutMs: commandTimeoutMs, operationName: "SFTP write" },
      );
      return { ok: true, path: params.path };
    }
    
    async function handleSftpDownload(params) {
      if (!params?.remotePath || !params?.localPath) {
        throw new Error("remotePath and localPath are required");
      }
      const result = await withSessionBackedSftp(
        params,
        (payload) => sftpBridge.downloadSftpToLocal(null, payload),
        { timeoutMs: commandTimeoutMs, operationName: "SFTP download" },
      );
      return { ok: true, ...result };
    }
    
    async function handleSftpUpload(params) {
      if (!params?.remotePath || !params?.localPath) {
        throw new Error("remotePath and localPath are required");
      }
      const result = await withSessionBackedSftp(
        params,
        (payload) => sftpBridge.uploadLocalToSftp(null, payload),
        { timeoutMs: commandTimeoutMs, operationName: "SFTP upload" },
      );
      return { ok: true, ...result };
    }
    
    async function handleSftpMkdir(params) {
      if (!params?.path) throw new Error("path is required");
      await withSessionBackedSftp(
        params,
        (payload) => sftpBridge.mkdirSftp(null, payload),
        { timeoutMs: commandTimeoutMs, operationName: "SFTP mkdir" },
      );
      return { ok: true, path: params.path };
    }
    
    async function handleSftpDelete(params) {
      if (!params?.path) throw new Error("path is required");
      await withSessionBackedSftp(
        params,
        (payload) => sftpBridge.deleteSftp(null, payload),
        { timeoutMs: commandTimeoutMs, operationName: "SFTP delete" },
      );
      return { ok: true, path: params.path };
    }
    
    async function handleSftpRename(params) {
      if (!params?.oldPath || !params?.newPath) {
        throw new Error("oldPath and newPath are required");
      }
      await withSessionBackedSftp(
        params,
        (payload) => sftpBridge.renameSftp(null, payload),
        { timeoutMs: commandTimeoutMs, operationName: "SFTP rename" },
      );
      return { ok: true, oldPath: params.oldPath, newPath: params.newPath };
    }
    
    async function handleSftpStat(params) {
      if (!params?.path) throw new Error("path is required");
      const stat = await withSessionBackedSftp(
        params,
        (payload) => sftpBridge.statSftp(null, payload),
        { timeoutMs: commandTimeoutMs, operationName: "SFTP stat" },
      );
      return { ok: true, stat };
    }
    
    async function handleSftpChmod(params) {
      if (!params?.path || !params?.mode) throw new Error("path and mode are required");
      await withSessionBackedSftp(
        params,
        (payload) => sftpBridge.chmodSftp(null, payload),
        { timeoutMs: commandTimeoutMs, operationName: "SFTP chmod" },
      );
      return { ok: true, path: params.path, mode: params.mode };
    }
    
    async function handleSftpHome(params) {
      const result = await withSessionBackedSftp(
        params,
        (payload) => sftpBridge.getSftpHomeDir(null, payload),
        { timeoutMs: commandTimeoutMs, operationName: "SFTP home" },
      );
      if (!result?.success) {
        throw new Error(result?.error || "Could not determine home directory");
      }
      return { ok: true, homeDir: result.homeDir };
    }

    return {
      getSessionSftpEncodingStateKey,
      withSessionBackedSftp,
      handleSftpList,
      handleSftpRead,
      handleSftpWrite,
      handleSftpDownload,
      handleSftpUpload,
      handleSftpMkdir,
      handleSftpDelete,
      handleSftpRename,
      handleSftpStat,
      handleSftpChmod,
      handleSftpHome,
    };
  }
}

module.exports = { createSftpHandlerApi };
