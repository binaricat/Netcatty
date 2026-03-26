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

// Load crash log bridge early so process-level error handlers can use it
const crashLogBridge = require("./bridges/crashLogBridge.cjs");

// SSH / network errors that must never crash the process.
// ssh2 can emit multiple 'error' events per connection (e.g. ECONNRESET followed
// by "Connection lost before handshake"). If a listener is consumed after the first
// event, the second becomes an uncaught exception. These are non-fatal for the app.
function isNonFatalNetworkError(err) {
  if (!err) return false;
  // Any error with an ssh2 `level` property is a connection/auth-level error,
  // never a reason to kill the entire multi-session app.
  if (err.level) return true;
  const code = err.code;
  // Common TCP/DNS/routing errors that can surface from Node.js sockets
  // without an ssh2 `level` (e.g. proxy sockets, raw net.connect calls).
  switch (code) {
    case 'ECONNRESET':
    case 'ECONNREFUSED':
    case 'ECONNABORTED':
    case 'ETIMEDOUT':
    case 'ENOTFOUND':
    case 'EHOSTUNREACH':
    case 'EHOSTDOWN':
    case 'ENETUNREACH':
    case 'ENETDOWN':
    case 'EADDRNOTAVAIL':
    case 'EPROTO':
    case 'EPERM':
      return true;
    default:
      return false;
  }
}

// Handle uncaught exceptions — log all, only re-throw truly fatal ones
process.on('uncaughtException', (err) => {
  // Skip benign stream teardown errors — don't pollute crash logs with false positives
  if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') {
    console.warn('Ignored stream error:', err.code);
    return;
  }
  // Non-fatal SSH/network errors: log but do NOT crash the process
  if (isNonFatalNetworkError(err)) {
    if (!err.__fromUnhandledRejection) {
      try { crashLogBridge.captureError('uncaughtException', err); } catch {}
    }
    console.warn('Non-fatal uncaught exception (suppressed):', err.message);
    return;
  }
  // Skip logging if already captured by unhandledRejection handler
  if (!err.__fromUnhandledRejection) {
    try { crashLogBridge.captureError('uncaughtException', err); } catch {}
  }
  console.error('Uncaught exception:', err);
  throw err;
});

