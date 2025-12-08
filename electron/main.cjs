// Make sure the helper processes do not get forced into Node-only mode.
// Presence of ELECTRON_RUN_AS_NODE (even "0") makes helpers parse Chromium
// switches as Node flags, leading to "bad option: --type=renderer".
if (process.env.ELECTRON_RUN_AS_NODE) {
  delete process.env.ELECTRON_RUN_AS_NODE;
}

let electronModule;
try {
  electronModule = require("node:electron");
} catch {
  electronModule = require("electron");
}
console.log("electron module raw:", electronModule);
console.log("process.versions:", process.versions);
console.log("env ELECTRON_RUN_AS_NODE:", process.env.ELECTRON_RUN_AS_NODE);
const { app, BrowserWindow, nativeTheme } = electronModule || {};
if (!app || !BrowserWindow) {
  throw new Error("Failed to load Electron runtime. Ensure the app is launched with the Electron binary.");
}
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const pty = require("node-pty");
const SftpClient = require("ssh2-sftp-client");
const { Client: SSHClient } = require("ssh2");

// GPU: keep hardware acceleration enabled for smoother rendering
// (If you hit GPU issues, you can restore these switches.)
// app.commandLine.appendSwitch("disable-gpu");
// app.commandLine.appendSwitch("disable-software-rasterizer");
app.commandLine.appendSwitch("no-sandbox");

const devServerUrl = process.env.VITE_DEV_SERVER_URL;
const isDev = !!devServerUrl;
const preload = path.join(__dirname, "preload.cjs");
const isMac = process.platform === "darwin";
const appIcon = path.join(__dirname, "../public/icon.png");

const sessions = new Map();
const sftpClients = new Map();
const keyRoot = path.join(os.homedir(), ".nebula-ssh", "keys");

// On Windows, node-pty with conpty needs full paths to executables
const findExecutable = (name) => {
  if (process.platform !== "win32") return name;
  
  const { execSync } = require("child_process");
  try {
    const result = execSync(`where.exe ${name}`, { encoding: "utf8" });
    const firstLine = result.split(/\r?\n/)[0].trim();
    if (firstLine && fs.existsSync(firstLine)) {
      return firstLine;
    }
  } catch (err) {
    console.warn(`Could not find ${name} via where.exe:`, err.message);
  }
  
  // Fallback to common locations
  const commonPaths = [
    path.join(process.env.SystemRoot || "C:\\Windows", "System32", "OpenSSH", `${name}.exe`),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "usr", "bin", `${name}.exe`),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "OpenSSH", `${name}.exe`),
  ];
  
  for (const p of commonPaths) {
    if (fs.existsSync(p)) return p;
  }
  
  return name; // Fall back to bare name
};

const ensureKeyDir = () => {
  try {
    fs.mkdirSync(keyRoot, { recursive: true, mode: 0o700 });
  } catch (err) {
    console.warn("Unable to ensure key cache dir", err);
  }
};

const writeKeyToDisk = (keyId, privateKey) => {
  if (!privateKey) return null;
  ensureKeyDir();
  const filename = `${keyId || "temp"}.pem`;
  const target = path.join(keyRoot, filename);
  const normalized = privateKey.endsWith("\n") ? privateKey : `${privateKey}\n`;
  try {
    fs.writeFileSync(target, normalized, { mode: 0o600 });
    return target;
  } catch (err) {
    console.error("Failed to persist private key", err);
    return null;
  }
};

