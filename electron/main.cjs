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
const {
  createProcessErrorController,
  installProcessErrorHandlers,
} = require("./bridges/processErrorGuards.cjs");
const processErrorController = createProcessErrorController({
  captureError(source, err) {
    try { crashLogBridge.captureError(source, err); } catch {}
  },
  onFatalError(err, context) {
    uninstallProcessErrorHandlers();
    if (context?.origin === 'unhandledRejection') {
      console.error('Unhandled rejection:', context.reason);
    } else {
      console.error('Uncaught exception:', err);
    }
    throw err;
  },
  logError(...args) {
    console.error(...args);
  },
  logWarn(...args) {
    console.warn(...args);
  },
});
let uninstallProcessErrorHandlers = installProcessErrorHandlers(process, processErrorController);

// Load Electron
let electronModule;
try {
  electronModule = require("node:electron");
} catch {
  electronModule = require("electron");
}

const { app, BrowserWindow, Menu, protocol, shell, clipboard, session, ipcMain } = electronModule || {};
if (!app || !BrowserWindow) {
  throw new Error("Failed to load Electron runtime. Ensure the app is launched with the Electron binary.");
}

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { execFile } = require("node:child_process");
const { getCliDiscoveryFilePath } = require("./cli/discoveryPath.cjs");
const {
  SSH_DEEP_LINK_CHANNEL,
  TELNET_DEEP_LINK_CHANNEL,
  JMS_DEEP_LINK_CHANNEL,
  applyInitialJmsDeepLinkPreference,
  applyInitialSshDeepLinkPreference,
  applyJmsProtocolClientPreference,
  applySshProtocolClientPreference,
  collectJmsDeepLinkUrls,
  collectPuttyStyleDeepLinkUrls,
  collectSshDeepLinkUrls,
  getSshDeepLinkRendererReadyTimeoutMs,
  collectTelnetDeepLinkUrls,
  redactPuttyCommandLinePasswords,
  isJmsDeepLinkUrl,
  isSshDeepLinkUrl,
  isTelnetDeepLinkUrl,
  readJmsDeepLinkEnabledPreference,
  readSshDeepLinkEnabledPreference,
  shouldDeliverJmsDeepLink,
  shouldDeliverSshDeepLink,
  shouldRequeueFailedSshDeepLinkDelivery,
  shouldDeliverTelnetDeepLink,
  updateJmsDeepLinkEnabledPreference,
  updateSshDeepLinkEnabledPreference,
  writeJmsDeepLinkEnabledPreference,
  writeSshDeepLinkEnabledPreference,
} = require("./deepLink.cjs");
const { getReusableMainWindow } = require("./mainWindowReuse.cjs");
const { createAppContentWindowClosedHandler } = require("./appWindowLifecycle.cjs");
const { PLUGIN_PROTOCOL_SCHEME } = require("./plugins/constants.cjs");
const { runPluginShutdown } = require("./plugins/shutdownCoordinator.cjs");
const {
  OPEN_TERMINAL_PATH_CHANNEL,
  collectOpenTerminalPathArgs,
  resolveOpenTerminalPath,
  resolveOpenTerminalPathsFromArgs,
} = require("./openTerminalPath.cjs");
const {
  applyExplorerContextMenuPreference,
  applyInitialExplorerContextMenuPreference,
  resolveExplorerContextMenuEnabled,
  resolveExplorerContextMenuLaunchSpec,
  updateExplorerContextMenuEnabledPreference,
  writeExplorerContextMenuEnabledPreference,
} = require("./explorerContextMenu.cjs");

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
    {
      scheme: PLUGIN_PROTOCOL_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: false,
        codeCache: true,
      },
    },
  ]);
} catch (err) {
  console.warn("[Main] Failed to register custom scheme privileges:", err);
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

// Restore standard DH groups that Electron's BoringSSL dropped from the named
// createDiffieHellmanGroup() API (e.g. modp2 / diffie-hellman-group1-sha1), so
// legacy network devices stay reachable (#1035). MUST run before any module that
// requires ssh2 — ssh2 destructures createDiffieHellmanGroup at load time.
require("./bridges/boringSslDhCompat.cjs").installBoringSslDhCompat();

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
const getHttpNetworkProxyBridge = createLazyModule("./bridges/httpNetworkProxyBridge.cjs");
const getWindowManager = createLazyModule("./bridges/windowManager.cjs");
const getVaultBackupBridge = createLazyModule("./bridges/vaultBackupBridge.cjs");
const {
  DEFAULT_APP_LOCK_SETTINGS,
  canLockFromSettings,
  createAppLockSettingsStore,
} = require("./bridges/appLockSettingsStore.cjs");
const {
  createAppLockController,
  createAppLockRuntimeBridge,
} = require("./bridges/appLockRuntimeBridge.cjs");
const {
  createAppLockSystemAuthBridge,
  resolveDefaultHelperPath,
} = require("./bridges/appLockSystemAuthBridge.cjs");
const {
  emitAppLockReopen,
  ensureAppLockForFreshSession,
  handleAppHide,
  handleActivateWithMainWindow,
  handleBeforeQuit,
  hasNoUsableAppContentWindows,
  shouldCommitQuitWithoutDirtyCheck,
} = require("./main/appLockLifecycle.cjs");
const ptyProcessTree = require("./bridges/ptyProcessTree.cjs");
const { queryDirtyEditors } = require("./bridges/dirtyEditorGuard.cjs");

// GPU settings
// NOTE: Do not disable Chromium sandbox by default.
// If you need to debug with sandbox disabled, set NETCATTY_NO_SANDBOX=1.
if (process.env.NETCATTY_NO_SANDBOX === "1") {
  app.commandLine.appendSwitch("no-sandbox");
}
// Avoid Chromium spare renderers that inflate baseline memory for little gain.
app.commandLine.appendSwitch("disable-features", "SpareRendererForSitePerProcess");
// Aggressive GPU enablement can break some environments; opt out with NETCATTY_COMPAT_GPU=1.
if (process.env.NETCATTY_COMPAT_GPU !== "1") {
  // Force hardware acceleration even on blocklisted GPUs (macs sometimes fall back to software)
  app.commandLine.appendSwitch("ignore-gpu-blocklist");
  app.commandLine.appendSwitch("ignore-gpu-blacklist"); // Some Chromium builds use this alias; keep both for safety
  app.commandLine.appendSwitch("enable-gpu-rasterization");
  app.commandLine.appendSwitch("enable-zero-copy");
}

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
if (isDev) {
  app.setName("Netcatty Dev");
  app.setPath("userData", path.join(app.getPath("userData"), "dev"));
}
const { applyPortableDataDirectory } = require("./portableData.cjs");
const portableData = applyPortableDataDirectory({ app });
if (portableData) {
  console.info(`[Main] Portable data directory: ${portableData.dataDirectory}`);
}
const preload = path.join(__dirname, "preload.cjs");
const isMac = process.platform === "darwin";
const appIconManager = require("./bridges/appIconManager.cjs");
const appPath = path.join(__dirname, "..");
appIconManager.initializeAppIconManager(appPath, {
  preferPublic: !app.isPackaged,
  isMac,
});
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

const APP_PROTOCOL_LONG_CACHE_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".css",
  ".json",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".wav",
  ".mp3",
  ".mp4",
  ".webm",
  ".wasm",
]);

function resolveContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return DIST_MIME_TYPES[ext] || "application/octet-stream";
}

function resolveAppProtocolCacheControl(filePath, distPath) {
  const relativePath = path.relative(distPath, filePath).replace(/\\/g, "/");
  if (relativePath === "index.html") return "no-store";
  const ext = path.extname(filePath).toLowerCase();
  if (relativePath.startsWith("assets/") && APP_PROTOCOL_LONG_CACHE_EXTENSIONS.has(ext)) {
    return "public, max-age=31536000, immutable";
  }
  return "no-cache";
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
            "Cache-Control": resolveAppProtocolCacheControl(fullPath, distPath),
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
    const win = getReusableMainWindow({ getWindowManager });
    if (!win) return false;

    // Cancel any in-flight close-to-tray hide so second-instance / dock-click
    // re-entry beats a pending leave-full-screen → hide sequence.
    try {
      getGlobalShortcutBridge().clearPendingFullscreenHide?.(win);
    } catch {}

    handleActivateWithMainWindow({
      app,
      mainWindow: win,
      globalShortcutBridge: getGlobalShortcutBridge(),
      windowManager: getWindowManager(),
      reopenWindows: getAppLockReopenWindows(),
    });
    try {
      app.focus({ steal: true });
    } catch {}

    return true;
  } catch {
    return false;
  }
}

function notifyAllAppLockReopenWindows() {
  emitAppLockReopen(getAppLockReopenWindows());
}

function getAppLockReopenWindows() {
  const windowManager = getWindowManager();
  const seen = new Set();
  const out = [];
  const add = (win) => {
    if (!win || seen.has(win)) return;
    seen.add(win);
    out.push(win);
  };
  for (const win of windowManager.getMainWindows?.() ?? []) add(win);
  add(windowManager.getSettingsWindow?.() ?? null);
  add(getGlobalShortcutBridge().getTrayPanelWindow?.() ?? null);
  for (const win of windowManager.getTerminalPopupWindows?.() ?? []) add(win);
  // Detached #/session-window renderers are app-content windows; they must get
  // reopenSignal for Touch ID/Hello auto-prompt after background re-lock.
  for (const win of windowManager.getAppContentWindows?.() ?? []) add(win);
  return out;
}

// Shared state
const sessions = new Map();
const sftpClients = new Map();
const keyRoot = path.join(os.homedir(), ".netcatty", "keys");
const APP_LOCK_SETTINGS_FILE = "app-lock-settings.json";
let cloudSyncSessionPassword = null;
const CLOUD_SYNC_PASSWORD_FILE = "netcatty_cloud_sync_master_password_v1";
let appLockSettingsStore = null;
const appLockRuntimeBridge = createAppLockRuntimeBridge();
let appLockController = null;

function getLiveAppLockWindows() {
  const windowManager = getWindowManager();
  return [
    BrowserWindow.getFocusedWindow?.(),
    ...(windowManager.getMainWindows?.() ?? []),
    windowManager.getSettingsWindow?.() ?? null,
    getGlobalShortcutBridge().getTrayPanelWindow?.() ?? null,
    ...(windowManager.getTerminalPopupWindows?.() ?? []),
  ].filter((win) => (
    win &&
    typeof win.isDestroyed === "function" &&
    !win.isDestroyed() &&
    typeof win.getNativeWindowHandle === "function"
  ));
}

function getAppLockNativeWindowHandle() {
  const win = getLiveAppLockWindows()[0] || null;
  return win ? win.getNativeWindowHandle() : null;
}

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

const { createBridgeRegistrar } = require("./main/registerBridges.cjs");

const registerBridges = createBridgeRegistrar({
  electronModule,
  app,
  BrowserWindow,
  shell,
  clipboard,
  path,
  fs,
  os,
  preload,
  effectiveDevServerUrl,
  isDev,
  getAppIconPath: () => appIconManager.getAppIconPath(appPath),
  isMac,
  electronDir,
  appPath,
  appIconManager,
  sessions,
  sftpClients,
  CLOUD_SYNC_PASSWORD_FILE,
  getCliDiscoveryFilePath,
  sshBridge,
  sftpBridge,
  localFsBridge,
  transferBridge,
  portForwardingBridge,
  terminalBridge,
  crashLogBridge,
  ptyProcessTree,
  ensureMainWindow: createAndShowMainWindow,
  getOauthBridge,
  getGithubAuthBridge,
  getGoogleAuthBridge,
  getOnedriveAuthBridge,
  getCloudSyncBridge,
  getFileWatcherBridge,
  getTempDirBridge,
  getSessionLogsBridge,
  getCompressUploadBridge,
  getGlobalShortcutBridge,
  getCredentialBridge,
  getAutoUpdateBridge,
  getAiBridge,
  getHttpNetworkProxyBridge,
  getWindowManager,
  getVaultBackupBridge,
  getAppLockController: () => appLockController,
  isPathInside,
});
/**
 * Create the main application window
 */
