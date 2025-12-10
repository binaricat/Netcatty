const { ipcRenderer, contextBridge } = require("electron");

const dataListeners = new Map();
const exitListeners = new Map();
const transferProgressListeners = new Map();
const transferCompleteListeners = new Map();
const transferErrorListeners = new Map();
const chainProgressListeners = new Map();
const authFailedListeners = new Map();

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

// Chain progress events (for jump host connections)
ipcRenderer.on("nebula:chain:progress", (_event, payload) => {
  const { hop, total, label, status } = payload;
  // Notify all registered chain progress listeners
  chainProgressListeners.forEach((cb) => {
    try {
      cb(hop, total, label, status);
    } catch (err) {
      console.error("Chain progress callback failed", err);
    }
  });
});

// Authentication failed events
ipcRenderer.on("nebula:auth:failed", (_event, payload) => {
  const set = authFailedListeners.get(payload.sessionId);
  if (set) {
    set.forEach((cb) => {
      try {
        cb(payload);
      } catch (err) {
        console.error("Auth failed callback failed", err);
      }
    });
  }
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

ipcRenderer.on("nebula:transfer:cancelled", (_event, payload) => {
  // Just cleanup listeners, the UI already knows it's cancelled
  transferProgressListeners.delete(payload.transferId);
  transferCompleteListeners.delete(payload.transferId);
  transferErrorListeners.delete(payload.transferId);
});

// Upload with progress listeners
const uploadProgressListeners = new Map();
const uploadCompleteListeners = new Map();
const uploadErrorListeners = new Map();

ipcRenderer.on("nebula:upload:progress", (_event, payload) => {
  const cb = uploadProgressListeners.get(payload.transferId);
  if (cb) {
    try {
      cb(payload.transferred, payload.totalBytes, payload.speed);
    } catch (err) {
      console.error("Upload progress callback failed", err);
    }
  }
});

ipcRenderer.on("nebula:upload:complete", (_event, payload) => {
  const cb = uploadCompleteListeners.get(payload.transferId);
  if (cb) {
    try {
      cb();
    } catch (err) {
      console.error("Upload complete callback failed", err);
    }
  }
  // Cleanup listeners
  uploadProgressListeners.delete(payload.transferId);
  uploadCompleteListeners.delete(payload.transferId);
  uploadErrorListeners.delete(payload.transferId);
});

ipcRenderer.on("nebula:upload:error", (_event, payload) => {
  const cb = uploadErrorListeners.get(payload.transferId);
  if (cb) {
    try {
      cb(payload.error);
    } catch (err) {
      console.error("Upload error callback failed", err);
    }
  }
  // Cleanup listeners
  uploadProgressListeners.delete(payload.transferId);
  uploadCompleteListeners.delete(payload.transferId);
  uploadErrorListeners.delete(payload.transferId);
});

// Port forwarding status listeners
const portForwardStatusListeners = new Map();

ipcRenderer.on("nebula:portforward:status", (_event, payload) => {
  const { tunnelId, status, error } = payload;
  const callbacks = portForwardStatusListeners.get(tunnelId);
  if (callbacks) {
    callbacks.forEach((cb) => {
      try {
        cb(status, error);
      } catch (err) {
        console.error("Port forward status callback failed", err);
      }
    });
  }
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
  generateKeyPair: async (options) => {
    return ipcRenderer.invoke("nebula:key:generate", options);
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
  onAuthFailed: (sessionId, cb) => {
    if (!authFailedListeners.has(sessionId)) authFailedListeners.set(sessionId, new Set());
    authFailedListeners.get(sessionId).add(cb);
    return () => authFailedListeners.get(sessionId)?.delete(cb);
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
  // Write binary with real-time progress callback
  writeSftpBinaryWithProgress: async (sftpId, path, content, transferId, onProgress, onComplete, onError) => {
    // Register callbacks
    if (onProgress) uploadProgressListeners.set(transferId, onProgress);
    if (onComplete) uploadCompleteListeners.set(transferId, onComplete);
    if (onError) uploadErrorListeners.set(transferId, onError);
    
    return ipcRenderer.invoke("nebula:sftp:writeBinaryWithProgress", { 
      sftpId, 
      path, 
      content, 
      transferId 
    });
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
  // Read system known_hosts file
  readKnownHosts: async () => {
    return ipcRenderer.invoke("nebula:known-hosts:read");
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
  
  // Port Forwarding API
  startPortForward: async (options) => {
    return ipcRenderer.invoke("nebula:portforward:start", options);
  },
  stopPortForward: async (tunnelId) => {
    return ipcRenderer.invoke("nebula:portforward:stop", { tunnelId });
  },
  getPortForwardStatus: async (tunnelId) => {
    return ipcRenderer.invoke("nebula:portforward:status", { tunnelId });
  },
  listPortForwards: async () => {
    return ipcRenderer.invoke("nebula:portforward:list");
  },
  onPortForwardStatus: (tunnelId, cb) => {
    if (!portForwardStatusListeners.has(tunnelId)) {
      portForwardStatusListeners.set(tunnelId, new Set());
    }
    portForwardStatusListeners.get(tunnelId).add(cb);
    return () => {
      portForwardStatusListeners.get(tunnelId)?.delete(cb);
      if (portForwardStatusListeners.get(tunnelId)?.size === 0) {
        portForwardStatusListeners.delete(tunnelId);
      }
    };
  },
  // Chain progress listener for jump host connections
  onChainProgress: (cb) => {
    const id = Date.now().toString() + Math.random().toString(16).slice(2);
    chainProgressListeners.set(id, cb);
    return () => {
      chainProgressListeners.delete(id);
    };
  },
};

// Merge with existing nebula (if any) to avoid stale objects on hot reload
const existing = (typeof window !== "undefined" && window.nebula) ? window.nebula : {};
contextBridge.exposeInMainWorld("nebula", { ...existing, ...api });
