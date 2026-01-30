/**
 * Netcatty Electron Main Process
 * 
 * This is the main entry point for the Electron application.
 * All major functionality has been extracted into separate bridge modules:
 * 
 * - sshBridge.cjs: SSH connections and session management
 * - sftpBridge.cjs: SFTP file operations
 * - localFsBridge.cjs: Local filesystem operations
 * - transferBridge.cjs: File transfers with progress
 * - portForwardingBridge.cjs: SSH port forwarding tunnels
 * - terminalBridge.cjs: Local shell, telnet, and mosh sessions
 * - windowManager.cjs: Electron window management
 */

// Handle environment setup
if (process.env.ELECTRON_RUN_AS_NODE) {
  delete process.env.ELECTRON_RUN_AS_NODE;
}

// Handle uncaught exceptions for EPIPE errors
process.on('uncaughtException', (err) => {
  if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') {
    console.warn('Ignored stream error:', err.code);
    return;
  }
  console.error('Uncaught exception:', err);
  throw err;
});

// Load Electron
let electronModule;
try {
  electronModule = require("node:electron");
} catch {
  electronModule = require("electron");
}

const { app, BrowserWindow, Menu, protocol, shell } = electronModule || {};
if (!app || !BrowserWindow) {
  throw new Error("Failed to load Electron runtime. Ensure the app is launched with the Electron binary.");
}

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

