/**
 * Window Manager - Handles Electron window creation and management
 * Extracted from main.cjs for single responsibility
 */

const path = require("node:path");
const fs = require("node:fs");

const { safeSend } = require("./ipcUtils.cjs");

const V8_CACHE_OPTIONS = "bypassHeatCheck";

function getGlobalShortcutBridge() {
  return require("./globalShortcutBridge.cjs");
}

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

// State
let mainWindow = null;
const mainWindows = new Set();
const appContentWindows = new Set();
let lastFocusedMainWindow = null;
let settingsWindow = null;
let currentTheme = "light";
let currentLanguage = "en";
let currentWindowOpacity = 1;
let cachedNativeTheme = null;

let handlersRegistered = false; // Prevent duplicate IPC handler registration
let menuDeps = null;
let electronApp = null; // Reference to Electron app for userData path
let isQuitting = false;
// Set right before electron-updater's quitAndInstall() drives app.quit() for a
// macOS/Windows in-place update. The install only succeeds if the app process
// exits cleanly: Squirrel.Mac's ShipIt helper waits on the parent PID to die
// before swapping the bundle. Two normal-quit behaviors would otherwise keep
// the process alive and strand the installer (see #1215):
//   1. close-to-tray hides the window instead of closing it, and
//   2. the before-quit dirty-editor guard preventDefault()s the quit for a
//      5s renderer round-trip.
// This flag lets both paths recognize an update install and let the quit
// through immediately.
let quittingForUpdate = false;
const rendererReadyCallbacksByWebContentsId = new Map();
const rendererReadySeenByWebContentsId = new Set();
const rendererReadyWaitersByWebContentsId = new Map();
const unhealthyWebContentsIds = new Set();
const DEBUG_WINDOWS = process.env.NETCATTY_DEBUG_WINDOWS === "1";
const OAUTH_DEFAULT_WIDTH = 600;
const OAUTH_DEFAULT_HEIGHT = 700;
const OAUTH_OVERLAY_ID = "__netcatty_oauth_loading__";
const WINDOW_COMMAND_CLOSE_CHANNEL = "netcatty:window:command-close";
// The OAuth callback port is chosen dynamically by oauthBridge (prefers
// 45678, falls back to an OS-assigned free port if that is in use, #823),
// so the in-app popup allow-list has to consult the bridge at popup-open
// time instead of a hardcoded constant.
const oauthBridge = require("./oauthBridge.cjs");
const WINDOW_STATE_FILE = "window-state.json";
const DEFAULT_WINDOW_WIDTH = 1400;
const DEFAULT_WINDOW_HEIGHT = 900;
// Minimum window size: enough to render the expanded sidebar + a usable
// host list + the 420px host details / new-host aside panel without overflow.
const MIN_WINDOW_WIDTH = 1100;
const MIN_WINDOW_HEIGHT = 640;

function debugLog(...args) {
  if (!DEBUG_WINDOWS) return;
  try {
    // eslint-disable-next-line no-console
    console.log("[WindowManager]", ...args);
  } catch {
    // ignore
  }
}

function setIsQuitting(nextValue) {
  isQuitting = Boolean(nextValue);
}

function shouldCloseWindowFromInput(input) {
  return Boolean(
    input?.type === "keyDown" &&
    input?.meta &&
    !input?.control &&
    !input?.alt &&
    !input?.shift &&
    String(input?.key || "").toLowerCase() === "w",
  );
}

/**
 * Read the generic "app is quitting" flag. Window close handlers gate
 * close-to-tray / settings-window hiding on this; exposed so the update-quit
 * rollback can be verified.
 */
function getIsQuitting() {
  return isQuitting;
}

/**
 * Mark that the app is quitting to install a downloaded update. Mirrors the
 * generic isQuitting flag so the main-window close handler bypasses
 * close-to-tray. Call this right before electron-updater's quitAndInstall().
 *
 * Passing false rolls BOTH flags back — used when a quitAndInstall never
 * actually quits the app (throw / Squirrel follow-up error / stale download).
 * Without resetting isQuitting too, close-to-tray and settings-window hiding
 * would stay disabled for the rest of the session (#1215 review).
 */
function setQuittingForUpdate(nextValue) {
  quittingForUpdate = Boolean(nextValue);
  isQuitting = quittingForUpdate;
}

/**
 * True when quitAndInstall() initiated the current quit. The before-quit guard
 * still performs the dirty-editor round-trip; if the user cancels to save, it
 * uses this state to roll back the update quit flags.
 */
function isQuittingForUpdate() {
  return quittingForUpdate;
}

/**
 * Get the path to the window state file
 */
function getWindowStatePath() {
  try {
    if (!electronApp) return null;
    return path.join(electronApp.getPath("userData"), WINDOW_STATE_FILE);
  } catch {
    return null;
  }
}

/**
 * Load saved window state from disk
 */