async function createWindow() {
  const windowManager = getWindowManager();
  windowManager.setAppContentWindowClosedHandler(createAppContentWindowClosedHandler({
    app,
    windowManager,
  }));
  const win = await windowManager.createWindow(electronModule, {
    preload,
    devServerUrl: effectiveDevServerUrl,
    isDev,
    appIcon: appIconManager.getAppIconPath(appPath),
    isMac,
    electronDir,
    onRegisterBridge: registerBridges,
  });
  
  return win;
}

function waitForWindowToShow(win) {
  return new Promise((resolve, reject) => {
    if (!win || win.isDestroyed?.()) {
      reject(new Error("Main window was destroyed before first show."));
      return;
    }
    if (win.isVisible?.()) {
      resolve();
      return;
    }

    const cleanup = () => {
      try { win.removeListener("show", handleShow); } catch {}
      try { win.removeListener("closed", handleClosed); } catch {}
      try { win.webContents?.removeListener?.("render-process-gone", handleGone); } catch {}
    };

    const handleShow = () => {
      cleanup();
      resolve();
    };
    const handleClosed = () => {
      cleanup();
      reject(new Error("Main window closed before first show."));
    };
    const handleGone = (_event, details) => {
      cleanup();
      reject(new Error(`Renderer process exited before first show: ${details?.reason || "unknown"}`));
    };

    win.once("show", handleShow);
    win.once("closed", handleClosed);
    win.webContents?.once?.("render-process-gone", handleGone);
  });
}

let mainWindowStartupPromise = null;

async function createAndShowMainWindow() {
  if (mainWindowStartupPromise) return mainWindowStartupPromise;

  // macOS Dock/tray reopen after every app-content window was closed leaves the
  // process alive with an already-initialized (and possibly unlocked) app-lock
  // runtime. Re-lock before the new renderer mounts so unlock does not stick.
  // Count settings/tray/popup windows too — an open Settings or session popup
  // means this is not a fresh session (Codex P2 on 100394dc).
  try {
    if (hasNoUsableAppContentWindows(getAppLockReopenWindows())) {
      ensureAppLockForFreshSession(appLockController, "startup");
    }
  } catch {
    // ignore — window creation should still proceed
  }

  const existingWin = getReusableMainWindow({ getWindowManager });
  if (existingWin) {
    focusMainWindow();
    return existingWin;
  }

  mainWindowStartupPromise = (async () => {
    processErrorController.beginMainWindowStartup();
    try {
      const win = await createWindow();
      await waitForWindowToShow(win);
      void getWindowManager().waitForRendererReady(win, {
        timeoutMs: isDev ? 30000 : 15000,
      }).catch((err) => {
        console.warn("[Main] Renderer ready signal was late or missing after first show:", err?.message || err);
      });
      processErrorController.completeMainWindowStartup({ windowShown: true });
      return win;
    } catch (err) {
      processErrorController.completeMainWindowStartup({ windowShown: false });
      throw err;
    } finally {
      mainWindowStartupPromise = null;
    }
  })();

  return mainWindowStartupPromise;
}

let sshDeepLinkEnabled = readSshDeepLinkEnabledPreference({ app });
const puttyStyleDeepLinks = sshDeepLinkEnabled
  ? collectPuttyStyleDeepLinkUrls(process.argv)
  : { ssh: [], telnet: [] };
const pendingSshDeepLinkUrls = sshDeepLinkEnabled
  ? [...collectSshDeepLinkUrls(process.argv), ...puttyStyleDeepLinks.ssh]
  : [];
const pendingTelnetDeepLinkUrls = sshDeepLinkEnabled
  ? [...collectTelnetDeepLinkUrls(process.argv), ...puttyStyleDeepLinks.telnet]
  : [];
if (sshDeepLinkEnabled) {
  redactPuttyCommandLinePasswords(process.argv);
}
const pendingOpenTerminalPaths = resolveOpenTerminalPathsFromArgs(process.argv);
let flushingSshDeepLinks = false;
let flushingTelnetDeepLinks = false;
let flushingOpenTerminalPaths = false;
let sshDeepLinkDeliveryGeneration = 0;

let jmsDeepLinkEnabled = readJmsDeepLinkEnabledPreference({ app });
const pendingJmsDeepLinkUrls = jmsDeepLinkEnabled ? collectJmsDeepLinkUrls(process.argv) : [];
let flushingJmsDeepLinks = false;
let jmsDeepLinkDeliveryGeneration = 0;

let explorerContextMenuEnabled = resolveExplorerContextMenuEnabled({ app }).enabled === true;

function queueSshDeepLink(rawUrl) {
  if (!sshDeepLinkEnabled) return;
  if (!isSshDeepLinkUrl(rawUrl)) return;
  pendingSshDeepLinkUrls.push(rawUrl);
  if (app.isReady?.()) {
    void flushPendingSshDeepLinks();
  }
}

function queueTelnetDeepLink(rawUrl) {
  if (!sshDeepLinkEnabled) return;
  if (!isTelnetDeepLinkUrl(rawUrl)) return;
  pendingTelnetDeepLinkUrls.push(rawUrl);
  if (app.isReady?.()) {
    void flushPendingTelnetDeepLinks();
  }
}

function queueOpenTerminalPath(rawPath, options = {}) {
  const resolvedPath = resolveOpenTerminalPath(rawPath, options);
  if (!resolvedPath) return;
  pendingOpenTerminalPaths.push(resolvedPath);
  if (app.isReady?.()) {
    void flushPendingOpenTerminalPaths();
  }
}

function queueResolvedOpenTerminalPaths(paths) {
  if (!Array.isArray(paths) || paths.length === 0) return;
  pendingOpenTerminalPaths.push(...paths);
  if (app.isReady?.()) {
    void flushPendingOpenTerminalPaths();
  }
}

ipcMain?.handle?.("netcatty:deepLink:ssh:setEnabled", async (_event, payload) => {
  const enabled = payload?.enabled !== false;
  const result = updateSshDeepLinkEnabledPreference({
    currentEnabled: sshDeepLinkEnabled,
    enabled,
    applyPreference: (nextEnabled) => applySshProtocolClientPreference({ app, enabled: nextEnabled, isDev }),
    writePreference: (nextEnabled) => writeSshDeepLinkEnabledPreference({ app, enabled: nextEnabled }),
    clearPending: () => {
      pendingSshDeepLinkUrls.length = 0;
      pendingTelnetDeepLinkUrls.length = 0;
      sshDeepLinkDeliveryGeneration += 1;
    },
  });
  sshDeepLinkEnabled = result.enabled;
  return result;
});

