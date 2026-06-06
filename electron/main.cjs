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

const { app, BrowserWindow, Menu, protocol, shell, clipboard, session } = electronModule || {};
if (!app || !BrowserWindow) {
  throw new Error("Failed to load Electron runtime. Ensure the app is launched with the Electron binary.");
}

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { getCliDiscoveryFilePath } = require("./cli/discoveryPath.cjs");

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
const getWindowManager = createLazyModule("./bridges/windowManager.cjs");
const getVaultBackupBridge = createLazyModule("./bridges/vaultBackupBridge.cjs");
const ptyProcessTree = require("./bridges/ptyProcessTree.cjs");
const { queryDirtyEditors } = require("./bridges/dirtyEditorGuard.cjs");

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
    const mainWin = getWindowManager().getMainWindow?.();
    const win = mainWin && !mainWin.isDestroyed?.() ? mainWin : null;
    if (!win) return false;

    // Check if the webContents has crashed or been destroyed
    try {
      if (win.webContents?.isCrashed?.()) {
        console.warn('[Main] Main window webContents has crashed, destroying window');
        win.destroy();
        return false;
      }
    } catch {}

    // Cancel any in-flight close-to-tray hide so second-instance / dock-click
    // re-entry beats a pending leave-full-screen → hide sequence.
    try {
      getGlobalShortcutBridge().clearPendingFullscreenHide?.(win);
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
  appIcon,
  isMac,
  electronDir,
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
  getWindowManager,
  getVaultBackupBridge,
  isPathInside,
});
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
  app.on("second-instance", () => {
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
  app.whenReady().then(() => {
    registerAppProtocol();

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
      const menu = getWindowManager().buildAppMenu(Menu, app, isMac);
      Menu.setApplicationMenu(menu);
    } catch (err) {
      console.error("[Main] Failed to build application menu:", err);
      try {
        Menu.setApplicationMenu(null);
      } catch {}
    }

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
    void createAndShowMainWindow().then(() => {
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
          // If a close-to-tray hide is still pending (fullscreen exit animation
          // not finished yet), cancel it — user intent to bring the window
          // back overrides the pending hide.
          try {
            getGlobalShortcutBridge().clearPendingFullscreenHide?.(mainWin);
          } catch {}
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
      // Main window doesn't exist — create it even if other windows (e.g. settings) are open
      void createAndShowMainWindow().catch((err) => {
        console.error("[Main] Failed to create window on activate:", err);
        showStartupError(err);
        if (!hasUsableWindow()) {
          try { app.quit(); } catch {}
        }
      });
    });
  });

  // Cleanup on all windows closed
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
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
    getWindowManager().setIsQuitting(true);
    quitConfirmed = true;
    app.quit();
  };

  app.on("before-quit", (event) => {
    // Fast path: we've already confirmed the quit once (commitQuit ran) and
    // app.quit() re-fired before-quit. Let it through.
    if (quitConfirmed) return;

    // NOTE: an update install (quitAndInstall) intentionally still runs the
    // dirty-editor check below. setQuittingForUpdate(true) only bypasses
    // close-to-tray (so the window actually closes and Squirrel.Mac's ShipIt
    // can swap the bundle); it must NOT skip the unsaved-work guard, or
    // clicking "Restart Now" with a dirty SFTP editor would silently lose
    // edits (#1215 review). If the user cancels to save, the quit is aborted
    // and autoUpdateBridge's watchdog clears the quitting-for-update flags.

    // A check is already in flight — swallow this event; the in-flight handler
    // will issue commitQuit() when it completes if appropriate.
    if (quitGuardChannelBusy) {
      event.preventDefault();
      return;
    }

    const { ipcMain: _ipcMain } = electronModule;
    // Target all visible/recoverable main windows explicitly. Falling back to
    // BrowserWindow.getAllWindows() could pick tray/settings windows whose
    // renderers don't listen for app:query-dirty-editors and would force the
    // timeout fallback on every quit.
    const mainWindows = typeof getWindowManager().getMainWindows === "function"
      ? getWindowManager().getMainWindows()
      : [getWindowManager().getMainWindow()].filter(Boolean);

    // No reachable main window (tray-panel "Quit" path) — there's no visible
    // UI to surface a "save first" toast on, so skip the round-trip and quit
    // directly. A minimized window is still reachable via taskbar/Dock.
    const reachableMainWindows = mainWindows.filter((candidate) => (
      candidate && !candidate.isDestroyed?.() &&
      (candidate.isVisible?.() || candidate.isMinimized?.())
    ));
    if (reachableMainWindows.length === 0) {
      commitQuit();
      return;
    }

    // The renderer needs to be alive for the IPC roundtrip to make sense.
    // Crashed/dead renderers are skipped; there is no usable UI to warn from.
    const queryableWebContents = reachableMainWindows
      .map((candidate) => candidate.webContents)
      .filter((wc) => wc && !wc.isDestroyed?.() && !wc.isCrashed?.());
    if (queryableWebContents.length === 0) {
      commitQuit();
      return;
    }

    quitGuardChannelBusy = true;
    event.preventDefault();

    // Ask the renderer whether any editor tab has unsaved changes. The same
    // round-trip is used by the auto-update install handler (#1215); both go
    // through queryDirtyEditors so the request/reply/timeout handling stays in
    // one place. It fails open (resolves false) on timeout / dead renderer, so
    // a hung renderer can never strand the quit.
    Promise.all(
      queryableWebContents.map((wc) => queryDirtyEditors(wc, QUIT_GUARD_TIMEOUT_MS, { ipcMain: _ipcMain })),
    )
      .then((dirtyResults) => {
        quitGuardChannelBusy = false;
        const hasDirty = dirtyResults.some(Boolean);
        if (!hasDirty) {
          commitQuit();
          return;
        }
        // hasDirty: the renderer showed a toast for dirty editors and the user
        // is saving instead of quitting.
        //
        // A normal quit never sets isQuitting before commitQuit, so there is
        // nothing to undo. But an update install (quitAndInstall) calls
        // setQuittingForUpdate(true) — which also flips isQuitting=true to
        // bypass close-to-tray — BEFORE this dirty check runs. If the user
        // cancels to save, clear it NOW instead of waiting up to 10s for
        // autoUpdateBridge's watchdog; otherwise close-to-tray and other
        // !isQuitting-gated behavior stay bypassed while the app keeps running
        // (#1215 review).
        const wm = getWindowManager();
        if (wm.isQuittingForUpdate?.()) wm.setQuittingForUpdate(false);
      })
      .catch((err) => {
        // queryDirtyEditors is written to never reject, but guard anyway: a
        // throw here would leave quitGuardChannelBusy=true and wedge the app
        // un-quittable. Fail open and let the quit through.
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