function loadWindowState() {
  try {
    const statePath = getWindowStatePath();
    if (!statePath || !fs.existsSync(statePath)) {
      return null;
    }
    const data = fs.readFileSync(statePath, "utf8");
    const state = JSON.parse(data);
    // Validate the loaded state has required properties
    if (
      typeof state.width === "number" &&
      typeof state.height === "number" &&
      state.width > 0 &&
      state.height > 0
    ) {
      return state;
    }
    return null;
  } catch (err) {
    debugLog("Failed to load window state:", err?.message || err);
    return null;
  }
}

/**
 * Save window state to disk (synchronous)
 */
function saveWindowStateSync(state) {
  try {
    const statePath = getWindowStatePath();
    if (!statePath) return false;
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
    return true;
  } catch (err) {
    debugLog("Failed to save window state:", err?.message || err);
    return false;
  }
}

/**
 * Save window state to disk (asynchronous)
 */
async function saveWindowState(state) {
  try {
    const statePath = getWindowStatePath();
    if (!statePath) return false;
    await fs.promises.writeFile(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
    return true;
  } catch (err) {
    debugLog("Failed to save window state:", err?.message || err);
    return false;
  }
}

let pendingWindowStateWrite = null;
let queuedWindowState = null;
let windowStateCloseRequested = false;

async function queueWindowStateSave(state) {
  if (!state) return false;
  if (windowStateCloseRequested) {
    return pendingWindowStateWrite || false;
  }
  queuedWindowState = state;
  if (pendingWindowStateWrite) {
    return pendingWindowStateWrite;
  }
  pendingWindowStateWrite = (async () => {
    let lastResult = true;
    while (queuedWindowState) {
      const nextState = queuedWindowState;
      queuedWindowState = null;
      lastResult = await saveWindowState(nextState);
    }
    pendingWindowStateWrite = null;
    return lastResult;
  })();
  return pendingWindowStateWrite;
}

/**
 * Get the current window bounds state for saving
 * @param {BrowserWindow} win - The window to get bounds from
 * @param {Object} overrideBounds - Optional bounds to use instead of current window bounds (for normal bounds tracking)
 */
function getWindowBoundsState(win, overrideBounds) {
  if (!win || win.isDestroyed()) return null;
  const bounds = overrideBounds || win.getBounds();
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    isMaximized: win.isMaximized(),
    isFullScreen: win.isFullScreen(),
  };
}

const MENU_LABELS = {
  en: { edit: "Edit", view: "View", window: "Window", reload: "Reload", closeWindow: "Close Window" },
  "zh-CN": { edit: "编辑", view: "视图", window: "窗口", reload: "重新加载", closeWindow: "关闭窗口" },
  "zh-TW": { edit: "編輯", view: "檢視", window: "視窗", reload: "重新載入", closeWindow: "關閉視窗" },
};

function tMenu(language, key) {
  if (!language) return MENU_LABELS.en[key] ?? key;
  const direct = MENU_LABELS?.[language]?.[key];
  if (direct) return direct;
  const base = String(language).split("-")[0];
  const baseMatchKey = Object.keys(MENU_LABELS).find((k) => k === base || k.startsWith(`${base}-`));
  const baseMatch = baseMatchKey ? MENU_LABELS[baseMatchKey]?.[key] : undefined;
  return baseMatch ?? MENU_LABELS.en[key] ?? key;
}

function rebuildApplicationMenu() {
  if (!menuDeps?.Menu || !menuDeps?.app) return;
  const menu = buildAppMenu(menuDeps.Menu, menuDeps.app, menuDeps.isMac, currentLanguage);
  menuDeps.Menu.setApplicationMenu(menu);
}

function getWindowForIpcEvent(event) {
  try {
    const wc = event?.sender;
    const win = wc?.getOwnerBrowserWindow?.();
    if (win && !win.isDestroyed()) return win;
  } catch {
    // ignore
  }
  return getMainWindow();
}

function pruneMainWindows() {
  for (const win of Array.from(mainWindows)) {
    if (!win || win.isDestroyed?.()) {
      mainWindows.delete(win);
      if (lastFocusedMainWindow === win) lastFocusedMainWindow = null;
      if (mainWindow === win) mainWindow = null;
    }
  }
}

function pruneAppContentWindows() {
  for (const win of Array.from(appContentWindows)) {
    if (!win || win.isDestroyed?.()) {
      appContentWindows.delete(win);
    }
  }
}

function getMainWindowList() {
  pruneMainWindows();
  return Array.from(mainWindows).filter((win) => isWindowUsable(win));
}

function getAppContentWindowList() {
  pruneAppContentWindows();
  return Array.from(appContentWindows).filter((win) => isWindowUsable(win));
}

function rememberMainWindow(win) {
  if (!win || win.isDestroyed?.()) return;
  lastFocusedMainWindow = win;
  mainWindow = win;
}

function registerAppContentWindow(win) {
  if (!win || win.isDestroyed?.()) return;
  appContentWindows.add(win);
}

