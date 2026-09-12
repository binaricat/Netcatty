"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { createTerminalWorkerRuntime } = require("./runtime.cjs");
const tempDirBridge = require("../bridges/tempDirBridge.cjs");

// The worker owns SSH sessions in the default runtime path. Install the same
// DH compatibility shim as the main process before loading ssh2-backed bridges.
require("../bridges/boringSslDhCompat.cjs").installBoringSslDhCompat();

function createWorkerSender(parentPort, webContentsId) {
  return {
    id: webContentsId,
    isDestroyed() {
      return false;
    },
    send(channel, payload) {
      if (channel === "netcatty:data") {
        const message = {
          kind: "output",
          sessionId: payload?.sessionId,
          data: payload?.data,
        };
        if (payload?.meta) message.meta = payload.meta;
        parentPort.postMessage(message);
        return;
      }
      parentPort.postMessage({
        kind: "renderer-event",
        webContentsId,
        channel,
        payload,
      });
    },
  };
}

function normalizeParentPortMessage(eventOrMessage) {
  if (eventOrMessage && typeof eventOrMessage === "object" && "data" in eventOrMessage) {
    return eventOrMessage.data;
  }
  return eventOrMessage;
}

function createZmodemUploadFileSelector(parentPort, options = {}) {
  const randomUUIDFn = options.randomUUID || randomUUID;
  const pendingRequests = new Map();

  parentPort.on("message", (eventOrMessage) => {
    const message = normalizeParentPortMessage(eventOrMessage);
    if (message?.kind !== "zmodem-upload-dialog-result") return;
    const pending = pendingRequests.get(message.requestId);
    if (!pending) return;
    pendingRequests.delete(message.requestId);
    if (message.error) {
      pending.reject(new Error(message.error));
    } else {
      pending.resolve(message.result || { canceled: true, filePaths: [] });
    }
  });

  return function selectZmodemUploadFiles(webContentsId, sessionId) {
    const requestId = randomUUIDFn();
    const promise = new Promise((resolve, reject) => {
      pendingRequests.set(requestId, { resolve, reject });
    });
    parentPort.postMessage({
      kind: "zmodem-upload-dialog",
      requestId,
      webContentsId,
      sessionId,
    });
    return promise;
  };
}

function createZmodemDownloadDirectorySelector(parentPort, options = {}) {
  const randomUUIDFn = options.randomUUID || randomUUID;
  const pendingRequests = new Map();

  parentPort.on("message", (eventOrMessage) => {
    const message = normalizeParentPortMessage(eventOrMessage);
    if (message?.kind !== "zmodem-download-dialog-result") return;
    const pending = pendingRequests.get(message.requestId);
    if (!pending) return;
    pendingRequests.delete(message.requestId);
    if (message.error) {
      pending.reject(new Error(message.error));
    } else {
      pending.resolve(message.result || { canceled: true, filePaths: [] });
    }
  });

  return function selectZmodemDownloadDirectory(webContentsId, sessionId) {
    const requestId = randomUUIDFn();
    const promise = new Promise((resolve, reject) => {
      pendingRequests.set(requestId, { resolve, reject });
    });
    parentPort.postMessage({
      kind: "zmodem-download-dialog",
      requestId,
      webContentsId,
      sessionId,
    });
    return promise;
  };
}

