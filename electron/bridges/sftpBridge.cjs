/**
 * SFTP Bridge - Handles SFTP connections and file operations
 * Extracted from main.cjs for single responsibility
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const SftpClient = require("ssh2-sftp-client");
const { NetcattyAgent } = require("./netcattyAgent.cjs");

// SFTP clients storage - shared reference passed from main
let sftpClients = null;
let electronModule = null;

/**
 * Initialize the SFTP bridge with dependencies
 */
function init(deps) {
  sftpClients = deps.sftpClients;
  electronModule = deps.electronModule;
}

/**
 * Open a new SFTP connection
 */
async function openSftp(event, options) {
  const client = new SftpClient();
  const connId = options.sessionId || `${Date.now()}-sftp-${Math.random().toString(16).slice(2)}`;
  const connectOpts = {
    host: options.hostname,
    port: options.port || 22,
    username: options.username || "root",
  };
  
  const hasCertificate = typeof options.certificate === "string" && options.certificate.trim().length > 0;
  const hasBiometric = options.keySource === "biometric" && typeof options.keyId === "string";

  let authAgent = null;
  if (hasCertificate) {
    authAgent = new NetcattyAgent({
      mode: "certificate",
      webContents: event.sender,
      meta: {
        label: options.keyId || options.username || "",
        certificate: options.certificate,
        privateKey: options.privateKey,
        passphrase: options.passphrase,
      },
    });
    connectOpts.agent = authAgent;
  } else if (options.privateKey) {
    connectOpts.privateKey = options.privateKey;
    if (options.passphrase) connectOpts.passphrase = options.passphrase;
  }

  if (options.password) connectOpts.password = options.password;

  if (authAgent) {
    const order = ["agent"];
    if (connectOpts.password) order.push("password");
    connectOpts.authHandler = order;
  }
  
  await client.connect(connectOpts);
  sftpClients.set(connId, client);
  return { sftpId: connId };
}

/**
 * List files in a directory
 */
async function listSftp(event, payload) {
  const client = sftpClients.get(payload.sftpId);
  if (!client) throw new Error("SFTP session not found");
  
  const list = await client.list(payload.path || ".");
  return list.map((item) => ({
    name: item.name,
    type: item.type === "d" ? "directory" : "file",
    size: `${item.size} bytes`,
    lastModified: new Date(item.modifyTime || Date.now()).toISOString(),
  }));
}

/**
 * Read file content
 */
async function readSftp(event, payload) {
  const client = sftpClients.get(payload.sftpId);
  if (!client) throw new Error("SFTP session not found");
  
  const buffer = await client.get(payload.path);
  return buffer.toString();
}

/**
 * Write file content
 */
async function writeSftp(event, payload) {
  const client = sftpClients.get(payload.sftpId);
  if (!client) throw new Error("SFTP session not found");
  
  await client.put(Buffer.from(payload.content, "utf-8"), payload.path);
  return true;
}

/**
 * Write binary data with progress callback
 */
async function writeSftpBinaryWithProgress(event, payload) {
  const client = sftpClients.get(payload.sftpId);
  if (!client) throw new Error("SFTP session not found");
  
  const { sftpId, path: remotePath, content, transferId } = payload;
  const buffer = Buffer.from(content);
  const totalBytes = buffer.length;
  let transferredBytes = 0;
  let lastProgressTime = Date.now();
  let lastTransferredBytes = 0;
  
  const { Readable } = require("stream");
  const readableStream = new Readable({
    read() {
      const chunkSize = 65536;
      if (transferredBytes < totalBytes) {
        const end = Math.min(transferredBytes + chunkSize, totalBytes);
        const chunk = buffer.slice(transferredBytes, end);
        transferredBytes = end;
        
        const now = Date.now();
        const elapsed = (now - lastProgressTime) / 1000;
        let speed = 0;
        if (elapsed >= 0.1) {
          speed = (transferredBytes - lastTransferredBytes) / elapsed;
          lastProgressTime = now;
          lastTransferredBytes = transferredBytes;
        }
        
        const contents = electronModule.webContents.fromId(event.sender.id);
        contents?.send("netcatty:upload:progress", {
          transferId,
          transferred: transferredBytes,
          totalBytes,
          speed,
        });
        
        this.push(chunk);
      } else {
        this.push(null);
      }
    }
  });
  
  try {
    await client.put(readableStream, remotePath);
    
    const contents = electronModule.webContents.fromId(event.sender.id);
    contents?.send("netcatty:upload:complete", { transferId });
    
    return { success: true, transferId };
  } catch (err) {
    const contents = electronModule.webContents.fromId(event.sender.id);
    contents?.send("netcatty:upload:error", { transferId, error: err.message });
    throw err;
  }
}

/**
 * Close an SFTP connection
 */
async function closeSftp(event, payload) {
  const client = sftpClients.get(payload.sftpId);
  if (!client) return;
  
  try {
    await client.end();
  } catch (err) {
    console.warn("SFTP close failed", err);
  }
  sftpClients.delete(payload.sftpId);
}

/**
 * Create a directory
 */
async function mkdirSftp(event, payload) {
  const client = sftpClients.get(payload.sftpId);
  if (!client) throw new Error("SFTP session not found");
  
  await client.mkdir(payload.path, true);
  return true;
}

/**
 * Delete a file or directory
 */
async function deleteSftp(event, payload) {
  const client = sftpClients.get(payload.sftpId);
  if (!client) throw new Error("SFTP session not found");
  
  const stat = await client.stat(payload.path);
  if (stat.isDirectory) {
    await client.rmdir(payload.path, true);
  } else {
    await client.delete(payload.path);
  }
  return true;
}

/**
 * Rename a file or directory
 */
async function renameSftp(event, payload) {
  const client = sftpClients.get(payload.sftpId);
  if (!client) throw new Error("SFTP session not found");
  
  await client.rename(payload.oldPath, payload.newPath);
  return true;
}

/**
 * Get file statistics
 */
async function statSftp(event, payload) {
  const client = sftpClients.get(payload.sftpId);
  if (!client) throw new Error("SFTP session not found");
  
  const stat = await client.stat(payload.path);
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
  
  await client.chmod(payload.path, parseInt(payload.mode, 8));
  return true;
}

/**
 * Register IPC handlers for SFTP operations
 */
function registerHandlers(ipcMain) {
  ipcMain.handle("netcatty:sftp:open", openSftp);
  ipcMain.handle("netcatty:sftp:list", listSftp);
  ipcMain.handle("netcatty:sftp:read", readSftp);
  ipcMain.handle("netcatty:sftp:write", writeSftp);
  ipcMain.handle("netcatty:sftp:writeBinaryWithProgress", writeSftpBinaryWithProgress);
  ipcMain.handle("netcatty:sftp:close", closeSftp);
  ipcMain.handle("netcatty:sftp:mkdir", mkdirSftp);
  ipcMain.handle("netcatty:sftp:delete", deleteSftp);
  ipcMain.handle("netcatty:sftp:rename", renameSftp);
  ipcMain.handle("netcatty:sftp:stat", statSftp);
  ipcMain.handle("netcatty:sftp:chmod", chmodSftp);
}

module.exports = {
  init,
  registerHandlers,
  openSftp,
  listSftp,
  readSftp,
  writeSftp,
  writeSftpBinaryWithProgress,
  closeSftp,
  mkdirSftp,
  deleteSftp,
  renameSftp,
  statSftp,
  chmodSftp,
};