process.on('unhandledRejection', (reason) => {
  // Skip benign stream teardown errors
  const code = reason?.code;
  if (code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED') return;
  // Non-fatal SSH/network errors: log but do NOT re-throw
  if (isNonFatalNetworkError(reason)) {
    try { crashLogBridge.captureError('unhandledRejection', reason); } catch {}
    console.warn('Non-fatal unhandled rejection (suppressed):', reason?.message || reason);
    return;
  }
  try { crashLogBridge.captureError('unhandledRejection', reason); } catch {}
  console.error('Unhandled rejection:', reason);
  // Re-throw to preserve fatal semantics. Mark so uncaughtException handler
  // can skip duplicate logging.
  const err = reason instanceof Error ? reason : new Error(String(reason));
  err.__fromUnhandledRejection = true;
  throw err;
});

// Load Electron
let electronModule;
try {
  electronModule = require("node:electron");
} catch {
  electronModule = require("electron");
}

const { app, BrowserWindow, Menu, protocol, shell, clipboard } = electronModule || {};
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

function createLazyModule(modulePath) {
  let cachedModule = null;
  return () => {
    if (!cachedModule) {
      cachedModule = require(modulePath);
    }
    return cachedModule;
  };
}

// Import bridge modules
const sshBridge = require("./bridges/sshBridge.cjs");
const sftpBridge = require("./bridges/sftpBridge.cjs");
const localFsBridge = require("./bridges/localFsBridge.cjs");
const transferBridge = require("./bridges/transferBridge.cjs");
const portForwardingBridge = require("./bridges/portForwardingBridge.cjs");
const terminalBridge = require("./bridges/terminalBridge.cjs");
const sessionLogStreamManager = require("./bridges/sessionLogStreamManager.cjs");
// crashLogBridge is required at the top of the file (before error handlers)
const getOauthBridge = createLazyModule("./bridges/oauthBridge.cjs");
const getGithubAuthBridge = createLazyModule("./bridges/githubAuthBridge.cjs");
const getGoogleAuthBridge = createLazyModule("./bridges/googleAuthBridge.cjs");
const getOnedriveAuthBridge = createLazyModule("./bridges/onedriveAuthBridge.cjs");
const getCloudSyncBridge = createLazyModule("./bridges/cloudSyncBridge.cjs");
const getFileWatcherBridge = createLazyModule("./bridges/fileWatcherBridge.cjs");
const getTempDirBridge = createLazyModule("./bridges/tempDirBridge.cjs");
const getSessionLogsBridge = createLazyModule("./bridges/sessionLogsBridge.cjs");
const getCompressUploadBridge = createLazyModule("./bridges/compressUploadBridge.cjs");
const getGlobalShortcutBridge = createLazyModule("./bridges/globalShortcutBridge.cjs");
const getCredentialBridge = createLazyModule("./bridges/credentialBridge.cjs");
const getAutoUpdateBridge = createLazyModule("./bridges/autoUpdateBridge.cjs");
const getAiBridge = createLazyModule("./bridges/aiBridge.cjs");
const getWindowManager = createLazyModule("./bridges/windowManager.cjs");

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

    // Check if the webContents has crashed or been destroyed
    try {
      if (win.webContents?.isCrashed?.()) {
        console.warn('[Main] Main window webContents has crashed, destroying window');
        win.destroy();
        return false;
      }
    } catch {}

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
const ensureKeyDir = async () => {
  try {
    await fs.promises.mkdir(keyRoot, { recursive: true, mode: 0o700 });
  } catch (err) {
    console.warn("Unable to ensure key cache dir", err);
  }
};

const writeKeyToDisk = async (keyId, privateKey) => {
  if (!privateKey) return null;
  await ensureKeyDir();
  const safeId = String(keyId || "temp").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
  const filename = `${safeId}.pem`;
  const target = path.join(keyRoot, filename);
  const normalized = privateKey.endsWith("\n") ? privateKey : `${privateKey}\n`;
  try {
    await fs.promises.writeFile(target, normalized, { mode: 0o600 });
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
  const oauthBridge = getOauthBridge();
  const githubAuthBridge = getGithubAuthBridge();
  const googleAuthBridge = getGoogleAuthBridge();
  const onedriveAuthBridge = getOnedriveAuthBridge();
  const cloudSyncBridge = getCloudSyncBridge();
  const fileWatcherBridge = getFileWatcherBridge();
  const tempDirBridge = getTempDirBridge();
  const sessionLogsBridge = getSessionLogsBridge();
  const compressUploadBridge = getCompressUploadBridge();
  const globalShortcutBridge = getGlobalShortcutBridge();
  const credentialBridge = getCredentialBridge();
  const autoUpdateBridge = getAutoUpdateBridge();
  const aiBridge = getAiBridge();

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
  globalShortcutBridge.init(deps);
  aiBridge.init(deps);
  crashLogBridge.init(deps);

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
  globalShortcutBridge.registerHandlers(ipcMain);
  credentialBridge.registerHandlers(ipcMain, electronModule);
  autoUpdateBridge.init(deps);
  autoUpdateBridge.registerHandlers(ipcMain);
  aiBridge.registerHandlers(ipcMain);
  crashLogBridge.registerHandlers(ipcMain);

  // Fig autocomplete spec loader — uses dynamic import() since @withfig/autocomplete is ESM
  ipcMain.handle("netcatty:figspec:list", async () => {
    try {
      const mod = await import("@withfig/autocomplete");
      return mod.default || [];
    } catch (err) {
      console.warn("[Main] Failed to load fig spec list:", err?.message || err);
      return [];
    }
  });
  ipcMain.handle("netcatty:figspec:load", async (_event, commandName) => {
    try {
      // Sanitize: reject absolute paths, path traversal, and non-spec characters
      if (!commandName || commandName.startsWith("/") || commandName.startsWith("\\") ||
          commandName.includes("..") || !/^[@a-zA-Z0-9._/+-]+$/.test(commandName)) return null;
      // Can't use `import("@withfig/autocomplete/build/...")` because the package's
      // "exports" field restricts allowed import paths. Use file URL to bypass.
      const specFile = path.join(electronDir, "..", "node_modules", "@withfig", "autocomplete", "build", `${commandName}.js`);
      const { pathToFileURL } = require("url");
      const mod = await import(pathToFileURL(specFile).href);
      const spec = mod.default?.default ?? mod.default ?? null;
      // IPC requires serializable data — JSON round-trip strips functions/symbols
      return spec ? JSON.parse(JSON.stringify(spec)) : null;
    } catch (err) {
      console.warn("[Main] Failed to load fig spec:", commandName, err?.message);
      return null;
    }
  });

  // Settings window handler
  ipcMain.handle("netcatty:settings:open", async () => {
    try {
      await getWindowManager().openSettingsWindow(electronModule, {
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

  // Clipboard helpers for renderer fallback paths (e.g. Monaco paste in Electron)
  ipcMain.handle("netcatty:clipboard:readText", async () => {
    try {
      return clipboard?.readText?.() || "";
    } catch {
      return "";
    }
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

  // Select a file and return the selected path
  ipcMain.handle("netcatty:selectFile", async (_event, { title, defaultPath, filters }) => {
    const { dialog } = electronModule;

    const result = await dialog.showOpenDialog({
      title: title || "Select File",
      defaultPath: defaultPath || os.homedir(),
      filters: filters || [{ name: "All Files", extensions: ["*"] }],
      properties: ["openFile", "showHiddenFiles"],
    });

    if (result.canceled || !result.filePaths.length) {
      return null;
    }

    return result.filePaths[0];
  });

  // Select a directory and return the selected path
  ipcMain.handle("netcatty:selectDirectory", async (_event, { title, defaultPath }) => {
    const { dialog } = electronModule;

    const result = await dialog.showOpenDialog({
      title: title || "Select Directory",
      defaultPath,
      properties: ["openDirectory", "createDirectory"],
    });

    if (result.canceled || !result.filePaths.length) {
      return null;
    }

    return result.filePaths[0];
  });

  // Download SFTP file to temp and return local path
  ipcMain.handle("netcatty:sftp:downloadToTemp", async (_event, { sftpId, remotePath, fileName, encoding }) => {
    console.log(`[Main] Downloading SFTP file to temp:`);
    console.log(`[Main]   SFTP ID: ${sftpId}`);
    console.log(`[Main]   Remote path: ${remotePath}`);
    console.log(`[Main]   File name: ${fileName}`);
    
    const client = require("./bridges/sftpBridge.cjs");
    // Use tempDirBridge for dedicated Netcatty temp directory
    const localPath = await getTempDirBridge().getTempFilePath(fileName);
    
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

  // Download SFTP file to temp with progress reporting via transfer events.
  // Progress/complete/cancelled events are delivered via the netcatty:transfer:*
  // channels (handled by transferBridge.startTransfer), so the IPC return value
  // only carries the resolved temp path. Cancellation is NOT an error here —
  // the UI already transitions the task to "cancelled" via the dedicated event.
  ipcMain.handle("netcatty:sftp:downloadToTempWithProgress", async (event, { sftpId, remotePath, fileName, encoding, transferId }) => {
    const localPath = await getTempDirBridge().getTempFilePath(fileName);
    const cleanupPartialDownload = async () => {
      try {
        await fs.promises.rm(localPath, { force: true });
      } catch (err) {
        console.warn(`[Main] Failed to clean temp download after interruption: ${localPath}`, err);
      }
    };

    try {
      const payload = {
        transferId,
        sourcePath: remotePath,
        targetPath: localPath,
        sourceType: "sftp",
        targetType: "local",
        sourceSftpId: sftpId,
        sourceEncoding: encoding,
        totalBytes: 0,
      };

      const result = await transferBridge.startTransfer(event, payload);

      if (result.error) {
        await cleanupPartialDownload();
        if (result.error === "Transfer cancelled") {
          return { localPath, cancelled: true };
        }
        throw new Error(result.error);
      }
      return { localPath, cancelled: false };
    } catch (err) {
      await cleanupPartialDownload();
      throw err;
    }
  });

  // Delete a temp file (for cleanup when editors close)
  ipcMain.handle("netcatty:deleteTempFile", async (_event, { filePath }) => {
    try {
      // Only allow deleting files in Netcatty temp directory for security
      const netcattyTempDir = path.resolve(getTempDirBridge().getTempDir());
      const resolvedPath = path.resolve(String(filePath || ""));
      if (!isPathInside(netcattyTempDir, resolvedPath)) {
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
  const win = await getWindowManager().createWindow(electronModule, {
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

// Ensure single-instance behavior — must run before app.whenReady() so
// the second instance never attempts to register the app:// protocol or
// create a BrowserWindow (which would fail with ERR_FAILED).
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!focusMainWindow()) {
      // Window is missing or crashed — try to recreate it
      void createWindow().catch((err) => {
        console.error("[Main] Failed to recreate window on second-instance:", err);
        showStartupError(err);
      });
    }
  });

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
    const menu = getWindowManager().buildAppMenu(Menu, app, isMac);
    Menu.setApplicationMenu(menu);

    app.on("browser-window-created", (_event, win) => {
      try {
        const windowManager = getWindowManager();
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
    void createWindow().then(() => {
      // Trigger auto-update check 5 s after window creation.
      // startAutoCheck() is a no-op on unsupported platforms (Linux deb/rpm/snap).
      getAutoUpdateBridge().startAutoCheck(5000);

      // Pre-warm the settings window in the background so it opens instantly.
      // Delay slightly to avoid competing with main window first-paint resources.
      setTimeout(() => {
        getWindowManager().prewarmSettingsWindow(electronModule, {
          preload,
          devServerUrl: effectiveDevServerUrl,
          isDev,
          appIcon,
          isMac,
          electronDir,
        });
      }, 3000);
    }).catch((err) => {
      console.error("[Main] Failed to create main window:", err);
      showStartupError(err);
      try {
        app.quit();
      } catch {}
    });

    // Re-create or focus window on macOS dock click
    app.on("activate", () => {
      // If the main window was hidden (e.g. "close to tray"), clicking the Dock icon
      // should bring it back. Fallback to creating a new window if none exists.
      try {
        const mainWin = getWindowManager().getMainWindow?.();
        if (mainWin && !mainWin.isDestroyed?.()) {
          if (mainWin.isMinimized?.()) mainWin.restore();
          mainWin.show?.();
          mainWin.focus?.();
          try {
            app.focus({ steal: true });
          } catch {}
          return;
        }
      } catch {}

      if (focusMainWindow()) return;
      if (BrowserWindow.getAllWindows().length === 0) {
        void createWindow().catch((err) => {
          console.error("[Main] Failed to create window on activate:", err);
          showStartupError(err);
        });
      }
    });
  });

  // Cleanup on all windows closed
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("before-quit", () => {
    getWindowManager().setIsQuitting(true);
  });

  // Cleanup all PTY sessions and port forwarding tunnels before quitting
  app.on("will-quit", () => {
    try {
      sessionLogStreamManager.cleanupAll();
    } catch (err) {
      console.warn("Error during session log stream cleanup:", err);
    }
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
    try {
      getGlobalShortcutBridge().cleanup();
    } catch (err) {
      console.warn("Error during global shortcut cleanup:", err);
    }
    try {
      getAiBridge().cleanup();
    } catch (err) {
      console.warn("Error during AI bridge cleanup:", err);
    }
  });
}

// Graceful shutdown on SIGTERM/SIGINT to prevent zombie processes
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`[Main] Received ${sig}, quitting…`);
    app.quit();
  });
}

// Export for testing
module.exports = {
  sessions,
  sftpClients,
  ensureKeyDir,
  writeKeyToDisk,
};
