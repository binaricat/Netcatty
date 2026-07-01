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

  return function selectZmodemUploadFiles(webContentsId) {
    const requestId = randomUUIDFn();
    const promise = new Promise((resolve, reject) => {
      pendingRequests.set(requestId, { resolve, reject });
    });
    parentPort.postMessage({
      kind: "zmodem-upload-dialog",
      requestId,
      webContentsId,
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

  return function selectZmodemDownloadDirectory(webContentsId) {
    const requestId = randomUUIDFn();
    const promise = new Promise((resolve, reject) => {
      pendingRequests.set(requestId, { resolve, reject });
    });
    parentPort.postMessage({
      kind: "zmodem-download-dialog",
      requestId,
      webContentsId,
    });
    return promise;
  };
}

function main() {
  const parentPort = process.parentPort;
  if (!parentPort) {
    throw new Error("Terminal worker requires process.parentPort");
  }

  const sessions = new Map();
  const sftpClients = new Map();
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
  const { registerWorkerAiExecHandlers } = require("./aiExec.cjs");
  const deps = {
    sessions,
    sftpClients,
    electronModule,
    selectZmodemUploadFiles,
    selectZmodemDownloadDirectory,
  };

  runtime = createTerminalWorkerRuntime({
    parentPort,
    registerBridges(ipcMain) {
      sshBridge.init(deps);
      terminalBridge.init(deps);
      sftpBridge.init(deps);
      transferBridge.init(deps);
      fileWatcherBridge.init(deps);
      compressUploadBridge.init({
        ...deps,
        transferBridge,
      });
      sshBridge.registerHandlers(ipcMain);
      terminalBridge.registerHandlers(ipcMain);
      sftpBridge.registerHandlers(ipcMain);
      transferBridge.registerHandlers(ipcMain);
      fileWatcherBridge.registerHandlers(ipcMain);
      compressUploadBridge.registerHandlers(ipcMain);
      registerWorkerAiExecHandlers(ipcMain, { sessions });
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
            uploadCommand: uploadCommand || "rz\r",
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
}

if (require.main === module) {
  main();
}

module.exports = {
  createWorkerSender,
  createZmodemDownloadDirectorySelector,
  createZmodemUploadFileSelector,
  normalizeParentPortMessage,
  main,
};