ipcMain?.handle?.("netcatty:deepLink:ssh:getEnabled", async () => sshDeepLinkEnabled);

function queueJmsDeepLink(rawUrl) {
  if (!jmsDeepLinkEnabled) return;
  if (!isJmsDeepLinkUrl(rawUrl)) return;
  pendingJmsDeepLinkUrls.push(rawUrl);
  if (app.isReady?.()) {
    void flushPendingJmsDeepLinks();
  }
}

ipcMain?.handle?.("netcatty:deepLink:jms:setEnabled", async (_event, payload) => {
  const enabled = payload?.enabled !== false;
  const result = updateJmsDeepLinkEnabledPreference({
    currentEnabled: jmsDeepLinkEnabled,
    enabled,
    applyPreference: (nextEnabled) => applyJmsProtocolClientPreference({ app, enabled: nextEnabled, isDev }),
    writePreference: (nextEnabled) => writeJmsDeepLinkEnabledPreference({ app, enabled: nextEnabled }),
    clearPending: () => {
      pendingJmsDeepLinkUrls.length = 0;
      jmsDeepLinkDeliveryGeneration += 1;
    },
  });
  jmsDeepLinkEnabled = result.enabled;
  return result;
});

ipcMain?.handle?.("netcatty:deepLink:jms:getEnabled", async () => jmsDeepLinkEnabled);

ipcMain?.handle?.("netcatty:explorerContextMenu:setEnabled", async (_event, payload) => {
  const enabled = payload?.enabled !== false;
  const launchSpec = resolveExplorerContextMenuLaunchSpec();
  const result = updateExplorerContextMenuEnabledPreference({
    currentEnabled: explorerContextMenuEnabled,
    enabled,
    applyPreference: (nextEnabled) => applyExplorerContextMenuPreference({
      enabled: nextEnabled,
      executablePath: launchSpec.executablePath,
      appArgs: launchSpec.appArgs,
    }),
    writePreference: (nextEnabled) => writeExplorerContextMenuEnabledPreference({
      app,
      enabled: nextEnabled,
      executablePath: launchSpec.executablePath,
      appArgs: launchSpec.appArgs,
    }),
  });
  explorerContextMenuEnabled = result.enabled === true;
  return result;
});

ipcMain?.handle?.("netcatty:explorerContextMenu:getEnabled", async () => ({
  enabled: explorerContextMenuEnabled,
  supported: process.platform === "win32",
}));

async function deliverJmsDeepLink(rawUrl, expectedGeneration = jmsDeepLinkDeliveryGeneration) {
  if (!shouldDeliverJmsDeepLink({
    enabled: jmsDeepLinkEnabled,
    deliveryGeneration: jmsDeepLinkDeliveryGeneration,
    expectedGeneration,
  })) return;
  const win = await createAndShowMainWindow();
  if (!shouldDeliverJmsDeepLink({
    enabled: jmsDeepLinkEnabled,
    deliveryGeneration: jmsDeepLinkDeliveryGeneration,
    expectedGeneration,
  })) return;
  focusMainWindow();
  const windowManager = getWindowManager();
  const result = await windowManager.sendWhenRendererReady?.(
    win,
    JMS_DEEP_LINK_CHANNEL,
    { url: rawUrl },
    {
      timeoutMs: 0,
      shouldSend: () => shouldDeliverJmsDeepLink({
        enabled: jmsDeepLinkEnabled,
        deliveryGeneration: jmsDeepLinkDeliveryGeneration,
        expectedGeneration,
      }),
      cancelReason: "jms-deep-link-disabled",
    },
  );
  if (result && result.success === false && result.reason !== "jms-deep-link-disabled") {
    console.warn("[Main] Failed to deliver jms:// deep link:", result.error || result.reason);
  }
  return result || { success: true };
}

async function flushPendingJmsDeepLinks() {
  if (flushingJmsDeepLinks) return;
  flushingJmsDeepLinks = true;
  let requeueDelayMs = 0;
  try {
    while (jmsDeepLinkEnabled && pendingJmsDeepLinkUrls.length > 0) {
      const rawUrl = pendingJmsDeepLinkUrls.shift();
      if (!rawUrl) continue;
      const result = await deliverJmsDeepLink(rawUrl, jmsDeepLinkDeliveryGeneration);
      if (shouldRequeueFailedSshDeepLinkDelivery({
        enabled: jmsDeepLinkEnabled,
        deliveryGeneration: jmsDeepLinkDeliveryGeneration,
        expectedGeneration: jmsDeepLinkDeliveryGeneration,
        result,
        cancelReason: "jms-deep-link-disabled",
      })) {
        pendingJmsDeepLinkUrls.unshift(rawUrl);
        requeueDelayMs = 1000;
        break;
      }
    }
  } catch (err) {
    console.warn("[Main] Failed to process jms:// deep link:", err);
  } finally {
    flushingJmsDeepLinks = false;
    if (jmsDeepLinkEnabled && pendingJmsDeepLinkUrls.length > 0) {
      if (requeueDelayMs > 0) {
        setTimeout(() => {
          void flushPendingJmsDeepLinks();
        }, requeueDelayMs);
      } else {
        void flushPendingJmsDeepLinks();
      }
    }
  }
}

async function deliverSshDeepLink(rawUrl, expectedGeneration = sshDeepLinkDeliveryGeneration) {
  if (!shouldDeliverSshDeepLink({
    enabled: sshDeepLinkEnabled,
    deliveryGeneration: sshDeepLinkDeliveryGeneration,
    expectedGeneration,
  })) {
    return { success: false, reason: "ssh-deep-link-disabled" };
  }
  const win = await createAndShowMainWindow();
  if (!shouldDeliverSshDeepLink({
    enabled: sshDeepLinkEnabled,
    deliveryGeneration: sshDeepLinkDeliveryGeneration,
    expectedGeneration,
  })) {
    return { success: false, reason: "ssh-deep-link-disabled" };
  }
  focusMainWindow();
  const windowManager = getWindowManager();
  // timeoutMs: 0 waits until AppLockGate marks the renderer ready after unlock,
  // so a slow password entry does not drop startup ssh:// links.
  const result = await windowManager.sendWhenRendererReady?.(
    win,
    SSH_DEEP_LINK_CHANNEL,
    { url: rawUrl },
    {
      timeoutMs: getSshDeepLinkRendererReadyTimeoutMs({ isDev }),
      shouldSend: () => shouldDeliverSshDeepLink({
        enabled: sshDeepLinkEnabled,
        deliveryGeneration: sshDeepLinkDeliveryGeneration,
        expectedGeneration,
      }),
      cancelReason: "ssh-deep-link-disabled",
    },
  );
  if (result && result.success === false && result.reason !== "ssh-deep-link-disabled") {
    console.warn("[Main] Failed to deliver ssh:// deep link:", result.error || result.reason);
  }
  return result || { success: true };
}