try {
  protocol?.registerSchemesAsPrivileged?.([
    {
      scheme: "app",
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
} catch (err) {
  console.warn("[Main] Failed to register app:// scheme privileges:", err);
}

// Apply ssh2 protocol patch needed for OpenSSH sk-* signature layouts.

// Import bridge modules
const sshBridge = require("./bridges/sshBridge.cjs");
const sftpBridge = require("./bridges/sftpBridge.cjs");
const localFsBridge = require("./bridges/localFsBridge.cjs");
const transferBridge = require("./bridges/transferBridge.cjs");
const portForwardingBridge = require("./bridges/portForwardingBridge.cjs");
const terminalBridge = require("./bridges/terminalBridge.cjs");
const oauthBridge = require("./bridges/oauthBridge.cjs");
const githubAuthBridge = require("./bridges/githubAuthBridge.cjs");
const googleAuthBridge = require("./bridges/googleAuthBridge.cjs");
const onedriveAuthBridge = require("./bridges/onedriveAuthBridge.cjs");
const cloudSyncBridge = require("./bridges/cloudSyncBridge.cjs");
const fileWatcherBridge = require("./bridges/fileWatcherBridge.cjs");
const tempDirBridge = require("./bridges/tempDirBridge.cjs");
const sessionLogsBridge = require("./bridges/sessionLogsBridge.cjs");
const compressUploadBridge = require("./bridges/compressUploadBridge.cjs");
const windowManager = require("./bridges/windowManager.cjs");

// GPU settings
// NOTE: Do not disable Chromium sandbox by default.
// If you need to debug with sandbox disabled, set NETCATTY_NO_SANDBOX=1.
if (process.env.NETCATTY_NO_SANDBOX === "1") {
  app.commandLine.appendSwitch("no-sandbox");
}
// Force hardware acceleration even on blocklisted GPUs (macs sometimes fall back to software)
app.commandLine.appendSwitch("ignore-gpu-blocklist");
app.commandLine.appendSwitch("ignore-gpu-blacklist"); // Some Chromium builds use this alias; keep both for safety
app.commandLine.appendSwitch("enable-gpu-rasterization");
app.commandLine.appendSwitch("enable-zero-copy");

// Silence noisy DevTools Autofill CDP errors (Electron's backend doesn't expose this domain)
app.on("web-contents-created", (_event, contents) => {
  if (contents.getType() !== "devtools") return;
  // Drop console output from Autofill requests in DevTools frontend
  contents.on("did-finish-load", () => {
    contents
      .executeJavaScript(`
        (() => {
          const block = (methodName) => {
            const original = console[methodName];
            if (!original) return;
            console[methodName] = (...args) => {
              if (args.some(arg => typeof arg === "string" && arg.includes("Autofill."))) return;
              original(...args);
            };
          };
          block("error");
          block("warn");
        })();
      `)
      .catch(() => {});
  });
  contents.on("console-message", (event, _level, message, _line, sourceId) => {
    if (sourceId?.startsWith("devtools://") && message.includes("Autofill.")) {
      event.preventDefault();
    }
  });
});

// Application configuration
const devServerUrl = process.env.VITE_DEV_SERVER_URL;
// Never treat a packaged app as "dev" even if the user has VITE_DEV_SERVER_URL set globally.
const isDev = !app.isPackaged && !!devServerUrl;
const effectiveDevServerUrl = isDev ? devServerUrl : undefined;
const preload = path.join(__dirname, "preload.cjs");
const isMac = process.platform === "darwin";
const appIcon = path.join(__dirname, "../public/icon.png");
const electronDir = __dirname;

const APP_PROTOCOL_HEADERS = {
  // Required for crossOriginIsolated / SharedArrayBuffer.
  // Mirrors the dev-server headers in `vite.config.ts`.
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
};

const DIST_MIME_TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".eot": "application/vnd.ms-fontobject",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".wasm": "application/wasm",
};

function resolveContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return DIST_MIME_TYPES[ext] || "application/octet-stream";
}

function isPathInside(parentPath, childPath) {
  const parent = path.resolve(parentPath);
  const child = path.resolve(childPath);
  if (child === parent) return true;
  return child.startsWith(`${parent}${path.sep}`);
}

function resolveDistPath() {
  return path.join(electronDir, "../dist");
}

function registerAppProtocol() {
  if (!protocol?.handle) return;

  try {
    protocol.handle("app", async (request) => {
      const notFound = () =>
        new Response("Not Found", {
          status: 404,
          headers: { ...APP_PROTOCOL_HEADERS, "Content-Type": "text/plain" },
        });

      try {
        const url = new URL(request.url);
        let pathname = url.pathname || "/";
        try {
          pathname = decodeURIComponent(pathname);
        } catch {
          // keep undecoded
        }

        if (!pathname || pathname === "/") pathname = "/index.html";

        const distPath = path.resolve(resolveDistPath());
        const relative = pathname.replace(/^\/+/, "");
        let fullPath = path.resolve(distPath, relative);

        if (!isPathInside(distPath, fullPath)) {
          return new Response("Forbidden", {
            status: 403,
            headers: { ...APP_PROTOCOL_HEADERS, "Content-Type": "text/plain" },
          });
        }

        // SPA fallback: for extension-less paths, serve index.html.
        if (!path.extname(fullPath)) {
          fullPath = path.resolve(distPath, "index.html");
        }

        const file = await fs.promises.readFile(fullPath);
        return new Response(file, {
          status: 200,
          headers: {
            ...APP_PROTOCOL_HEADERS,
            "Content-Type": resolveContentType(fullPath),
          },
        });
      } catch (err) {
        return notFound();
      }
    });
  } catch (err) {
    console.error("[Main] Failed to register app:// protocol handler:", err);
  }
}

function focusMainWindow() {
  try {
    const wins = BrowserWindow.getAllWindows();
    const win = wins && wins.length ? wins[0] : null;
    if (!win) return false;

    try {
      if (win.isMinimized && win.isMinimized()) win.restore();
    } catch {}
    try {
      win.show();
    } catch {}
    try {
      win.focus();
    } catch {}
    try {
      app.focus({ steal: true });
    } catch {}

    return true;
  } catch {
    return false;
  }
}

// Shared state
const sessions = new Map();
const sftpClients = new Map();
const keyRoot = path.join(os.homedir(), ".netcatty", "keys");
let cloudSyncSessionPassword = null;
const CLOUD_SYNC_PASSWORD_FILE = "netcatty_cloud_sync_master_password_v1";

// Key management helpers
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

// Track if bridges are registered
let bridgesRegistered = false;

/**
 * Register all IPC bridges with Electron
 */
const registerBridges = (win) => {
  if (bridgesRegistered) return;
  bridgesRegistered = true;

  const { ipcMain } = electronModule;
  const { safeStorage } = electronModule;

  const getCloudSyncPasswordPath = () => {
    try {
      return path.join(app.getPath("userData"), CLOUD_SYNC_PASSWORD_FILE);
    } catch {
      return null;
    }
  };

  const readPersistedCloudSyncPassword = () => {
    try {
      if (!safeStorage?.isEncryptionAvailable?.()) return null;
      const filePath = getCloudSyncPasswordPath();
      if (!filePath || !fs.existsSync(filePath)) return null;
      const base64 = fs.readFileSync(filePath, "utf8");
      if (!base64) return null;
      const buf = Buffer.from(base64, "base64");
      const decrypted = safeStorage.decryptString(buf);
      return typeof decrypted === "string" && decrypted.length ? decrypted : null;
    } catch (err) {
      console.warn("[CloudSync] Failed to read persisted password:", err?.message || err);
      return null;
    }
  };

  const persistCloudSyncPassword = (password) => {
    try {
      if (!safeStorage?.isEncryptionAvailable?.()) return false;
      const filePath = getCloudSyncPasswordPath();
      if (!filePath) return false;
      const encrypted = safeStorage.encryptString(password);
      fs.writeFileSync(filePath, encrypted.toString("base64"), { mode: 0o600 });
      return true;
    } catch (err) {
      console.warn("[CloudSync] Failed to persist password:", err?.message || err);
      return false;
    }
  };

  const clearPersistedCloudSyncPassword = () => {
    try {
      const filePath = getCloudSyncPasswordPath();
      if (filePath && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (err) {
      console.warn("[CloudSync] Failed to clear persisted password:", err?.message || err);
    }
  };

  // Initialize bridges with shared dependencies
  const deps = {
    sessions,
    sftpClients,
    electronModule,
  };

  sshBridge.init(deps);
  sftpBridge.init(deps);
  transferBridge.init(deps);
  terminalBridge.init(deps);
  fileWatcherBridge.init(deps);
  
  // Initialize compress upload bridge with transferBridge dependency
  compressUploadBridge.init({
    ...deps,
    transferBridge,
  });

  // Initialize temp directory (synchronously)
  tempDirBridge.ensureTempDir();

  // Register all IPC handlers
  sshBridge.registerHandlers(ipcMain);
  sftpBridge.registerHandlers(ipcMain);
  localFsBridge.registerHandlers(ipcMain);
  transferBridge.registerHandlers(ipcMain);
  portForwardingBridge.registerHandlers(ipcMain);
  terminalBridge.registerHandlers(ipcMain);
  oauthBridge.setupOAuthBridge(ipcMain);
  githubAuthBridge.registerHandlers(ipcMain);
  googleAuthBridge.registerHandlers(ipcMain, electronModule);
  onedriveAuthBridge.registerHandlers(ipcMain, electronModule);
  cloudSyncBridge.registerHandlers(ipcMain);
  fileWatcherBridge.registerHandlers(ipcMain);
  tempDirBridge.registerHandlers(ipcMain, shell);
  sessionLogsBridge.registerHandlers(ipcMain);
  compressUploadBridge.registerHandlers(ipcMain);

  // Settings window handler
  ipcMain.handle("netcatty:settings:open", async () => {
    try {
      await windowManager.openSettingsWindow(electronModule, {
        preload,
        devServerUrl: effectiveDevServerUrl,
        isDev,
        appIcon,
        isMac,
        electronDir,
      });
      return true;
    } catch (err) {
      console.error("[Main] Failed to open settings window:", err);
      return false;
    }
  });

  // Cloud sync master password (stored in-memory + persisted via safeStorage)
  ipcMain.handle("netcatty:cloudSync:session:setPassword", async (_event, password) => {
    cloudSyncSessionPassword = typeof password === "string" && password.length ? password : null;
    if (cloudSyncSessionPassword) {
      persistCloudSyncPassword(cloudSyncSessionPassword);
    } else {
      clearPersistedCloudSyncPassword();
    }
    return true;
  });

  ipcMain.handle("netcatty:cloudSync:session:getPassword", async () => {
    if (cloudSyncSessionPassword) return cloudSyncSessionPassword;
    const persisted = readPersistedCloudSyncPassword();
    cloudSyncSessionPassword = persisted;
    return persisted;
  });

  ipcMain.handle("netcatty:cloudSync:session:clearPassword", async () => {
    cloudSyncSessionPassword = null;
    clearPersistedCloudSyncPassword();
    return true;
  });

  // Open external URL in default browser
  ipcMain.handle("netcatty:openExternal", async (_event, url) => {
    const { shell } = electronModule;
    if (url && typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'))) {
      await shell.openExternal(url);
    }
  });

  // App information for About/Application screens
  ipcMain.handle("netcatty:app:getInfo", async () => {
    return {
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform,
    };
  });

  // Select an application from system file picker
  ipcMain.handle("netcatty:selectApplication", async () => {
    const { dialog } = electronModule;
    
    let filters = [];
    let defaultPath;
    
    if (process.platform === "darwin") {
      filters = [{ name: "Applications", extensions: ["app"] }];
      defaultPath = "/Applications";
    } else if (process.platform === "win32") {
      filters = [{ name: "Executables", extensions: ["exe", "com", "bat", "cmd"] }];
      defaultPath = "C:\\Program Files";
    } else {
      // Linux - no specific filter, user can pick any executable
      filters = [{ name: "All Files", extensions: ["*"] }];
      defaultPath = "/usr/bin";
    }
    
    const result = await dialog.showOpenDialog({
      title: "Select Application",
      defaultPath,
      filters,
      properties: ["openFile"],
    });
    
    if (result.canceled || !result.filePaths.length) {
      return null;
    }
    
    const appPath = result.filePaths[0];
    const appName = path.basename(appPath).replace(/\.[^.]+$/, "");
    
    return { path: appPath, name: appName };
  });

  // Open a file with a specific application
  ipcMain.handle("netcatty:openWithApplication", async (_event, { filePath, appPath }) => {
    const { spawn: cpSpawn } = require("node:child_process");
    
    console.log(`[Main] Opening file with application:`);
    console.log(`[Main]   File: ${filePath}`);
    console.log(`[Main]   App: ${appPath}`);
    console.log(`[Main]   Platform: ${process.platform}`);
    
    try {
      let child;
      if (process.platform === "darwin") {
        // On macOS, use 'open' command with -a flag for specific app
        const args = ["-a", appPath, filePath];
        console.log(`[Main]   Command: open ${args.join(' ')}`);
        child = cpSpawn("open", args, { detached: true, stdio: "pipe" });
      } else if (process.platform === "win32") {
        // On Windows, use cmd /c start to properly handle paths with spaces
        // The empty string "" as window title is required when the first arg has quotes
        const args = ["/c", "start", "\"\"", `"${appPath}"`, `"${filePath}"`];
        console.log(`[Main]   Command: cmd ${args.join(' ')}`);
        child = cpSpawn("cmd", args, { detached: true, stdio: "pipe", windowsVerbatimArguments: true });
      } else {
        // On Linux, spawn the app with the file
        console.log(`[Main]   Command: ${appPath} ${filePath}`);
        child = cpSpawn(appPath, [filePath], { detached: true, stdio: "pipe" });
      }
      
      // Log any errors from the child process
      child.on("error", (err) => {
        console.error(`[Main] Failed to start application:`, err.message);
      });
      
      child.stderr?.on("data", (data) => {
        // On Windows, stderr may be encoded in GBK/CP936, try to decode
        if (process.platform === "win32") {
          try {
            // Try decoding as GBK (code page 936) for Chinese Windows
            const { TextDecoder } = require("node:util");
            const decoder = new TextDecoder("gbk");
            const decoded = decoder.decode(data);
            console.log(`[Main] Application stderr: ${decoded}`);
          } catch {
            // Fallback to hex dump if decoding fails
            console.log(`[Main] Application stderr (hex): ${data.toString("hex")}`);
          }
        } else {
          console.error(`[Main] Application stderr:`, data.toString());
        }
      });
      
      child.on("exit", (code, signal) => {
        // On Windows, many apps (like Notepad++) pass the file to an existing instance
        // and immediately exit with code 1, this is normal behavior
        if (code !== 0 && code !== null) {
          if (process.platform === "win32") {
            console.log(`[Main] Application exited with code: ${code}, signal: ${signal} (this may be normal for single-instance apps)`);
          } else {
            console.warn(`[Main] Application exited with code: ${code}, signal: ${signal}`);
          }
        } else {
          console.log(`[Main] Application started successfully`);
        }
      });
      
      child.unref();
      return true;
    } catch (err) {
      console.error(`[Main] Error opening file with application:`, err);
      throw err;
    }
  });

  // Show save file dialog and return selected path
  ipcMain.handle("netcatty:showSaveDialog", async (_event, { defaultPath, filters }) => {
    const { dialog } = electronModule;

    const result = await dialog.showSaveDialog({
      defaultPath,
      filters: filters || [{ name: "All Files", extensions: ["*"] }],
    });

    if (result.canceled || !result.filePath) {
      return null;
    }

    return result.filePath;
  });

  // Download SFTP file to temp and return local path
  ipcMain.handle("netcatty:sftp:downloadToTemp", async (_event, { sftpId, remotePath, fileName, encoding }) => {
    console.log(`[Main] Downloading SFTP file to temp:`);
    console.log(`[Main]   SFTP ID: ${sftpId}`);
    console.log(`[Main]   Remote path: ${remotePath}`);
    console.log(`[Main]   File name: ${fileName}`);
    
    const client = require("./bridges/sftpBridge.cjs");
    // Use tempDirBridge for dedicated Netcatty temp directory
    const localPath = await tempDirBridge.getTempFilePath(fileName);
    
    console.log(`[Main]   Local temp path: ${localPath}`);
    
    // Get the sftp client and download file
    const sftpClients = client.getSftpClients ? client.getSftpClients() : null;
    if (!sftpClients) {
      console.log(`[Main]   Using fallback readSftp method`);
      // Fallback: use readSftp and write to temp file
      const content = await client.readSftp(null, { sftpId, path: remotePath, encoding });
      if (typeof content === "string") {
        await fs.promises.writeFile(localPath, content, "utf-8");
      } else {
        await fs.promises.writeFile(localPath, content);
      }
      console.log(`[Main]   File downloaded successfully (fallback)`);
      return localPath;
    }
    
    const sftpClient = sftpClients.get(sftpId);
    if (!sftpClient) {
      console.error(`[Main]   SFTP session not found: ${sftpId}`);
      throw new Error("SFTP session not found");
    }
    
    const encodedPath = client.encodePathForSession
      ? client.encodePathForSession(sftpId, remotePath, encoding)
      : remotePath;
    await sftpClient.fastGet(encodedPath, localPath);
    console.log(`[Main]   File downloaded successfully`);
    return localPath;
  });

  // Delete a temp file (for cleanup when editors close)
  ipcMain.handle("netcatty:deleteTempFile", async (_event, { filePath }) => {
    try {
      // Only allow deleting files in Netcatty temp directory for security
      const netcattyTempDir = tempDirBridge.getTempDir();
      const resolvedPath = path.resolve(filePath);
      if (!resolvedPath.startsWith(netcattyTempDir)) {
        console.warn(`[Main] Refused to delete file outside Netcatty temp dir: ${filePath}`);
        return { success: false };
      }
      
      await fs.promises.unlink(resolvedPath);
      console.log(`[Main] Temp file deleted: ${filePath}`);
      return { success: true };
    } catch (err) {
      // Silently handle failures (file may be in use or already deleted)
      console.log(`[Main] Could not delete temp file: ${filePath} (${err.message})`);
      return { success: false };
    }
  });

  console.log('[Main] All bridges registered successfully');
};

/**
 * Create the main application window
 */
async function createWindow() {
  const win = await windowManager.createWindow(electronModule, {
    preload,
    devServerUrl: effectiveDevServerUrl,
    isDev,
    appIcon,
    isMac,
    electronDir,
    onRegisterBridge: registerBridges,
  });
  
  return win;
}

function showStartupError(err) {
  const title = "Netcatty";
  const code = err && typeof err === "object" ? err.code : null;
  const message =
    code === "ENOENT"
      ? "Renderer files are missing. Please reinstall or rebuild Netcatty."
      : "Failed to load the UI. Please relaunch Netcatty.";

  try {
    electronModule.dialog?.showErrorBox?.(title, message);
  } catch {
    // ignore
  }
}

// Application lifecycle
app.whenReady().then(() => {
  registerAppProtocol();

  // Set dock icon on macOS
  if (isMac && appIcon && app.dock?.setIcon) {
    try {
      app.dock.setIcon(appIcon);
    } catch (err) {
      console.warn("Failed to set dock icon", err);
    }
  }

  // Build and set application menu
  const menu = windowManager.buildAppMenu(Menu, app, isMac);
  Menu.setApplicationMenu(menu);

  app.on("browser-window-created", (_event, win) => {
    try {
      const mainWin = windowManager.getMainWindow();
      const settingsWin = windowManager.getSettingsWindow();
      const isPrimary = win === mainWin || win === settingsWin;
      if (!isPrimary) {
        win.setMenuBarVisibility(false);
        win.autoHideMenuBar = true;
        win.setMenu(null);
        if (appIcon && win.setIcon) win.setIcon(appIcon);
      }
    } catch {
      // ignore
    }
  });

  // Create the main window
  void createWindow().catch((err) => {
    console.error("[Main] Failed to create main window:", err);
    showStartupError(err);
    try {
      app.quit();
    } catch {}
  });

  // Re-create window on macOS dock click
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow().catch((err) => {
        console.error("[Main] Failed to create window on activate:", err);
        showStartupError(err);
      });
    }
  });
});

// Ensure single-instance behavior focuses existing window
try {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  } else {
    app.on("second-instance", () => {
      focusMainWindow();
    });
  }
} catch {}

// Cleanup on all windows closed
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// Cleanup all PTY sessions and port forwarding tunnels before quitting
app.on("will-quit", () => {
  try {
    terminalBridge.cleanupAllSessions();
  } catch (err) {
    console.warn("Error during terminal cleanup:", err);
  }
  try {
    portForwardingBridge.stopAllPortForwards();
  } catch (err) {
    console.warn("Error during port forwarding cleanup:", err);
  }
});

// Export for testing
module.exports = {
  sessions,
  sftpClients,
  ensureKeyDir,
  writeKeyToDisk,
};