const registerSSHBridge = (win) => {
  if (registerSSHBridge._registered) return;
  registerSSHBridge._registered = true;

  // Pure ssh2-based SSH session (no external ssh.exe required)
  const start = (event, options) => {
    return new Promise((resolve, reject) => {
      const sessionId =
        options.sessionId ||
        `${Date.now()}-${Math.random().toString(16).slice(2)}`;

      const conn = new SSHClient();
      const cols = options.cols || 80;
      const rows = options.rows || 24;

      const connectOpts = {
        host: options.hostname,
        port: options.port || 22,
        username: options.username || "root",
        readyTimeout: 30000,
        keepaliveInterval: 10000,
      };

      // Authentication: private key takes precedence
      if (options.privateKey) {
        connectOpts.privateKey = options.privateKey;
        if (options.passphrase) {
          connectOpts.passphrase = options.passphrase;
        }
      } else if (options.password) {
        connectOpts.password = options.password;
      }

      // Agent forwarding
      if (options.agentForwarding) {
        connectOpts.agentForward = true;
        if (process.platform === "win32") {
          connectOpts.agent = "\\\\.\\pipe\\openssh-ssh-agent";
        } else {
          connectOpts.agent = process.env.SSH_AUTH_SOCK;
        }
      }

      conn.on("ready", () => {
        conn.shell(
          {
            term: "xterm-256color",
            cols,
            rows,
            env: { LANG: options.charset || "en_US.UTF-8" },
          },
          (err, stream) => {
            if (err) {
              conn.end();
              reject(err);
              return;
            }

            const session = {
              conn,
              stream,
              webContentsId: event.sender.id,
            };
            sessions.set(sessionId, session);

            stream.on("data", (data) => {
              const contents = BrowserWindow.fromWebContents(event.sender)?.webContents;
              contents?.send("nebula:data", { sessionId, data: data.toString("utf8") });
            });

            stream.stderr?.on("data", (data) => {
              const contents = BrowserWindow.fromWebContents(event.sender)?.webContents;
              contents?.send("nebula:data", { sessionId, data: data.toString("utf8") });
            });

            stream.on("close", () => {
              const contents = BrowserWindow.fromWebContents(event.sender)?.webContents;
              contents?.send("nebula:exit", { sessionId, exitCode: 0 });
              sessions.delete(sessionId);
              conn.end();
            });

            // Run startup command if specified
            if (options.startupCommand) {
              setTimeout(() => {
                stream.write(`${options.startupCommand}\n`);
              }, 300);
            }

            resolve({ sessionId });
          }
        );
      });

      conn.on("error", (err) => {
        console.error("SSH connection error:", err.message);
        const contents = BrowserWindow.fromWebContents(event.sender)?.webContents;
        contents?.send("nebula:exit", { sessionId, exitCode: 1, error: err.message });
        sessions.delete(sessionId);
        reject(err);
      });

      conn.on("close", () => {
        const contents = BrowserWindow.fromWebContents(event.sender)?.webContents;
        contents?.send("nebula:exit", { sessionId, exitCode: 0 });
        sessions.delete(sessionId);
      });

      conn.connect(connectOpts);
    });
  };

  const write = (_event, payload) => {
    const session = sessions.get(payload.sessionId);
    if (!session) return;
    // SSH sessions use stream, local terminal uses proc
    if (session.stream) {
      session.stream.write(payload.data);
    } else if (session.proc) {
      session.proc.write(payload.data);
    }
  };

  const resize = (_event, payload) => {
    const session = sessions.get(payload.sessionId);
    if (!session) return;
    try {
      if (session.stream) {
        // SSH session - use setWindow
        session.stream.setWindow(payload.rows, payload.cols, 0, 0);
      } else if (session.proc) {
        // Local terminal - use resize
        session.proc.resize(payload.cols, payload.rows);
      }
    } catch (err) {
      console.warn("Resize failed", err);
    }
  };

  const close = (_event, payload) => {
    const session = sessions.get(payload.sessionId);
    if (!session) return;
    try {
      if (session.stream) {
        session.stream.close();
        session.conn?.end();
      } else if (session.proc) {
        session.proc.kill();
      }
    } catch (err) {
      console.warn("Close failed", err);
    }
    sessions.delete(payload.sessionId);
  };

  electronModule.ipcMain.handle("nebula:start", start);
  electronModule.ipcMain.handle("nebula:local:start", (event, payload) => {
    const sessionId =
      payload?.sessionId ||
      `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const defaultShell = process.platform === "win32" 
      ? findExecutable("powershell") || "powershell.exe"
      : process.env.SHELL || "/bin/bash";
    const shell = payload?.shell || defaultShell;
    const env = {
      ...process.env,
      ...(payload?.env || {}),
      TERM: "xterm-256color",
    };
    const proc = pty.spawn(shell, [], {
      cols: payload?.cols || 80,
      rows: payload?.rows || 24,
      env,
    });
    const session = {
      proc,
      webContentsId: event.sender.id,
    };
    sessions.set(sessionId, session);
    proc.onData((data) => {
      const contents = electronModule.webContents.fromId(session.webContentsId);
      contents?.send("nebula:data", { sessionId, data });
    });
    proc.onExit((evt) => {
      sessions.delete(sessionId);
      const contents = electronModule.webContents.fromId(session.webContentsId);
      contents?.send("nebula:exit", { sessionId, ...evt });
    });
    return { sessionId };
  });
  electronModule.ipcMain.on("nebula:write", write);
  electronModule.ipcMain.on("nebula:resize", resize);
  electronModule.ipcMain.on("nebula:close", close);

  // One-off hidden exec (for probes like distro detection)
  const execOnce = async (_event, payload) => {
    return new Promise((resolve, reject) => {
      const conn = new SSHClient();
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timeoutMs = payload.timeout || 10000;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        conn.end();
        reject(new Error("SSH exec timeout"));
      }, timeoutMs);

      conn
        .on("ready", () => {
          conn.exec(payload.command, (err, stream) => {
            if (err) {
              clearTimeout(timer);
              settled = true;
              conn.end();
              return reject(err);
            }
            stream
              .on("data", (data) => {
                stdout += data.toString();
              })
              .stderr.on("data", (data) => {
                stderr += data.toString();
              })
              .on("close", (code) => {
                if (settled) return;
                clearTimeout(timer);
                settled = true;
                conn.end();
                resolve({ stdout, stderr, code });
              });
          });
        })
        .on("error", (err) => {
          if (settled) return;
          clearTimeout(timer);
          settled = true;
          reject(err);
        })
        .on("end", () => {
          if (settled) return;
          clearTimeout(timer);
          settled = true;
          resolve({ stdout, stderr, code: null });
        });

      conn.connect({
        host: payload.hostname,
        port: payload.port || 22,
        username: payload.username,
        password: payload.password,
        privateKey: payload.privateKey,
        readyTimeout: timeoutMs,
        keepaliveInterval: 0,
      });
    });
  };

  electronModule.ipcMain.handle("nebula:ssh:exec", execOnce);

  // SFTP handlers
  const openSftp = async (_event, options) => {
    const client = new SftpClient();
    const connId = options.sessionId || `${Date.now()}-sftp-${Math.random().toString(16).slice(2)}`;
    const connectOpts = {
      host: options.hostname,
      port: options.port || 22,
      username: options.username || "root",
    };
    if (options.privateKey) {
      connectOpts.privateKey = options.privateKey;
    } else if (options.password) {
      connectOpts.password = options.password;
    }
    await client.connect(connectOpts);
    sftpClients.set(connId, client);
    return { sftpId: connId };
  };

  const listSftp = async (_event, payload) => {
    const client = sftpClients.get(payload.sftpId);
    if (!client) throw new Error("SFTP session not found");
    const list = await client.list(payload.path || ".");
    return list.map((item) => ({
      name: item.name,
      type: item.type === "d" ? "directory" : "file",
      size: `${item.size} bytes`,
      lastModified: new Date(item.modifyTime || Date.now()).toISOString(),
    }));
  };

  const readSftp = async (_event, payload) => {
    const client = sftpClients.get(payload.sftpId);
    if (!client) throw new Error("SFTP session not found");
    const buffer = await client.get(payload.path);
    return buffer.toString();
  };

  const writeSftp = async (_event, payload) => {
    const client = sftpClients.get(payload.sftpId);
    if (!client) throw new Error("SFTP session not found");
    await client.put(Buffer.from(payload.content, "utf-8"), payload.path);
    return true;
  };

  const closeSftp = async (_event, payload) => {
    const client = sftpClients.get(payload.sftpId);
    if (!client) return;
    try {
      await client.end();
    } catch (err) {
      console.warn("SFTP close failed", err);
    }
    sftpClients.delete(payload.sftpId);
  };

  const mkdirSftp = async (_event, payload) => {
    const client = sftpClients.get(payload.sftpId);
    if (!client) throw new Error("SFTP session not found");
    await client.mkdir(payload.path, true);
    return true;
  };

  // Delete file or directory via SFTP
  const deleteSftp = async (_event, payload) => {
    const client = sftpClients.get(payload.sftpId);
    if (!client) throw new Error("SFTP session not found");
    
    // Check if it's a directory or file
    const stat = await client.stat(payload.path);
    if (stat.isDirectory) {
      await client.rmdir(payload.path, true); // recursive delete
    } else {
      await client.delete(payload.path);
    }
    return true;
  };

  // Rename file or directory via SFTP
  const renameSftp = async (_event, payload) => {
    const client = sftpClients.get(payload.sftpId);
    if (!client) throw new Error("SFTP session not found");
    await client.rename(payload.oldPath, payload.newPath);
    return true;
  };

  // Stat file via SFTP
  const statSftp = async (_event, payload) => {
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
  };

  // Change permissions via SFTP
  const chmodSftp = async (_event, payload) => {
    const client = sftpClients.get(payload.sftpId);
    if (!client) throw new Error("SFTP session not found");
    await client.chmod(payload.path, parseInt(payload.mode, 8));
    return true;
  };

  // Local filesystem operations
  const listLocalDir = async (_event, payload) => {
    const dirPath = payload.path;
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    const result = [];
    
    for (const entry of entries) {
      try {
        const fullPath = path.join(dirPath, entry.name);
        const stat = await fs.promises.stat(fullPath);
        result.push({
          name: entry.name,
          type: entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file",
          size: `${stat.size} bytes`,
          lastModified: stat.mtime.toISOString(),
        });
      } catch (err) {
        // Skip files we can't stat (permission denied, etc.)
        console.warn(`Could not stat ${entry.name}:`, err.message);
      }
    }
    return result;
  };

  const readLocalFile = async (_event, payload) => {
    const buffer = await fs.promises.readFile(payload.path);
    return buffer;
  };

  const writeLocalFile = async (_event, payload) => {
    await fs.promises.writeFile(payload.path, Buffer.from(payload.content));
    return true;
  };

  const deleteLocalFile = async (_event, payload) => {
    const stat = await fs.promises.stat(payload.path);
    if (stat.isDirectory()) {
      await fs.promises.rm(payload.path, { recursive: true, force: true });
    } else {
      await fs.promises.unlink(payload.path);
    }
    return true;
  };

  const renameLocalFile = async (_event, payload) => {
    await fs.promises.rename(payload.oldPath, payload.newPath);
    return true;
  };

  const mkdirLocal = async (_event, payload) => {
    await fs.promises.mkdir(payload.path, { recursive: true });
    return true;
  };

  const statLocal = async (_event, payload) => {
    const stat = await fs.promises.stat(payload.path);
    return {
      name: path.basename(payload.path),
      type: stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "file",
      size: stat.size,
      lastModified: stat.mtime.getTime(),
    };
  };

  const getHomeDir = async () => {
    return os.homedir();
  };

  electronModule.ipcMain.handle("nebula:sftp:open", openSftp);
  electronModule.ipcMain.handle("nebula:sftp:list", listSftp);
  electronModule.ipcMain.handle("nebula:sftp:read", readSftp);
  electronModule.ipcMain.handle("nebula:sftp:write", writeSftp);
  electronModule.ipcMain.handle("nebula:sftp:close", closeSftp);
  electronModule.ipcMain.handle("nebula:sftp:mkdir", mkdirSftp);
  electronModule.ipcMain.handle("nebula:sftp:delete", deleteSftp);
  electronModule.ipcMain.handle("nebula:sftp:rename", renameSftp);
  electronModule.ipcMain.handle("nebula:sftp:stat", statSftp);
  electronModule.ipcMain.handle("nebula:sftp:chmod", chmodSftp);
  
  // Local filesystem handlers
  electronModule.ipcMain.handle("nebula:local:list", listLocalDir);
  electronModule.ipcMain.handle("nebula:local:read", readLocalFile);
  electronModule.ipcMain.handle("nebula:local:write", writeLocalFile);
  electronModule.ipcMain.handle("nebula:local:delete", deleteLocalFile);
  electronModule.ipcMain.handle("nebula:local:rename", renameLocalFile);
  electronModule.ipcMain.handle("nebula:local:mkdir", mkdirLocal);
  electronModule.ipcMain.handle("nebula:local:stat", statLocal);
  electronModule.ipcMain.handle("nebula:local:homedir", getHomeDir);
  
  // Streaming transfer with progress and cancellation support
  const activeTransfers = new Map(); // transferId -> { cancelled: boolean, stream?: ReadableStream }
  
  const startTransfer = async (event, payload) => {
    const { transferId, sourcePath, targetPath, sourceType, targetType, sourceSftpId, targetSftpId, totalBytes } = payload;
    const sender = event.sender;
    
    // Register transfer for cancellation
    activeTransfers.set(transferId, { cancelled: false });
    
    const sendProgress = (transferred, speed) => {
      if (!activeTransfers.get(transferId)?.cancelled) {
        sender.send("nebula:transfer:progress", { transferId, transferred, speed, totalBytes });
      }
    };
    
    const sendComplete = () => {
      activeTransfers.delete(transferId);
      sender.send("nebula:transfer:complete", { transferId });
    };
    
    const sendError = (error) => {
      activeTransfers.delete(transferId);
      sender.send("nebula:transfer:error", { transferId, error: error.message || String(error) });
    };
    
    try {
      let readStream;
      let writeStream;
      let fileSize = totalBytes || 0;
      
      // Create read stream based on source type
      if (sourceType === 'local') {
        if (!fileSize) {
          const stat = await fs.promises.stat(sourcePath);
          fileSize = stat.size;
        }
        readStream = fs.createReadStream(sourcePath);
      } else if (sourceType === 'sftp') {
        const client = sftpClients.get(sourceSftpId);
        if (!client) throw new Error("Source SFTP session not found");
        if (!fileSize) {
          const stat = await client.stat(sourcePath);
          fileSize = stat.size;
        }
        // ssh2-sftp-client's get with stream
        readStream = client.sftp.createReadStream(sourcePath);
      } else {
        throw new Error("Invalid source type");
      }
      
      // Create write stream based on target type
      if (targetType === 'local') {
        // Ensure directory exists
        const dir = path.dirname(targetPath);
        await fs.promises.mkdir(dir, { recursive: true });
        writeStream = fs.createWriteStream(targetPath);
      } else if (targetType === 'sftp') {
        const client = sftpClients.get(targetSftpId);
        if (!client) throw new Error("Target SFTP session not found");
        // Ensure directory exists
        const dir = path.dirname(targetPath).replace(/\\/g, '/');
        try { await client.mkdir(dir, true); } catch {}
        writeStream = client.sftp.createWriteStream(targetPath);
      } else {
        throw new Error("Invalid target type");
      }
      
      // Store streams for potential cancellation
      const transfer = activeTransfers.get(transferId);
      if (transfer) {
        transfer.readStream = readStream;
        transfer.writeStream = writeStream;
      }
      
      // Track progress
      let transferred = 0;
      let lastTime = Date.now();
      let lastTransferred = 0;
      let speed = 0;
      
      readStream.on('data', (chunk) => {
        // Check if cancelled
        if (activeTransfers.get(transferId)?.cancelled) {
          readStream.destroy();
          writeStream.destroy();
          return;
        }
        
        transferred += chunk.length;
        
        // Calculate speed every 200ms
        const now = Date.now();
        const elapsed = now - lastTime;
        if (elapsed >= 200) {
          speed = Math.round((transferred - lastTransferred) / (elapsed / 1000));
          lastTime = now;
          lastTransferred = transferred;
          sendProgress(transferred, speed);
        }
      });
      
      readStream.on('error', (err) => {
        writeStream.destroy();
        sendError(err);
      });
      
      writeStream.on('error', (err) => {
        readStream.destroy();
        sendError(err);
      });
      
      writeStream.on('finish', () => {
        if (!activeTransfers.get(transferId)?.cancelled) {
          // Send final progress with 100%
          sendProgress(fileSize, speed);
          sendComplete();
        }
      });
      
      // Pipe read to write
      readStream.pipe(writeStream);
      
      return { transferId, totalBytes: fileSize };
    } catch (err) {
      sendError(err);
      return { transferId, error: err.message };
    }
  };
  
  const cancelTransfer = async (_event, payload) => {
    const { transferId } = payload;
    const transfer = activeTransfers.get(transferId);
    if (transfer) {
      transfer.cancelled = true;
      if (transfer.readStream) {
        try { transfer.readStream.destroy(); } catch {}
      }
      if (transfer.writeStream) {
        try { transfer.writeStream.destroy(); } catch {}
      }
      activeTransfers.delete(transferId);
    }
    return { success: true };
  };
  
  electronModule.ipcMain.handle("nebula:transfer:start", startTransfer);
  electronModule.ipcMain.handle("nebula:transfer:cancel", cancelTransfer);
};

// Store reference to main window for theme updates
let mainWindow = null;

// Theme colors configuration
const THEME_COLORS = {
  dark: {
    background: "#0b1220",
    titleBarColor: "#0b1220",
    symbolColor: "#ffffff",
  },
  light: {
    background: "#ffffff",
    titleBarColor: "#f8fafc",
    symbolColor: "#1e293b",
  },
};

// Read initial theme from a simple approach - default to light
let currentTheme = "light";

async function createWindow() {
  const themeConfig = THEME_COLORS[currentTheme];
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: themeConfig.background,
    icon: appIcon,
    // macOS: use hiddenInset for native traffic lights
    // Windows/Linux: use frameless window with custom controls
    frame: isMac,
    titleBarStyle: isMac ? "hiddenInset" : undefined,
    trafficLightPosition: isMac ? { x: 12, y: 12 } : undefined,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow = win;

  // Window control handlers (for custom title bar on Windows/Linux)
  electronModule.ipcMain.handle("nebula:window:minimize", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.minimize();
    }
  });

  electronModule.ipcMain.handle("nebula:window:maximize", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMaximized()) {
        mainWindow.unmaximize();
        return false;
      } else {
        mainWindow.maximize();
        return true;
      }
    }
    return false;
  });

  electronModule.ipcMain.handle("nebula:window:close", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.close();
    }
  });

  electronModule.ipcMain.handle("nebula:window:isMaximized", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      return mainWindow.isMaximized();
    }
    return false;
  });

  // Handle theme change requests from renderer
  electronModule.ipcMain.handle("nebula:setTheme", (_event, theme) => {
    currentTheme = theme;
    nativeTheme.themeSource = theme;
    const themeConfig = THEME_COLORS[theme] || THEME_COLORS.light;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setBackgroundColor(themeConfig.background);
    }
    return true;
  });

  if (isDev) {
    try {
      await win.loadURL(devServerUrl);
      win.webContents.openDevTools({ mode: "detach" });
      registerSSHBridge(win);
      return;
    } catch (e) {
      console.warn("Dev server not reachable, falling back to bundled dist.", e);
    }
  }

  const indexPath = path.join(__dirname, "../dist/index.html");
  await win.loadFile(indexPath);
  registerSSHBridge(win);
}

app.whenReady().then(() => {
  if (isMac && appIcon && app.dock?.setIcon) {
    try {
      app.dock.setIcon(appIcon);
    } catch (err) {
      console.warn("Failed to set dock icon", err);
    }
  }

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