function unregisterAppContentWindow(win) {
  if (!win) return;
  appContentWindows.delete(win);
}

function registerMainWindow(win) {
  if (!win || win.isDestroyed?.()) return;
  registerAppContentWindow(win);
  mainWindows.add(win);
  rememberMainWindow(win);
  try {
    win.on("focus", () => rememberMainWindow(win));
  } catch {
    // ignore
  }
}

function unregisterMainWindow(win) {
  if (!win) return;
  mainWindows.delete(win);
  unregisterAppContentWindow(win);
  if (lastFocusedMainWindow === win) lastFocusedMainWindow = null;
  if (mainWindow === win) mainWindow = null;
  const fallback = getMainWindowList().at(-1) || null;
  if (fallback) rememberMainWindow(fallback);
}

function forEachMainWindow(callback) {
  for (const win of getMainWindowList()) {
    try {
      callback(win);
    } catch {
      // ignore per-window broadcast failures
    }
  }
}

function clampWindowOpacity(opacity) {
  const value = Number(opacity);
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0.5, value));
}

function applyWindowOpacityToWindow(win) {
  if (!win || win.isDestroyed?.()) return;
  try {
    win.setOpacity?.(currentWindowOpacity);
  } catch {
    // ignore
  }
}

function applyWindowOpacity(opacity) {
  currentWindowOpacity = clampWindowOpacity(opacity);
  forEachMainWindow(applyWindowOpacityToWindow);
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    applyWindowOpacityToWindow(settingsWindow);
  }
  return currentWindowOpacity;
}

function getMainWindowCount() {
  return getMainWindowList().length;
}

function isMainWindow(win) {
  if (!win || win.isDestroyed?.()) return false;
  pruneMainWindows();
  return mainWindows.has(win);
}

function closeBrowserWindow(win) {
  if (!win || win.isDestroyed?.()) return false;
  try {
    win.close();
    return true;
  } catch {
    return false;
  }
}

function requestWindowCommandClose(win) {
  if (!win || win.isDestroyed?.()) return false;
  try {
    const webContents = win.webContents;
    if (!webContents || webContents.isDestroyed?.()) return closeBrowserWindow(win);
    webContents.send(WINDOW_COMMAND_CLOSE_CHANNEL);
    return true;
  } catch {
    return closeBrowserWindow(win);
  }
}

function broadcastLanguageChanged() {
  try {
    forEachMainWindow((win) => win.webContents?.send?.("netcatty:languageChanged", currentLanguage));
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents?.send?.("netcatty:languageChanged", currentLanguage);
    }
  } catch {
    // ignore
  }
}

/**
 * Normalize dev server URL for local access compatibility
 */
function normalizeDevServerUrl(urlString) {
  if (!urlString) return urlString;
  try {
    const u = new URL(urlString);
    const host = u.hostname;
    // Vite often binds to 0.0.0.0; Chromium can't navigate to it. Prefer localhost.
    if (
      host === "0.0.0.0" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "[::1]" ||
      host === "[::]" ||
      host === "::"
    ) {
      u.hostname = "localhost";
      return u.toString();
    }
    return urlString;
  } catch {
    return urlString;
  }
}

function getDevRendererBaseUrl(devServerUrl) {
  const normalized = normalizeDevServerUrl(devServerUrl);
  const fallback = typeof normalized === "string" ? normalized.replace(/\/+$/, "") : "";

  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const currentUrl = mainWindow.webContents?.getURL?.();
      if (currentUrl) {
        const origin = new URL(currentUrl).origin;
        if (origin && origin !== "null") return origin;
      }
    }
  } catch {
    // ignore
  }

  return fallback;
}

const {
  normalizeBackgroundColor,
  resolveFrontendBackgroundColor,
} = require("./windowManager/backgroundColor.cjs");
function parseWindowOpenFeatures(features) {
  if (!features) return {};
  const parts = String(features)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  const values = {};
  parts.forEach((part) => {
    const [key, value] = part.split("=").map((entry) => entry.trim());
    if (!key || !value) return;
    const numeric = Number.parseInt(value, 10);
    if (Number.isFinite(numeric)) values[key.toLowerCase()] = numeric;
  });

  const width = values.width;
  const height = values.height;
  return {
    width: Number.isFinite(width) ? Math.max(360, Math.min(width, 1400)) : null,
    height: Number.isFinite(height) ? Math.max(480, Math.min(height, 1200)) : null,
  };
}

/**
 * Track open fallback browser windows so they are garbage-collected when the
 * BrowserWindow is destroyed.
 */
const { createExternalWindowApi } = require("./windowManager/externalWindows.cjs");
const externalWindowApi = createExternalWindowApi({
  get mainWindow() { return mainWindow; },
  get currentTheme() { return currentTheme; },
  THEME_COLORS,
  OAUTH_DEFAULT_WIDTH,
  OAUTH_DEFAULT_HEIGHT,
  V8_CACHE_OPTIONS,
  require,
  console,
  URL,
  parseWindowOpenFeatures,
  oauthBridge,
});
const {
  openFallbackBrowser,
  tryOpenExternalWithFallback,
  createExternalOnlyWindowOpenHandler,
  createAppWindowOpenHandler,
} = externalWindowApi;

