const { ipcRenderer, contextBridge } = require("electron");

const dataListeners = new Map();
const exitListeners = new Map();
const transferProgressListeners = new Map();
const transferCompleteListeners = new Map();
const transferErrorListeners = new Map();

ipcRenderer.on("nebula:data", (_event, payload) => {
  const set = dataListeners.get(payload.sessionId);
  if (!set) return;
  set.forEach((cb) => {
    try {
      cb(payload.data);
    } catch (err) {
      console.error("Data callback failed", err);
    }
  });
});

ipcRenderer.on("nebula:exit", (_event, payload) => {
  const set = exitListeners.get(payload.sessionId);
  if (set) {
    set.forEach((cb) => {
      try {
        cb(payload);
      } catch (err) {
        console.error("Exit callback failed", err);
      }
    });
  }
  dataListeners.delete(payload.sessionId);
  exitListeners.delete(payload.sessionId);
});

// Transfer progress events
ipcRenderer.on("nebula:transfer:progress", (_event, payload) => {
  const cb = transferProgressListeners.get(payload.transferId);
  if (cb) {
    try {
      cb(payload.transferred, payload.totalBytes, payload.speed);
    } catch (err) {
      console.error("Transfer progress callback failed", err);
    }
  }
});

ipcRenderer.on("nebula:transfer:complete", (_event, payload) => {
  const cb = transferCompleteListeners.get(payload.transferId);
  if (cb) {
    try {
      cb();
    } catch (err) {
      console.error("Transfer complete callback failed", err);
    }
  }
  // Cleanup listeners
  transferProgressListeners.delete(payload.transferId);
  transferCompleteListeners.delete(payload.transferId);
  transferErrorListeners.delete(payload.transferId);
});

ipcRenderer.on("nebula:transfer:error", (_event, payload) => {
  const cb = transferErrorListeners.get(payload.transferId);
  if (cb) {
    try {
      cb(payload.error);
    } catch (err) {
      console.error("Transfer error callback failed", err);
    }
  }
  // Cleanup listeners
  transferProgressListeners.delete(payload.transferId);
  transferCompleteListeners.delete(payload.transferId);
  transferErrorListeners.delete(payload.transferId);
});

const api = {
  startSSHSession: async (options) => {
    const result = await ipcRenderer.invoke("nebula:start", options);
    return result.sessionId;
  },
  startLocalSession: async (options) => {
    const result = await ipcRenderer.invoke("nebula:local:start", options || {});
    return result.sessionId;
  },
  writeToSession: (sessionId, data) => {
    ipcRenderer.send("nebula:write", { sessionId, data });
  },
  execCommand: async (options) => {
    return ipcRenderer.invoke("nebula:ssh:exec", options);
  },
  resizeSession: (sessionId, cols, rows) => {
    ipcRenderer.send("nebula:resize", { sessionId, cols, rows });
  },
  closeSession: (sessionId) => {
    ipcRenderer.send("nebula:close", { sessionId });
  },
  onSessionData: (sessionId, cb) => {
    if (!dataListeners.has(sessionId)) dataListeners.set(sessionId, new Set());
    dataListeners.get(sessionId).add(cb);
    return () => dataListeners.get(sessionId)?.delete(cb);
  },
  onSessionExit: (sessionId, cb) => {
    if (!exitListeners.has(sessionId)) exitListeners.set(sessionId, new Set());
    exitListeners.get(sessionId).add(cb);
    return () => exitListeners.get(sessionId)?.delete(cb);
  },
  openSftp: async (options) => {
    const result = await ipcRenderer.invoke("nebula:sftp:open", options);
    return result.sftpId;
  },
  listSftp: async (sftpId, path) => {
    return ipcRenderer.invoke("nebula:sftp:list", { sftpId, path });
  },
  readSftp: async (sftpId, path) => {
    return ipcRenderer.invoke("nebula:sftp:read", { sftpId, path });
  },
  writeSftp: async (sftpId, path, content) => {
    return ipcRenderer.invoke("nebula:sftp:write", { sftpId, path, content });
  },
  closeSftp: async (sftpId) => {
    return ipcRenderer.invoke("nebula:sftp:close", { sftpId });
  },
  mkdirSftp: async (sftpId, path) => {
    return ipcRenderer.invoke("nebula:sftp:mkdir", { sftpId, path });
  },
  deleteSftp: async (sftpId, path) => {
    return ipcRenderer.invoke("nebula:sftp:delete", { sftpId, path });
  },
  renameSftp: async (sftpId, oldPath, newPath) => {
    return ipcRenderer.invoke("nebula:sftp:rename", { sftpId, oldPath, newPath });
  },
  statSftp: async (sftpId, path) => {
    return ipcRenderer.invoke("nebula:sftp:stat", { sftpId, path });
  },
  chmodSftp: async (sftpId, path, mode) => {
    return ipcRenderer.invoke("nebula:sftp:chmod", { sftpId, path, mode });
  },
  // Local filesystem operations
  listLocalDir: async (path) => {
    return ipcRenderer.invoke("nebula:local:list", { path });
  },
  readLocalFile: async (path) => {
    return ipcRenderer.invoke("nebula:local:read", { path });
  },
  writeLocalFile: async (path, content) => {
    return ipcRenderer.invoke("nebula:local:write", { path, content });
  },
  deleteLocalFile: async (path) => {
    return ipcRenderer.invoke("nebula:local:delete", { path });
  },
  renameLocalFile: async (oldPath, newPath) => {
    return ipcRenderer.invoke("nebula:local:rename", { oldPath, newPath });
  },
  mkdirLocal: async (path) => {
    return ipcRenderer.invoke("nebula:local:mkdir", { path });
  },
  statLocal: async (path) => {
    return ipcRenderer.invoke("nebula:local:stat", { path });
  },
  getHomeDir: async () => {
    return ipcRenderer.invoke("nebula:local:homedir");
  },
  setTheme: async (theme) => {
    return ipcRenderer.invoke("nebula:setTheme", theme);
  },
  // Streaming transfer with real progress
  startStreamTransfer: async (options, onProgress, onComplete, onError) => {
    const { transferId } = options;
    // Register callbacks
    if (onProgress) transferProgressListeners.set(transferId, onProgress);
    if (onComplete) transferCompleteListeners.set(transferId, onComplete);
    if (onError) transferErrorListeners.set(transferId, onError);
    
    return ipcRenderer.invoke("nebula:transfer:start", options);
  },
  cancelTransfer: async (transferId) => {
    // Cleanup listeners
    transferProgressListeners.delete(transferId);
    transferCompleteListeners.delete(transferId);
    transferErrorListeners.delete(transferId);
    return ipcRenderer.invoke("nebula:transfer:cancel", { transferId });
  },
  // Window controls for custom title bar
  windowMinimize: () => ipcRenderer.invoke("nebula:window:minimize"),
  windowMaximize: () => ipcRenderer.invoke("nebula:window:maximize"),
  windowClose: () => ipcRenderer.invoke("nebula:window:close"),
  windowIsMaximized: () => ipcRenderer.invoke("nebula:window:isMaximized"),
};

// Merge with existing nebula (if any) to avoid stale objects on hot reload
const existing = (typeof window !== "undefined" && window.nebula) ? window.nebula : {};
contextBridge.exposeInMainWorld("nebula", { ...existing, ...api });