function registerExternalSessionHandlers(ipcMain, options) {
  const {
    sessions,
    parentPort,
    sessionLogStreamManager,
  } = options;

  const stopSessionLog = async (sessionId, session) => {
    const token = session?.sessionLogToken;
    if (!token) return;
    session.sessionLogToken = null;
    await sessionLogStreamManager.stopStream(sessionId, token);
  };

  ipcMain.handle("netcatty:external:start", async (event, payload) => {
    const sessionId = payload?.sessionId;
    if (typeof sessionId !== "string" || sessionId.length < 1 || sessionId.length > 128) {
      throw new TypeError("External terminal session ID is invalid");
    }
    if (sessions.has(sessionId)) throw new Error("Terminal session already exists");
    const columns = Number(payload?.columns);
    const rows = Number(payload?.rows);
    if (!Number.isInteger(columns) || columns < 1 || columns > 16_384
      || !Number.isInteger(rows) || rows < 1 || rows > 16_384) {
      throw new TypeError("External terminal dimensions are invalid");
    }
    const postEvent = (message) => parentPort.postMessage({
      kind: "external-session-event",
      sessionId,
      ...message,
    });
    let session;
    const stream = {
      write(data) {
        postEvent({ event: "input", data });
        return true;
      },
      setWindow(nextRows, nextColumns) {
        postEvent({ event: "resize", columns: nextColumns, rows: nextRows });
      },
      pause() {
        postEvent({ event: "flow", paused: true });
      },
      resume() {
        postEvent({ event: "flow", paused: false });
      },
      close() {
        void stopSessionLog(sessionId, session).catch(() => {});
        postEvent({ event: "close", reason: "closed" });
      },
    };
    let sessionLogToken = null;
    if (payload?.sessionLog?.enabled && payload.sessionLog.directory) {
      sessionLogToken = sessionLogStreamManager.startStream(sessionId, {
        hostLabel: payload?.hostLabel || payload?.hostname || payload?.protocol || "Plugin",
        hostname: payload?.hostname || payload?.protocol || "plugin",
        directory: payload.sessionLog.directory,
        format: payload.sessionLog.format || "txt",
        timestampsEnabled: Boolean(payload.sessionLog.timestampsEnabled),
        startTime: Date.now(),
      });
    }
    session = {
      type: "plugin",
      protocol: typeof payload?.protocol === "string" ? payload.protocol : "plugin",
      stream,
      cols: columns,
      rows,
      webContentsId: event.sender.id,
      closed: false,
      sessionLogToken,
    };
    sessions.set(sessionId, session);
    return { sessionId };
  });

  ipcMain.handle("netcatty:external:output", async (event, payload) => {
    const session = sessions.get(payload?.sessionId);
    if (!session || session.type !== "plugin" || session.closed) {
      throw new Error("External terminal session is unavailable");
    }
    if (typeof payload?.data !== "string") {
      throw new TypeError("External terminal output is invalid");
    }
    if (payload.data.length > 0) sessionLogStreamManager.appendData(payload.sessionId, payload.data);
    await event.sender.send("netcatty:data", {
      sessionId: payload.sessionId,
      data: payload.data,
      ...(payload.meta === undefined ? {} : { meta: payload.meta }),
    });
    return null;
  });

  ipcMain.handle("netcatty:external:finish", async (event, payload) => {
    const session = sessions.get(payload?.sessionId);
    if (!session || session.type !== "plugin") return null;
    session.closed = true;
    sessions.delete(payload.sessionId);
    await stopSessionLog(payload.sessionId, session);
    event.sender.send("netcatty:exit", {
      sessionId: payload.sessionId,
      exitCode: payload?.reason === "error" ? 1 : 0,
      reason: payload?.reason || "closed",
      ...(payload?.error ? { error: payload.error } : {}),
      ...(Array.isArray(payload?.diagnostics) ? { diagnostics: payload.diagnostics } : {}),
    });
    return null;
  });
}

function registerPortForwardingWorkerBridge(ipcMain) {
  const portForwardingBridge = require("../bridges/portForwardingBridge.cjs");
  portForwardingBridge.registerHandlers(ipcMain);
}