function attachOAuthLoadingOverlay(win) {
  if (!win || win.isDestroyed?.()) return;

  const overlayStyle = `
    #${OAUTH_OVERLAY_ID} {
      position: fixed;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      background:
        radial-gradient(900px circle at 15% 0%, rgba(14, 165, 233, 0.12), transparent 38%),
        radial-gradient(1200px circle at 85% 10%, rgba(56, 189, 248, 0.14), transparent 40%),
        #f7f9fc;
      color: #1e293b;
      font-family: "Space Grotesk", system-ui, -apple-system, "Segoe UI", sans-serif;
      z-index: 999999;
    }
    #${OAUTH_OVERLAY_ID}.dark {
      background:
        radial-gradient(900px circle at 15% 0%, rgba(14, 165, 233, 0.16), transparent 38%),
        radial-gradient(1200px circle at 85% 10%, rgba(56, 189, 248, 0.18), transparent 40%),
        #0b1220;
      color: #e2e8f0;
    }
    #${OAUTH_OVERLAY_ID} .spinner {
      width: 28px;
      height: 28px;
      border-radius: 999px;
      border: 3px solid rgba(148, 163, 184, 0.35);
      border-top-color: currentColor;
      animation: netcatty-oauth-spin 0.8s linear infinite;
    }
    #${OAUTH_OVERLAY_ID} .label {
      font-size: 14px;
      letter-spacing: 0.04em;
    }
    @keyframes netcatty-oauth-spin {
      to { transform: rotate(360deg); }
    }
  `;

  const injectOverlayScript = `
    (() => {
      if (document.getElementById("${OAUTH_OVERLAY_ID}")) return;
      const root = document.documentElement || document.body;
      const style = document.createElement("style");
      style.textContent = ${JSON.stringify(overlayStyle)};
      style.setAttribute("data-netcatty-oauth", "style");
      (document.head || root).appendChild(style);

      const overlay = document.createElement("div");
      overlay.id = "${OAUTH_OVERLAY_ID}";
      if (root.classList.contains("dark")) overlay.classList.add("dark");
      overlay.innerHTML = '<div class="spinner"></div><div class="label">Loading...</div>';
      (document.body || root).appendChild(overlay);
    })();
  `;

  const removeOverlayScript = `
    (() => {
      const overlay = document.getElementById("${OAUTH_OVERLAY_ID}");
      if (overlay) overlay.remove();
      const style = document.querySelector('style[data-netcatty-oauth="style"]');
      if (style) style.remove();
    })();
  `;

  win.webContents.on("did-start-loading", () => {
    win.webContents.executeJavaScript(injectOverlayScript, true).catch(() => { });
  });

  win.webContents.on("did-stop-loading", () => {
    win.webContents.executeJavaScript(removeOverlayScript, true).catch(() => { });
  });

  win.webContents.on("did-fail-load", () => {
    win.webContents.executeJavaScript(removeOverlayScript, true).catch(() => { });
  });
}

function setupDeferredShow(win, { timeoutMs = 3000, waitForRendererReady = true } = {}) {
  const webContentsId = (() => {
    try {
      return win?.webContents?.id;
    } catch {
      return null;
    }
  })();

  let shown = false;
  let readyToShow = false;
  let rendererReady = false;
  let timer = null;

  const showOnce = () => {
    if (shown) return;
    shown = true;
    if (timer) clearTimeout(timer);
    timer = null;
    if (webContentsId) rendererReadyCallbacksByWebContentsId.delete(webContentsId);
    try {
      if (!win.isDestroyed()) win.show();
    } catch {
      // ignore
    }
  };

  const tryShow = () => {
    if (shown) return;
    if (!readyToShow) return;
    if (waitForRendererReady && !rendererReady) return;
    showOnce();
  };

  const markRendererReady = () => {
    if (rendererReady) return;
    rendererReady = true;
    tryShow();
  };

  if (webContentsId) rendererReadyCallbacksByWebContentsId.set(webContentsId, markRendererReady);

  win.once("ready-to-show", () => {
    readyToShow = true;
    tryShow();
  });

  // Renderer calls netcattyBridge.rendererReady() after React mount,
  // which sends IPC "netcatty:renderer:ready" → markRendererReady().
  // The timeout fallback (timeoutMs) ensures the window is shown even if
  // the signal is never received.

  // Dev/edge-case fallback: don't keep the window hidden forever.
  if (Number(timeoutMs) > 0) {
    timer = setTimeout(showOnce, timeoutMs);
  }
  win.on("closed", () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (webContentsId) rendererReadyCallbacksByWebContentsId.delete(webContentsId);
  });

  return { showOnce, markRendererReady };
}