async function deliverTelnetDeepLink(rawUrl, expectedGeneration = sshDeepLinkDeliveryGeneration) {
  if (!shouldDeliverTelnetDeepLink({
    enabled: sshDeepLinkEnabled,
    deliveryGeneration: sshDeepLinkDeliveryGeneration,
    expectedGeneration,
  })) return;
  const win = await createAndShowMainWindow();
  if (!shouldDeliverTelnetDeepLink({
    enabled: sshDeepLinkEnabled,
    deliveryGeneration: sshDeepLinkDeliveryGeneration,
    expectedGeneration,
  })) return;
  focusMainWindow();
  const windowManager = getWindowManager();
  const result = await windowManager.sendWhenRendererReady?.(
    win,
    TELNET_DEEP_LINK_CHANNEL,
    { url: rawUrl },
    {
      timeoutMs: 0,
      shouldSend: () => shouldDeliverTelnetDeepLink({
        enabled: sshDeepLinkEnabled,
        deliveryGeneration: sshDeepLinkDeliveryGeneration,
        expectedGeneration,
      }),
      cancelReason: "telnet-deep-link-disabled",
    },
  );
  if (result && result.success === false && result.reason !== "telnet-deep-link-disabled") {
    console.warn("[Main] Failed to deliver telnet:// deep link:", result.error || result.reason);
  }
  return result || { success: true };
}

async function flushPendingSshDeepLinks() {
  if (flushingSshDeepLinks) return;
  flushingSshDeepLinks = true;
  let requeueDelayMs = 0;
  try {
    while (sshDeepLinkEnabled && pendingSshDeepLinkUrls.length > 0) {
      const rawUrl = pendingSshDeepLinkUrls.shift();
      if (!rawUrl) continue;
      const result = await deliverSshDeepLink(rawUrl, sshDeepLinkDeliveryGeneration);
      if (shouldRequeueFailedSshDeepLinkDelivery({
        enabled: sshDeepLinkEnabled,
        deliveryGeneration: sshDeepLinkDeliveryGeneration,
        expectedGeneration: sshDeepLinkDeliveryGeneration,
        result,
        cancelReason: "ssh-deep-link-disabled",
      })) {
        // Window died or delivery failed while the link is still valid — keep it
        // queued for the next successful window/renderer ready cycle.
        pendingSshDeepLinkUrls.unshift(rawUrl);
        requeueDelayMs = 1000;
        break;
      }
    }
  } catch (err) {
    console.warn("[Main] Failed to process ssh:// deep link:", err);
  } finally {
    flushingSshDeepLinks = false;
    if (sshDeepLinkEnabled && pendingSshDeepLinkUrls.length > 0) {
      if (requeueDelayMs > 0) {
        setTimeout(() => {
          void flushPendingSshDeepLinks();
        }, requeueDelayMs);
      } else {
        void flushPendingSshDeepLinks();
      }
    }
  }
}

async function flushPendingTelnetDeepLinks() {
  if (flushingTelnetDeepLinks) return;
  flushingTelnetDeepLinks = true;
  let requeueDelayMs = 0;
  try {
    while (sshDeepLinkEnabled && pendingTelnetDeepLinkUrls.length > 0) {
      const rawUrl = pendingTelnetDeepLinkUrls.shift();
      if (!rawUrl) continue;
      const result = await deliverTelnetDeepLink(rawUrl, sshDeepLinkDeliveryGeneration);
      if (shouldRequeueFailedSshDeepLinkDelivery({
        enabled: sshDeepLinkEnabled,
        deliveryGeneration: sshDeepLinkDeliveryGeneration,
        expectedGeneration: sshDeepLinkDeliveryGeneration,
        result,
        cancelReason: "telnet-deep-link-disabled",
      })) {
        pendingTelnetDeepLinkUrls.unshift(rawUrl);
        requeueDelayMs = 1000;
        break;
      }
    }
  } catch (err) {
    console.warn("[Main] Failed to process telnet:// deep link:", err);
  } finally {
    flushingTelnetDeepLinks = false;
    if (sshDeepLinkEnabled && pendingTelnetDeepLinkUrls.length > 0) {
      if (requeueDelayMs > 0) {
        setTimeout(() => {
          void flushPendingTelnetDeepLinks();
        }, requeueDelayMs);
      } else {
        void flushPendingTelnetDeepLinks();
      }
    }
  }
}

async function deliverOpenTerminalPath(targetPath) {
  const win = await createAndShowMainWindow();
  focusMainWindow();
  const windowManager = getWindowManager();
  const result = await windowManager.sendWhenRendererReady?.(
    win,
    OPEN_TERMINAL_PATH_CHANNEL,
    { path: targetPath },
    { timeoutMs: 0 },
  );
  if (result && result.success === false) {
    console.warn("[Main] Failed to deliver open terminal path:", result.error || result.reason);
  }
  return result || { success: true };
}

async function flushPendingOpenTerminalPaths() {
  if (flushingOpenTerminalPaths) return;
  flushingOpenTerminalPaths = true;
  let requeueDelayMs = 0;
  try {
    while (pendingOpenTerminalPaths.length > 0) {
      const targetPath = pendingOpenTerminalPaths.shift();
      if (!targetPath) continue;
      const result = await deliverOpenTerminalPath(targetPath);
      if (result && result.success === false) {
        pendingOpenTerminalPaths.unshift(targetPath);
        requeueDelayMs = 1000;
        break;
      }
    }
  } catch (err) {
    console.warn("[Main] Failed to process open terminal path:", err);
  } finally {
    flushingOpenTerminalPaths = false;
    if (pendingOpenTerminalPaths.length > 0) {
      if (requeueDelayMs > 0) {
        setTimeout(() => {
          void flushPendingOpenTerminalPaths();
        }, requeueDelayMs);
      } else {
        void flushPendingOpenTerminalPaths();
      }
    }
  }
}

