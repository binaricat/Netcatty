const { ipcRenderer, contextBridge } = require("electron");

const dataListeners = new Map();
const exitListeners = new Map();

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
};

// Merge with existing nebula (if any) to avoid stale objects on hot reload
const existing = (typeof window !== "undefined" && window.nebula) ? window.nebula : {};
contextBridge.exposeInMainWorld("nebula", { ...existing, ...api });
