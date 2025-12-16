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

const { app, BrowserWindow, nativeTheme, Menu, protocol } = electronModule || {};
if (!app || !BrowserWindow) {
  throw new Error("Failed to load Electron runtime. Ensure the app is launched with the Electron binary.");
}

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const DEEPLINK_SCHEME = "netcatty";

// Register custom protocol as privileged BEFORE app.ready
// This allows WebAuthn to work without HTTP server overhead
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      secure: true,        // Treat as secure context (required for WebAuthn)
      standard: true,      // Allow relative URLs
      supportFetchAPI: true,
      corsEnabled: true,
    }
  }
]);

// Apply ssh2 protocol patch needed for OpenSSH sk-* signature layouts.
require("./bridges/ssh2SkPatch.cjs");

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
const biometricBridge = require("./bridges/biometricBridge.cjs");
const windowManager = require("./bridges/windowManager.cjs");

// GPU settings
// NOTE: Do not disable Chromium sandbox by default.
// On macOS, platform authenticators (Touch ID / WebAuthn) can become unavailable when sandboxing is disabled.
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
// On macOS, when launched via `open -a` for WebAuthn support, env vars aren't passed.
// Check for a temp config file written by launch.cjs
let devServerUrl = process.env.VITE_DEV_SERVER_URL;
const devConfigPath = path.join(__dirname, ".dev-config.json");
if (!devServerUrl && fs.existsSync(devConfigPath)) {
  try {
    const config = JSON.parse(fs.readFileSync(devConfigPath, "utf-8"));
    devServerUrl = config.VITE_DEV_SERVER_URL;
    console.log("[Main] Loaded dev config from file:", devServerUrl);
  } catch (e) {
    console.warn("[Main] Failed to read dev config:", e);
  }
}

const isDev = !!devServerUrl;
const preload = path.join(__dirname, "preload.cjs");
const isMac = process.platform === "darwin";
const appIcon = path.join(__dirname, "../public/icon.png");
const electronDir = __dirname;

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

function getDeepLinkFromArgv(argv) {
  const args = Array.isArray(argv) ? argv : [];
  return args.find((a) => typeof a === "string" && a.startsWith(`${DEEPLINK_SCHEME}://`));
}

function handleDeepLink(url) {
  if (!url || typeof url !== "string") return;
  // Currently used to bring the app back to foreground after browser WebAuthn completes.
  // Future: parse URL and navigate in renderer if needed.
  focusMainWindow();
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
  biometricBridge.registerHandlers(ipcMain);

  // Settings window handler
  ipcMain.handle("netcatty:settings:open", async () => {
    await windowManager.openSettingsWindow(electronModule, {
      preload,
      devServerUrl,
      isDev,
      appIcon,
      isMac,
      electronDir,
    });
    return true;
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

  console.log('[Main] All bridges registered successfully');
};

/**
 * Create the main application window
 */
async function createWindow() {
  const win = await windowManager.createWindow(electronModule, {
    preload,
    devServerUrl,
    isDev,
    appIcon,
    isMac,
    electronDir,
    onRegisterBridge: registerBridges,
  });
  
  return win;
}

// Application lifecycle
app.whenReady().then(() => {
  // Deep link protocol (netcatty://...) to return from browser helper pages.
  // Note: protocol registration works best in packaged builds; in dev it may require manual registration.
  try {
    if (process.defaultApp) {
      // Electron dev: pass the app entry to allow OS to re-launch correctly.
      const appPath = path.resolve(process.argv[1] || "");
      if (appPath) {
        app.setAsDefaultProtocolClient(DEEPLINK_SCHEME, process.execPath, [appPath]);
      } else {
        app.setAsDefaultProtocolClient(DEEPLINK_SCHEME);
      }
    } else {
      app.setAsDefaultProtocolClient(DEEPLINK_SCHEME);
    }
  } catch (err) {
    console.warn("[Main] Failed to register deep link protocol:", err?.message || err);
  }

  // Register custom protocol handler for production mode
  // This serves files from dist/ with proper MIME types and SPA routing
  if (!isDev) {
    const net = require('node:net');
    const { net: electronNet } = electronModule;
    
    protocol.handle('app', (request) => {
      const url = new URL(request.url);
      let filePath = url.pathname;
      
      // Remove leading slash for path joining
      if (filePath.startsWith('/')) {
        filePath = filePath.slice(1);
      }
      
      // Default to index.html for root
      if (!filePath || filePath === '') {
        filePath = 'index.html';
      }
      
      const distPath = path.join(electronDir, '../dist');
      let fullPath = path.join(distPath, filePath);
      
      // Security: ensure path is within dist directory
      if (!fullPath.startsWith(distPath)) {
        return new Response('Forbidden', { status: 403 });
      }
      
      // SPA fallback: if file doesn't exist and no extension, serve index.html
      if (!fs.existsSync(fullPath)) {
        const ext = path.extname(filePath);
        if (!ext || ext === '') {
          fullPath = path.join(distPath, 'index.html');
        }
      }
      
      // Check if file exists
      if (!fs.existsSync(fullPath)) {
        return new Response('Not Found', { status: 404 });
      }
      
      // Determine MIME type
      const ext = path.extname(fullPath).toLowerCase();
      const mimeTypes = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.mjs': 'text/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
        '.woff': 'font/woff',
        '.woff2': 'font/woff2',
        '.ttf': 'font/ttf',
        '.eot': 'application/vnd.ms-fontobject',
        '.wav': 'audio/wav',
        '.mp3': 'audio/mpeg',
        '.mp4': 'video/mp4',
        '.webm': 'video/webm',
        '.wasm': 'application/wasm',
      };
      const contentType = mimeTypes[ext] || 'application/octet-stream';
      
      // Read and return file
      try {
        const content = fs.readFileSync(fullPath);
        return new Response(content, {
          status: 200,
          headers: {
            'Content-Type': contentType,
            'Content-Length': content.length.toString(),
          },
        });
      } catch (err) {
        console.error('[Protocol] Error reading file:', fullPath, err);
        return new Response('Internal Server Error', { status: 500 });
      }
    });
    
    console.log('[Main] Custom app:// protocol registered');
  }

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

  // Create the main window
  createWindow();

  // Handle deep link passed at startup (Windows/Linux) after we have a window.
  const initialDeepLink = getDeepLinkFromArgv(process.argv);
  if (initialDeepLink) {
    handleDeepLink(initialDeepLink);
  }

  // Re-create window on macOS dock click
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// macOS deep links arrive here when app is already running
app.on("open-url", (event, url) => {
  try {
    event.preventDefault();
  } catch {}
  handleDeepLink(url);
});

// Ensure deep links focus the existing instance on Windows/Linux
try {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  } else {
    app.on("second-instance", (_event, argv) => {
      const url = getDeepLinkFromArgv(argv);
      if (url) handleDeepLink(url);
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

// Cleanup all PTY sessions before quitting to prevent node-pty assertion errors
app.on("will-quit", () => {
  try {
    terminalBridge.cleanupAllSessions();
  } catch (err) {
    console.warn("Error during terminal cleanup:", err);
  }
  try {
    windowManager.shutdownProductionStaticServer?.();
  } catch (err) {
    console.warn("Error during static server shutdown:", err);
  }
});

// Export for testing
module.exports = {
  sessions,
  sftpClients,
  ensureKeyDir,
  writeKeyToDisk,
};