function hasPendingColdStartLaunchIntents() {
  return (
    flushingSshDeepLinks
    || flushingTelnetDeepLinks
    || flushingJmsDeepLinks
    || flushingOpenTerminalPaths
    || pendingSshDeepLinkUrls.length > 0
    || pendingTelnetDeepLinkUrls.length > 0
    || pendingJmsDeepLinkUrls.length > 0
    || pendingOpenTerminalPaths.length > 0
  );
}

async function drainColdStartLaunchIntents() {
  // Re-entrant void flushes from finally blocks must finish before we notify
  // the renderer; otherwise landing can race a still-queued startup intent.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await Promise.all([
      flushPendingSshDeepLinks(),
      flushPendingTelnetDeepLinks(),
      flushPendingJmsDeepLinks(),
      flushPendingOpenTerminalPaths(),
    ]);
    if (!hasPendingColdStartLaunchIntents()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function notifyColdStartIntentsSettled(win) {
  try {
    if (!win || win.isDestroyed?.()) return;
    win.webContents?.send?.("netcatty:startup:coldStartIntentsSettled");
  } catch (err) {
    console.warn("[Main] Failed to notify cold-start intents settled:", err);
  }
}

function hasUsableWindow() {
  try {
    const windowManager = getWindowManager();
    return [windowManager.getMainWindow?.(), windowManager.getSettingsWindow?.()]
      .some((win) => windowManager.isWindowUsable?.(win, { requireVisible: true }));
  } catch {
    return false;
  }
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
  app.on("open-url", (event, rawUrl) => {
    event.preventDefault();
    if (isJmsDeepLinkUrl(rawUrl)) {
      queueJmsDeepLink(rawUrl);
      return;
    }
    if (isTelnetDeepLinkUrl(rawUrl)) {
      queueTelnetDeepLink(rawUrl);
      return;
    }
    queueSshDeepLink(rawUrl);
  });

  app.on("open-file", (event, filePath) => {
    event.preventDefault();
    queueOpenTerminalPath(filePath);
  });

  app.on("second-instance", (_event, argv, workingDirectory) => {
    const jmsDeepLinkUrls = collectJmsDeepLinkUrls(argv);
    const puttyStyleDeepLinks = collectPuttyStyleDeepLinkUrls(argv);
    const telnetDeepLinkUrls = [
      ...collectTelnetDeepLinkUrls(argv),
      ...puttyStyleDeepLinks.telnet,
    ];
    const sshDeepLinkUrls = [
      ...collectSshDeepLinkUrls(argv),
      ...puttyStyleDeepLinks.ssh,
    ];
    if (jmsDeepLinkUrls.length > 0 || sshDeepLinkUrls.length > 0 || telnetDeepLinkUrls.length > 0) {
      redactPuttyCommandLinePasswords(argv);
    }
    if (jmsDeepLinkUrls.length > 0) {
      if (jmsDeepLinkEnabled) {
        jmsDeepLinkUrls.forEach(queueJmsDeepLink);
      }
      return;
    }
    if (telnetDeepLinkUrls.length > 0) {
      if (sshDeepLinkEnabled) {
        telnetDeepLinkUrls.forEach(queueTelnetDeepLink);
      }
      return;
    }
    if (sshDeepLinkUrls.length > 0) {
      if (sshDeepLinkEnabled) {
        sshDeepLinkUrls.forEach(queueSshDeepLink);
      }
      return;
    }
    if (collectOpenTerminalPathArgs(argv).length > 0) {
      const baseDirectory = typeof workingDirectory === "string" ? workingDirectory : undefined;
      const openTerminalPaths = resolveOpenTerminalPathsFromArgs(argv, { baseDirectory });
      if (openTerminalPaths.length > 0) {
        queueResolvedOpenTerminalPaths(openTerminalPaths);
      } else {
        // Still bring the app forward when Explorer launched us but the path
        // failed validation — silent no-op feels like a broken menu item.
        console.warn("[Main] Open-terminal-path args present but no valid path resolved:", argv);
        if (!focusMainWindow()) {
          void createAndShowMainWindow().catch((err) => {
            console.error("[Main] Failed to recreate window on open-terminal-path:", err);
          });
        }
      }
      return;
    }
    if (!focusMainWindow()) {
      // Window is missing or crashed — try to recreate it
      void createAndShowMainWindow().catch((err) => {
        console.error("[Main] Failed to recreate window on second-instance:", err);
        showStartupError(err);
        if (!hasUsableWindow()) {
          try { app.quit(); } catch {}
        }
      });
    }
  });

  // Application lifecycle
  app.whenReady().then(async () => {
    registerAppProtocol();
    const initialSshDeepLinkPreference = applyInitialSshDeepLinkPreference({
      enabled: sshDeepLinkEnabled,
      applyPreference: (enabled) => applySshProtocolClientPreference({ app, enabled, isDev }),
      clearPending: () => {
        pendingSshDeepLinkUrls.length = 0;
        pendingTelnetDeepLinkUrls.length = 0;
        sshDeepLinkDeliveryGeneration += 1;
      },
    });
    sshDeepLinkEnabled = initialSshDeepLinkPreference.enabled;

    appLockSettingsStore = createAppLockSettingsStore({
      filePath: path.join(app.getPath("userData"), APP_LOCK_SETTINGS_FILE),
      readFile: (filePath, encoding) => fs.promises.readFile(filePath, encoding),
      writeFile: (filePath, content, options) => fs.promises.writeFile(filePath, content, options),
      rename: (from, to) => fs.promises.rename(from, to),
    });

    let persistedAppLockSettings = DEFAULT_APP_LOCK_SETTINGS;
    try {
      persistedAppLockSettings = await appLockSettingsStore.load();
    } catch (err) {
      console.warn("[Main] Failed to load app lock settings, defaulting to disabled:", err);
      persistedAppLockSettings = appLockSettingsStore.getSnapshot();
    }

    const lockOnStartup = canLockFromSettings(persistedAppLockSettings);
    appLockRuntimeBridge.initialize({
      locked: lockOnStartup,
      reason: lockOnStartup ? "startup" : null,
      lastActivityAt: Date.now(),
    });
    const appLockSystemAuthBridge = createAppLockSystemAuthBridge({
      platform: process.platform,
      systemPreferences: electronModule.systemPreferences,
      execFile,
      helperPath: resolveDefaultHelperPath({ isPackaged: app.isPackaged }),
      getNativeWindowHandle: getAppLockNativeWindowHandle,
    });
    appLockController = createAppLockController({
      settingsStore: appLockSettingsStore,
      runtimeBridge: appLockRuntimeBridge,
      systemAuthBridge: appLockSystemAuthBridge,
      getMainWindows: () => getWindowManager().getMainWindows?.() ?? [],
      // Includes detached session windows (registerAsMainWindow:false).
      getAppContentWindows: () => getWindowManager().getAppContentWindows?.() ?? [],
      getSettingsWindow: () => getWindowManager().getSettingsWindow?.() ?? null,
      getTrayPanelWindow: () => getGlobalShortcutBridge().getTrayPanelWindow?.() ?? null,
      getTerminalPopupWindows: () => getWindowManager().getTerminalPopupWindows?.() ?? [],
    });
    appLockController.syncIdleTimer?.();

    const initialJmsDeepLinkPreference = applyInitialJmsDeepLinkPreference({
      enabled: jmsDeepLinkEnabled,
      applyPreference: (enabled) => applyJmsProtocolClientPreference({ app, enabled, isDev }),
      clearPending: () => {
        pendingJmsDeepLinkUrls.length = 0;
        jmsDeepLinkDeliveryGeneration += 1;
      },
    });
    jmsDeepLinkEnabled = initialJmsDeepLinkPreference.enabled;

    const explorerLaunchSpec = resolveExplorerContextMenuLaunchSpec();
    const initialExplorerContextMenuPreference = applyInitialExplorerContextMenuPreference({
      app,
      executablePath: explorerLaunchSpec.executablePath,
      appArgs: explorerLaunchSpec.appArgs,
    });
    explorerContextMenuEnabled = initialExplorerContextMenuPreference.enabled === true;

    // Spellcheck dictionaries/workers are unused in Netcatty and cost memory.
    try {
      session?.defaultSession?.setSpellCheckerEnabled?.(false);
    } catch {
      // ignore
    }

    // Grant only the Chromium permissions the app actually uses, and only
    // to the app's own origin. The default session is shared with in-app
    // OAuth pop-ups (accounts.google.com, login.microsoftonline.com, ...),
    // so non-app origins are denied outright; for the app itself we keep
    // an explicit allow-list rather than blanket-approving everything.
    try {
      const defaultSession = session?.defaultSession;
      if (defaultSession) {
        // app:// is registered as a standard scheme in Chromium
        // (registerSchemesAsPrivileged above) but Node's WHATWG URL parser
        // doesn't include it in its special-scheme list, so
        // `new URL('app://netcatty/...').origin` returns the string "null"
        // — matching against an `app://netcatty` origin string would
        // therefore fail in packaged builds. Match by protocol + host
        // instead, and only fall back to .origin for HTTP-family URLs
        // (the dev server).
        const allowedHttpOrigins = new Set();
        if (effectiveDevServerUrl) {
          try {
            allowedHttpOrigins.add(new URL(effectiveDevServerUrl).origin);
          } catch {
            // ignore malformed dev server URL
          }
        }
        const isAppOrigin = (rawUrl) => {
          if (!rawUrl) return false;
          try {
            const parsed = new URL(String(rawUrl));
            if (parsed.protocol === "app:") {
              return parsed.host === "netcatty";
            }
            return allowedHttpOrigins.has(parsed.origin);
          } catch {
            return false;
          }
        };

        // Permissions the renderer is known to need:
        //   - local-fonts: terminal font picker enumeration (this PR)
        //   - clipboard-read / clipboard-sanitized-write: terminal & SFTP
        //     copy-paste flows (navigator.clipboard.{read,write}Text)
        const APP_ALLOWED_PERMISSIONS = new Set([
          "local-fonts",
          "clipboard-read",
          "clipboard-sanitized-write",
        ]);

        defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
          const requestingUrl =
            details?.requestingUrl ||
            (typeof wc?.getURL === "function" ? wc.getURL() : "");
          if (!isAppOrigin(requestingUrl)) {
            callback(false);
            return;
          }
          callback(APP_ALLOWED_PERMISSIONS.has(permission));
        });

        defaultSession.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
          const url =
            requestingOrigin ||
            details?.requestingUrl ||
            (typeof wc?.getURL === "function" ? wc.getURL() : "");
          if (!isAppOrigin(url)) return false;
          return APP_ALLOWED_PERMISSIONS.has(permission);
        });
      }
    } catch (err) {
      console.warn("[Main] Failed to install permission handlers:", err);
    }

    // Build and set application menu. A broken menu should not take down
    // the entire app — fall back to no custom menu and continue startup.
    try {
      const menu = getWindowManager().buildAppMenu(Menu, app, isMac, undefined, {
        isAppLocked: () => Boolean(appLockRuntimeBridge?.getState?.()?.locked),
        setAppLockWindowTitle: (win, title) => appLockController?.setWindowTitle?.(win, title),
      });
      Menu.setApplicationMenu(menu);
    } catch (err) {
      console.error("[Main] Failed to build application menu:", err);
      try {
        Menu.setApplicationMenu(null);
      } catch {}
    }

    app.on("browser-window-created", (_event, win) => {
      try {
        appLockController?.protectWindow?.(win);
        const windowManager = getWindowManager();
        const mainWin = windowManager.getMainWindow();
        const settingsWin = windowManager.getSettingsWindow();
        const isPrimary = win === mainWin || win === settingsWin;
        if (!isPrimary) {
          win.setMenuBarVisibility(false);
          win.autoHideMenuBar = true;
          win.setMenu(null);
          const iconPath = appIconManager.getAppIconPath(appPath);
          if (iconPath && win.setIcon) win.setIcon(iconPath);
        }
      } catch {
        // ignore
      }
    });

    // Create the main window
    void createAndShowMainWindow().then(async (win) => {
      // Empty cold-start queues would otherwise notify immediately (before the
      // renderer subscribes). Wait for ready, then drain, then settle.
      try {
        await getWindowManager().waitForRendererReady(win, {
          timeoutMs: 0,
        });
      } catch (err) {
        console.warn(
          "[Main] Renderer ready signal was late or missing before cold-start settle:",
          err?.message || err,
        );
      }
      await drainColdStartLaunchIntents();
      notifyColdStartIntentsSettled(win);

      // Trigger auto-update check 5 s after window creation.
      // startAutoCheck() is a no-op on unsupported platforms (for example Linux
      // Snap or an unmarked development build).
      getAutoUpdateBridge().startAutoCheck(5000);

      // Settings prewarm is opt-in: a hidden BrowserWindow holds a full renderer.
      // Enable with NETCATTY_PREWARM_SETTINGS=1 (delayed so first paint is undisturbed).
      if (process.env.NETCATTY_PREWARM_SETTINGS === "1") {
        setTimeout(() => {
          getWindowManager().prewarmSettingsWindow(electronModule, {
            preload,
            devServerUrl: effectiveDevServerUrl,
            isDev,
            appIcon: appIconManager.getAppIconPath(appPath),
            isMac,
            electronDir,
          });
        }, 15000);
      }
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
        if (handleActivateWithMainWindow({
          app,
          mainWindow: mainWin,
          globalShortcutBridge: getGlobalShortcutBridge(),
          windowManager: getWindowManager(),
          reopenWindows: getAppLockReopenWindows(),
        })) {
          return;
        }
      } catch {}

      if (focusMainWindow()) return;
      // Main window doesn't exist — create it even if other windows (e.g. settings) are open
      void createAndShowMainWindow().catch((err) => {
        console.error("[Main] Failed to create window on activate:", err);
        showStartupError(err);
        if (!hasUsableWindow()) {
          try { app.quit(); } catch {}
        }
      });
    });

    app.on("hide", () => {
      handleAppHide(appLockController);
    });
  });

  // Cleanup on all windows closed. On macOS the process stays alive for Dock
  // reactivation — re-apply App Lock so a later reopen does not inherit an
  // unlocked runtime from the previous session in this process.
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
      return;
    }
    ensureAppLockForFreshSession(appLockController, "startup");
  });

  // Quit guard state:
  // - quitConfirmed: once true, before-quit falls through without re-checking.
  //   Set right before we call app.quit() after a successful dirty-editor check,
  //   so the re-entered before-quit doesn't loop back into another check.
  // - quitGuardChannelBusy: prevents a second check from being started while the
  //   first round-trip is still in flight.
  // Note: both are intentionally NOT reset on the dirty=true path — if the user
  // cancels quit to save, a subsequent Cmd+Q re-enters with quitConfirmed=false
  // and quitGuardChannelBusy=false (reset in the once/timeout handlers), which
  // kicks off a fresh check as expected.
  let quitGuardChannelBusy = false;
  let quitConfirmed = false;

  // 5s timeout: long enough for the renderer to show a toast before reporting
  // back, short enough that a hung renderer doesn't strand the app forever.
  const QUIT_GUARD_TIMEOUT_MS = 5000;

  // Commit the window manager to "we're quitting" state. Must only run once
  // we've decided to actually proceed — if we set it unconditionally on every
  // before-quit, a dirty-cancelled quit leaves isQuitting=true and changes
  // later window-close behavior (e.g. close-to-tray hooks that gate on
  // !isQuitting would stop firing).
  const commitQuit = () => {
    try {
      appLockController?.setLocked?.("background");
    } catch {
      // ignore
    }
    getWindowManager().setIsQuitting(true);
    quitGuardChannelBusy = true;
    void runPluginShutdown()
      .then(({ timedOut }) => {
        if (timedOut) console.warn("[Plugins] Shutdown deadline elapsed; continuing app quit");
      })
      .catch((error) => {
        console.warn("[Plugins] Shutdown failed; continuing app quit:", error);
      })
      .finally(() => {
        quitGuardChannelBusy = false;
        quitConfirmed = true;
        app.quit();
      });
  };

  app.on("before-quit", (event) => {
    const { ipcMain: _ipcMain } = electronModule;
    // Target app-content windows explicitly. Falling back to
    // BrowserWindow.getAllWindows() could pick tray/settings windows whose
    // renderers don't listen for app:query-dirty-editors and would force the
    // timeout fallback on every quit.
    const dirtyEditorWindows = typeof getWindowManager().getDirtyEditorWindows === "function"
      ? getWindowManager().getDirtyEditorWindows()
      : null;
    const mainWindows = Array.isArray(dirtyEditorWindows)
      ? dirtyEditorWindows
      : typeof getWindowManager().getMainWindows === "function"
        ? getWindowManager().getMainWindows()
        : [getWindowManager().getMainWindow()].filter(Boolean);

    void handleBeforeQuit({
      event,
      mainWindows,
      queryDirtyEditors,
      appLockController,
      windowManager: getWindowManager(),
      app,
      ipcMain: _ipcMain,
      quitConfirmed,
      quitGuardChannelBusy,
      timeoutMs: QUIT_GUARD_TIMEOUT_MS,
      setQuitGuardChannelBusy(value) {
        quitGuardChannelBusy = value;
      },
      setQuitConfirmed(value) {
        quitConfirmed = value;
      },
      // Plugin shutdown is asynchronous, so commit paths must cancel the
      // original quit and re-enter app.quit() through commitQuit.
      commitQuit,
      // Cancel a pending update install when the user aborts quit to save
      // dirty editors (#1215 review) — the install bridge owns its in-flight
      // state, so clear it alongside the window-manager flag.
      cancelPendingUpdateInstall: () => getAutoUpdateBridge().cancelPendingInstall?.(),
    }).catch((err) => {
      console.warn("[Main] dirty-editor quit guard failed:", err);
      quitGuardChannelBusy = false;
      commitQuit();
    });
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
      // End parked SSH transports that outlived their last tab/tunnel lease.
      const { discardAllTransports } = require("./bridges/sshConnectionPool.cjs");
      discardAllTransports("app-quit");
    } catch (err) {
      console.warn("Error during SSH transport cleanup:", err);
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