function main() {
  const parentPort = process.parentPort;
  if (!parentPort) {
    throw new Error("Terminal worker requires process.parentPort");
  }

  // Every session lives in this shared worker, so a single stray async error
  // must never hit Node's default exit-with-code-1 behavior. Install the same
  // guards as the main process; without them one unhandled error disconnects
  // all sessions simultaneously ("Terminal worker exited with code 1").
  // Errors are reported to main so they still land in the crash log.
  // Startup errors (before the bridges load and runtime.start() completes)
  // are not suppressed: the guards re-throw those so the worker exits and the
  // manager can reject or replace it instead of hanging pending requests.
  const { installTerminalWorkerErrorGuards } = require("./workerProcessGuards.cjs");

  const reportWorkerError = (origin, err, reason) => {
    try {
      parentPort.postMessage({
        kind: "worker-error",
        origin,
        reason,
        message: err?.message || String(err),
        ...(err?.stack ? { stack: err.stack } : {}),
        ...(err?.code ? { code: err.code } : {}),
        ...(err?.level ? { level: err.level } : {}),
      });
    } catch {
      // Reporting must never be able to escalate into a worker crash.
    }
  };

  let startupComplete = false;
  installTerminalWorkerErrorGuards({
    isRuntimeStarted: () => startupComplete,
    report(origin, err, decision) {
      reportWorkerError(origin, err, decision?.reason);
    },
  });

  const sessions = new Map();
  const sftpClients = new Map();
  const { createTerminalDataPipeline } = require("./terminalDataPipeline.cjs");
  const terminalDataPipeline = createTerminalDataPipeline({
    onWarning: (warning) => parentPort.postMessage({
      kind: "terminal-interceptor-warning",
      warning,
    }),
  });
  let runtime = null;
  const electronModule = {
    webContents: {
      fromId(webContentsId) {
        if (runtime?.createSender) {
          return runtime.createSender(webContentsId);
        }
        return createWorkerSender(parentPort, webContentsId);
      },
    },
  };
  const selectZmodemUploadFiles = createZmodemUploadFileSelector(parentPort);
  const selectZmodemDownloadDirectory = createZmodemDownloadDirectorySelector(parentPort);

  const terminalBridge = require("../bridges/terminalBridge.cjs");
  const sshBridge = require("../bridges/sshBridge.cjs");
  const sftpBridge = require("../bridges/sftpBridge.cjs");
  const transferBridge = require("../bridges/transferBridge.cjs");
  const fileWatcherBridge = require("../bridges/fileWatcherBridge.cjs");
  const compressUploadBridge = require("../bridges/compressUploadBridge.cjs");
  const sessionLogStreamManager = require("../bridges/sessionLogStreamManager.cjs");
  const { registerWorkerAiExecHandlers } = require("./aiExec.cjs");
  const deps = {
    sessions,
    sftpClients,
    electronModule,
    selectZmodemUploadFiles,
    selectZmodemDownloadDirectory,
    terminalDataPipeline,
  };

  runtime = createTerminalWorkerRuntime({
    parentPort,
    terminalDataPipeline,
    reportSuppressedError(origin, err, reason) {
      reportWorkerError(origin, err, reason);
    },
    registerBridges(ipcMain) {
      sshBridge.init(deps);
      terminalBridge.init(deps);
      sftpBridge.init(deps);
      transferBridge.init(deps);
      fileWatcherBridge.init({
        ...deps,
        transferBridge,
      });
      compressUploadBridge.init({
        ...deps,
        transferBridge,
      });
      sshBridge.registerHandlers(ipcMain);
      terminalBridge.registerHandlers(ipcMain);
      sftpBridge.registerHandlers(ipcMain);
      registerPortForwardingWorkerBridge(ipcMain);
      transferBridge.registerHandlers(ipcMain);
      fileWatcherBridge.registerHandlers(ipcMain);
      compressUploadBridge.registerHandlers(ipcMain);
      registerWorkerAiExecHandlers(ipcMain, { sessions });
      registerExternalSessionHandlers(ipcMain, {
        sessions,
        parentPort,
        sessionLogStreamManager,
      });
      // Expose worker-owned active log paths so main-process clear-all can
      // skip live auto-save streams (separate module instance from main).
      require("../bridges/sessionLogsBridge.cjs").registerWorkerHandlers(ipcMain);
      const { createSystemManagerBridge } = require("../bridges/systemManagerBridge.cjs");
      createSystemManagerBridge({
        getSessions: () => sessions,
        execOnEtSession: (...args) => terminalBridge.execOnEtSession(...args),
        ensureMoshStatsConnection: (...args) => sshBridge.ensureMoshStatsConnection(...args),
        process,
      }).registerHandlers(ipcMain);
      ipcMain.on("netcatty:zmodem:cancel", (_event, payload) => {
        sessions.get(payload?.sessionId)?.zmodemSentry?.cancel(payload?.options);
      });
      ipcMain.handle("netcatty:zmodem:drag-drop-upload", async (_event, payload) => {
        const { sessionId, files, uploadCommand } = payload || {};
        const session = sessions.get(sessionId);
        if (!session?.zmodemSentry?.queueDragDropUpload) {
          return { success: false, error: "ZMODEM upload is not available for this session" };
        }
        if (session.zmodemSentry.isActive?.()) {
          return { success: false, error: "ZMODEM transfer already in progress" };
        }

        const filePaths = [];
        const remoteNames = [];
        const tempPaths = [];

        for (const file of files || []) {
          if (!file?.name) continue;
          let localPath = file.path;
          if (!localPath && file.data) {
            localPath = tempDirBridge.getTempFilePath(file.name);
            await fs.promises.writeFile(localPath, Buffer.from(file.data));
            tempPaths.push(localPath);
          }
          if (!localPath) continue;
          try {
            await fs.promises.access(localPath);
          } catch {
            continue;
          }
          filePaths.push(localPath);
          remoteNames.push(file.remoteName || path.basename(localPath));
        }

        if (!filePaths.length) {
          for (const tempPath of tempPaths) {
            try { await fs.promises.unlink(tempPath); } catch { /* ignore */ }
          }
          return { success: false, error: "No readable files to upload" };
        }

        try {
          session.zmodemSentry.queueDragDropUpload({
            filePaths,
            remoteNames,
            uploadCommand: uploadCommand || "rz -y\r",
            tempPaths,
          });
          return { success: true };
        } catch (err) {
          for (const tempPath of tempPaths) {
            try { await fs.promises.unlink(tempPath); } catch { /* ignore */ }
          }
          return { success: false, error: err?.message || String(err) };
        }
      });
    },
  });
  runtime.start();
  // Only after the message listener is installed and all bridges registered
  // is it safe to suppress process-level errors.
  startupComplete = true;
}

if (require.main === module) {
  main();
}

module.exports = {
  createWorkerSender,
  createZmodemDownloadDirectorySelector,
  createZmodemUploadFileSelector,
  normalizeParentPortMessage,
  registerExternalSessionHandlers,
  registerPortForwardingWorkerBridge,
  main,
};