function resolveRendererReady(wcId) {
  if (!wcId) return;
  unhealthyWebContentsIds.delete(wcId);
  rendererReadySeenByWebContentsId.add(wcId);
  const cb = rendererReadyCallbacksByWebContentsId.get(wcId);
  if (cb) cb();
  const waiters = rendererReadyWaitersByWebContentsId.get(wcId);
  if (!waiters || waiters.size === 0) return;
  rendererReadyWaitersByWebContentsId.delete(wcId);
  for (const resolve of waiters) {
    try {
      resolve();
    } catch {
      // ignore waiter errors
    }
  }
}

function clearRendererReadyForWebContents(wcId) {
  if (!wcId) return;
  rendererReadySeenByWebContentsId.delete(wcId);
}

function isWindowUsable(win, options = {}) {
  const requireVisible = options.requireVisible === true;
  if (!win || typeof win.isDestroyed !== "function" || win.isDestroyed()) {
    return false;
  }
  if (requireVisible) {
    if (typeof win.isVisible !== "function") return false;
    try {
      if (!win.isVisible()) return false;
    } catch {
      return false;
    }
  }
  const contents = win.webContents;
  if (!contents || typeof contents.isDestroyed !== "function" || contents.isDestroyed()) {
    return false;
  }
  const wcId = (() => {
    try {
      return contents.id;
    } catch {
      return null;
    }
  })();
  if (wcId && unhealthyWebContentsIds.has(wcId)) {
    return false;
  }
  if (typeof contents.isCrashed === "function") {
    try {
      if (contents.isCrashed()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function waitForRendererReady(win, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const wcId = (() => {
      try {
        return win?.webContents?.id;
      } catch {
        return null;
      }
    })();

    if (!win || win.isDestroyed?.() || !wcId) {
      reject(new Error("Main window is unavailable before renderer ready."));
      return;
    }

    if (rendererReadySeenByWebContentsId.has(wcId)) {
      resolve();
      return;
    }

    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      try { win.removeListener("closed", handleClosed); } catch {}
      try { win.webContents?.removeListener?.("render-process-gone", handleGone); } catch {}
      const waiters = rendererReadyWaitersByWebContentsId.get(wcId);
      if (waiters) {
        waiters.delete(handleReady);
        if (waiters.size === 0) {
          rendererReadyWaitersByWebContentsId.delete(wcId);
        }
      }
    };

    const handleReady = () => {
      cleanup();
      resolve();
    };
    const handleClosed = () => {
      cleanup();
      reject(new Error("Main window closed before renderer became ready."));
    };
    const handleGone = (_event, details) => {
      cleanup();
      reject(new Error(`Renderer process exited before ready: ${details?.reason || "unknown"}`));
    };

    let waiters = rendererReadyWaitersByWebContentsId.get(wcId);
    if (!waiters) {
      waiters = new Set();
      rendererReadyWaitersByWebContentsId.set(wcId, waiters);
    }
    waiters.add(handleReady);

    win.once("closed", handleClosed);
    win.webContents?.once?.("render-process-gone", handleGone);

    if (Number(timeoutMs) > 0) {
      timer = setTimeout(() => {
        cleanup();
        reject(new Error("Renderer did not report ready before timeout."));
      }, timeoutMs);
    }
  });
}

/**
 * Wait for a freshly created window's renderer to report ready, then deliver an
 * IPC message to it. The renderer only registers its IPC listeners (and reports
 * ready) after React mounts, and Electron does not queue messages for listeners
 * that do not exist yet. So if readiness times out we must NOT send — the
 * message would be silently dropped, leaving the window blank while the caller
 * still saw "success". Returning a failure here lets the caller surface the
 * existing error path instead.
 */
async function sendWhenRendererReady(win, channel, payload, options = {}) {
  const {
    timeoutMs = 8000,
    waitForReady = waitForRendererReady,
    shouldSend,
    cancelReason = "cancelled",
  } = options;
  try {
    await waitForReady(win, { timeoutMs });
  } catch (err) {
    if (typeof shouldSend === "function" && shouldSend() === false) {
      return { success: false, reason: cancelReason };
    }
    return {
      success: false,
      error: "New window did not become ready in time",
      reason: err?.message || String(err),
    };
  }
  if (win?.isDestroyed?.() || win?.webContents?.isDestroyed?.()) {
    return { success: false, error: "Window closed before message could be delivered" };
  }
  if (typeof shouldSend === "function" && shouldSend() === false) {
    return { success: false, reason: cancelReason };
  }
  win.webContents.send(channel, payload);
  return { success: true };
}

function resolveLiveAppIcon(fallback = null) {
  try {
    const appIconManager = require("./appIconManager.cjs");
    const appPath = electronApp?.getAppPath?.();
    if (appPath) {
      const iconPath = appIconManager.getAppIconPath(appPath);
      if (iconPath) return iconPath;
    }
  } catch {
    // ignore
  }
  return fallback;
}

/**
 * Create the main application window
 */
const { createMainWindowApi } = require("./windowManager/mainWindow.cjs");
const mainWindowApi = createMainWindowApi({
  get mainWindow() { return mainWindow; },
  set mainWindow(value) { mainWindow = value; },
  get electronApp() { return electronApp; },
  set electronApp(value) { electronApp = value; },
  get currentTheme() { return currentTheme; },
  get isQuitting() { return isQuitting; },
  get pendingWindowStateWrite() { return pendingWindowStateWrite; },
  set pendingWindowStateWrite(value) { pendingWindowStateWrite = value; },
  get queuedWindowState() { return queuedWindowState; },
  set queuedWindowState(value) { queuedWindowState = value; },
  get windowStateCloseRequested() { return windowStateCloseRequested; },
  set windowStateCloseRequested(value) { windowStateCloseRequested = value; },
  DEFAULT_WINDOW_WIDTH,
  DEFAULT_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  MIN_WINDOW_HEIGHT,
  V8_CACHE_OPTIONS,
  THEME_COLORS,
  unhealthyWebContentsIds,
  rendererReadySeenByWebContentsId,
  __dirname,
  URL,
  require,
  console,
  setTimeout,
  clearTimeout,
  getGlobalShortcutBridge,
  debugLog,
  resolveFrontendBackgroundColor,
  loadWindowState,
  getDevRendererBaseUrl,
  getWindowBoundsState,
  queueWindowStateSave,
  saveWindowStateSync,
  setupDeferredShow,
  clearRendererReadyForWebContents,
  createExternalOnlyWindowOpenHandler,
  createAppWindowOpenHandler,
  attachOAuthLoadingOverlay,
  queryDirtyEditors: (...args) => require("./dirtyEditorGuard.cjs").queryDirtyEditors(...args),
  registerWindowHandlers,
  requestWindowCommandClose,
  shouldCloseWindowFromInput,
  registerMainWindow,
  unregisterMainWindow,
  registerAppContentWindow,
  unregisterAppContentWindow,
  getMainWindowCount,
  applyWindowOpacityToWindow,
  resolveLiveAppIcon,
  closeSettingsWindow: (...args) => closeSettingsWindow(...args),
  hideSettingsWindow: (...args) => hideSettingsWindow(...args),
});
const { createWindow } = mainWindowApi;

/**
 * Create or focus the settings window
 */
/**
 * Show + reliably focus a window's renderer. Works around two Windows-specific
 * Electron quirks that surface when a prewarmed/hidden window is later shown
 * (see issue #760):
 *
 *   1. SetForegroundWindow restrictions: `BrowserWindow.focus()` invoked from
 *      a non-foreground process is often silently rejected by Windows. The
 *      window appears on top but never receives true OS foreground focus, so
 *      `document.hasFocus()` stays false in the renderer.
 *   2. Chromium suppresses the input caret + keyboard routing whenever
 *      `document.hasFocus()` is false, even if an `<input>` is the active
 *      element. The classic symptom: clicking an input selects/deletes work
 *      but the caret never blinks and typed characters don't appear.
 *
 * The alwaysOnTop toggle is the established workaround for (1); explicitly
 * calling `webContents.focus()` covers (2) so the renderer marks the page as
 * focused regardless of whether the OS granted foreground.
 */
const { createSettingsWindowApi } = require("./windowManager/settingsWindow.cjs");
const settingsWindowApi = createSettingsWindowApi({
  get settingsWindow() { return settingsWindow; },
  set settingsWindow(value) { settingsWindow = value; },
  get mainWindow() { return mainWindow; },
  get currentTheme() { return currentTheme; },
  get isQuitting() { return isQuitting; },
  V8_CACHE_OPTIONS,
  THEME_COLORS,
  __dirname,
  process,
  URL,
  debugLog,
  resolveFrontendBackgroundColor,
  createAppWindowOpenHandler,
  createExternalOnlyWindowOpenHandler,
  resolveLiveAppIcon,
  getDevRendererBaseUrl,
  applyWindowOpacityToWindow,
});
const {
  restoreWindowInputFocus,
  showAndFocusWindow,
  isLiveWindow,
  resolveSettingsWindowBounds,
  centerSettingsWindowOnSourceDisplay,
  openSettingsWindow,
  closeSettingsWindow,
  hideSettingsWindow,
  prewarmSettingsWindow,
} = settingsWindowApi;

const { createTerminalPopupWindowApi } = require("./windowManager/terminalPopupWindow.cjs");
const terminalPopupWindowApi = createTerminalPopupWindowApi({
  get mainWindow() { return mainWindow; },
  get currentTheme() { return currentTheme; },
  V8_CACHE_OPTIONS,
  __dirname,
  resolveFrontendBackgroundColor,
  createExternalOnlyWindowOpenHandler,
  getDevRendererBaseUrl,
  applyWindowOpacityToWindow,
  sendWhenRendererReady,
  showAndFocusWindow,
  resolveSettingsWindowBounds,
});
const { openTerminalPopupWindow, closeTerminalPopupWindow } = terminalPopupWindowApi;

/**
 * Register window control IPC handlers (only once)
 */
function registerWindowHandlers(ipcMain, nativeTheme) {
  // Prevent duplicate registration
  if (handlersRegistered) {
    return;
  }
  handlersRegistered = true;
  cachedNativeTheme = nativeTheme;

  ipcMain.handle("netcatty:window:minimize", (event) => {
    const win = getWindowForIpcEvent(event);
    if (win && !win.isDestroyed()) {
      debugLog("window:minimize", { senderId: event?.sender?.id, windowId: win.webContents?.id });
      win.minimize();
    }
  });

  ipcMain.handle("netcatty:window:maximize", (event) => {
    const win = getWindowForIpcEvent(event);
    if (win && !win.isDestroyed()) {
      debugLog("window:maximize", { senderId: event?.sender?.id, windowId: win.webContents?.id });
      if (win.isMaximized()) {
        win.unmaximize();
        return false;
      } else {
        win.maximize();
        return true;
      }
    }
    return false;
  });

  ipcMain.handle("netcatty:window:close", (event) => {
    const win = getWindowForIpcEvent(event);
    if (win && !win.isDestroyed()) {
      debugLog("window:close", {
        senderId: event?.sender?.id,
        windowId: win.webContents?.id,
        isMain: win === mainWindow,
        isSettings: win === settingsWindow,
      });
      win.close();
    }
  });

  ipcMain.handle("netcatty:window:isMaximized", (event) => {
    const win = getWindowForIpcEvent(event);
    if (win && !win.isDestroyed()) {
      return win.isMaximized();
    }
    return false;
  });

  ipcMain.handle("netcatty:window:isFullscreen", (event) => {
    const win = getWindowForIpcEvent(event);
    if (win && !win.isDestroyed()) {
      return win.isFullScreen();
    }
    return false;
  });

  ipcMain.handle("netcatty:window:focus", (event) => {
    const win = getWindowForIpcEvent(event);
    return restoreWindowInputFocus(win);
  });

  ipcMain.handle("netcatty:window:setTitle", (event, title) => {
    const win = getWindowForIpcEvent(event);
    if (!win || win.isDestroyed()) return false;
    const value = typeof title === "string" ? title.trim() : "";
    try {
      win.setTitle(value || "Netcatty");
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.handle("netcatty:setTheme", (_event, theme) => {
    currentTheme = theme;
    nativeTheme.themeSource = theme;
    const effectiveTheme = theme === "system"
      ? (nativeTheme?.shouldUseDarkColors ? "dark" : "light")
      : theme;
    const themeConfig = THEME_COLORS[effectiveTheme] || THEME_COLORS.light;
    forEachMainWindow((win) => win.setBackgroundColor(themeConfig.background));
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.setBackgroundColor(themeConfig.background);
    }
    return true;
  });

  ipcMain.handle("netcatty:setBackgroundColor", (_event, color) => {
    const normalized = normalizeBackgroundColor(color);
    if (!normalized) return false;
    forEachMainWindow((win) => win.setBackgroundColor(normalized));
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.setBackgroundColor(normalized);
    }
    return true;
  });

  ipcMain.handle("netcatty:setWindowOpacity", (_event, opacity) => {
    applyWindowOpacity(opacity);
    return true;
  });

  ipcMain.handle("netcatty:setAppIconVariant", (_event, variant) => {
    const { app, BrowserWindow, nativeImage } = require("electron");
    const appIconManager = require("./appIconManager.cjs");
    return appIconManager.applyAppIconVariant(variant, {
      app,
      BrowserWindow,
      nativeImage,
      appPath: app.getAppPath(),
      isMac: process.platform === "darwin",
    });
  });

  ipcMain.handle("netcatty:setLanguage", (_event, language) => {
    currentLanguage = typeof language === "string" && language.length ? language : "en";
    rebuildApplicationMenu();
    broadcastLanguageChanged();
    return true;
  });

  // Settings window close handler
  ipcMain.handle("netcatty:settings:close", (event) => {
    // Prefer hiding the tracked settings window (reused on next open).
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      debugLog("settings:close (tracked)", {
        senderId: event?.sender?.id,
        settingsId: settingsWindow.webContents?.id,
      });
      hideSettingsWindow();
      return true;
    }

    // Fallback: close the caller window if it's not the main window.
    const owner = getWindowForIpcEvent(event);
    if (owner && owner !== mainWindow && !owner.isDestroyed()) {
      debugLog("settings:close (owner)", {
        senderId: event?.sender?.id,
        ownerId: owner.webContents?.id,
        isMain: owner === mainWindow,
        isSettings: owner === settingsWindow,
      });
      try {
        owner.close();
      } catch {
        // ignore
      }
    }
    return true;
  });

  // Broadcast settings changed to all windows (for cross-window sync)
  ipcMain.on("netcatty:settings:changed", (event, payload) => {
    const senderId = event?.sender?.id;
    // Notify all windows except the sender
    // Check both isDestroyed() and webContents.isDestroyed() to handle HMR refresh
    try {
      forEachMainWindow((win) => {
        if (!win.webContents.isDestroyed() && win.webContents.id !== senderId) {
          win.webContents.send("netcatty:settings:changed", payload);
        }
      });
      if (settingsWindow && !settingsWindow.isDestroyed() && !settingsWindow.webContents.isDestroyed() && settingsWindow.webContents.id !== senderId) {
        settingsWindow.webContents.send("netcatty:settings:changed", payload);
      }
    } catch {
      // ignore - frame may be disposed during HMR
    }
  });

  // Renderer reports first meaningful paint/mount; used to avoid initial blank screen.
  ipcMain.on("netcatty:renderer:ready", (event) => {
    const wcId = event?.sender?.id;
    if (!wcId) return;
    resolveRendererReady(wcId);
  });
}

/**
 * Build the application menu
 */
function buildAppMenu(Menu, app, isMac, language = currentLanguage) {
  // Save deps so later language changes can rebuild the menu.
  menuDeps = { Menu, app, isMac };
  const closeFocusedWindow = (_menuItem, browserWindow) => {
    // 只有主窗口/设置窗口会接收 command-close；其他 BrowserWindow 直接关闭。
    if (browserWindow && !isMainWindow(browserWindow) && browserWindow !== settingsWindow) {
      closeBrowserWindow(browserWindow);
      return;
    }

    // macOS 的 Cmd+W 先交给渲染层关闭标签页；没有标签页时渲染层再关闭窗口。
    requestWindowCommandClose(browserWindow) || requestWindowCommandClose(getMainWindow());
  };
  const template = [
    ...(isMac
      ? [
        {
          label: app.name,
          submenu: [
            { role: "about" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        },
      ]
      : []),
    {
      label: tMenu(language, "edit"),
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: tMenu(language, "view"),
      submenu: [
        { label: tMenu(language, "reload"), click: (_, win) => { if (win) win.reload(); } },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: tMenu(language, "window"),
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(isMac
          ? [
            { type: "separator" },
            {
              label: tMenu(language, "closeWindow"),
              accelerator: "CommandOrControl+W",
              click: closeFocusedWindow,
            },
            { role: "front" },
          ]
          : [{ role: "close" }]),
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}

/**
 * Get the main window instance
 */
function getMainWindow() {
  const candidates = getMainWindowList();
  if (lastFocusedMainWindow && candidates.includes(lastFocusedMainWindow)) {
    return lastFocusedMainWindow;
  }
  if (mainWindow && candidates.includes(mainWindow)) {
    return mainWindow;
  }
  return candidates.at(-1) || null;
}

/**
 * Get the settings window instance
 */
function getSettingsWindow() {
  return settingsWindow;
}

/**
 * Show the main window and restore reliable keyboard/caret routing (#760, #1722).
 * Global hotkeys and tray entry points invoke this from non-foreground contexts
 * where bare BrowserWindow.focus() is silently rejected on Windows.
 */
function showAndFocusMainWindow(win) {
  if (!win || win.isDestroyed?.()) return false;
  if (win.isMinimized?.()) {
    try {
      win.restore();
    } catch {
      // ignore
    }
  }
  return restoreWindowInputFocus(win, { show: true });
}

/**
 * Tell the renderer to dismiss transient overlays before the native hide (#1722).
 * Must run before BrowserWindow.hide(), not from Electron's post-hide event.
 */
function notifyWindowWillHide(win) {
  if (!win || win.isDestroyed?.()) return;
  safeSend(win.webContents, "netcatty:window:will-hide");
}

module.exports = {
  createWindow,
  openSettingsWindow,
  closeSettingsWindow,
  openTerminalPopupWindow,
  closeTerminalPopupWindow,
  prewarmSettingsWindow,
  buildAppMenu,
  getMainWindow,
  getMainWindows: getMainWindowList,
  getAppContentWindows: getAppContentWindowList,
  getMainWindowCount,
  isMainWindow,
  registerMainWindow,
  unregisterMainWindow,
  registerAppContentWindow,
  unregisterAppContentWindow,
  getSettingsWindow,
  isWindowUsable,
  registerWindowHandlers,
  restoreWindowInputFocus,
  showAndFocusMainWindow,
  notifyWindowWillHide,
  requestWindowCommandClose,
  shouldCloseWindowFromInput,
  WINDOW_COMMAND_CLOSE_CHANNEL,
  waitForRendererReady,
  sendWhenRendererReady,
  setIsQuitting,
  getIsQuitting,
  setQuittingForUpdate,
  isQuittingForUpdate,
  openFallbackBrowser,
  tryOpenExternalWithFallback,
  resolveSettingsWindowBounds,
  THEME_COLORS,
  clampWindowOpacity,
  applyWindowOpacity,
  applyWindowOpacityToWindow,
};
