/**
 * Window Manager - Handles Electron window creation and management
 * Extracted from main.cjs for single responsibility
 */

const path = require("node:path");
const fs = require("node:fs");

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
let settingsWindow = null;
let currentTheme = "light";
let currentLanguage = "en";
let handlersRegistered = false; // Prevent duplicate IPC handler registration
let menuDeps = null;
let electronApp = null; // Reference to Electron app for userData path
let isQuitting = false;
const rendererReadyCallbacksByWebContentsId = new Map();
const DEBUG_WINDOWS = process.env.NETCATTY_DEBUG_WINDOWS === "1";
const OAUTH_DEFAULT_WIDTH = 600;
const OAUTH_DEFAULT_HEIGHT = 700;
const OAUTH_OVERLAY_ID = "__netcatty_oauth_loading__";
const OAUTH_LOOPBACK_PORT = 45678; // must match electron/bridges/oauthBridge.cjs
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
  en: { edit: "Edit", view: "View", window: "Window", reload: "Reload" },
  "zh-CN": { edit: "编辑", view: "视图", window: "窗口", reload: "重新加载" },
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
  return mainWindow;
}

function broadcastLanguageChanged() {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents?.send?.("netcatty:languageChanged", currentLanguage);
    }
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

function hslToHex(h, s, l) {
  const hue = ((h % 360) + 360) % 360;
  const sat = Math.max(0, Math.min(100, s)) / 100;
  const light = Math.max(0, Math.min(100, l)) / 100;

  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = light - c / 2;

  let r1 = 0;
  let g1 = 0;
  let b1 = 0;

  if (hue < 60) {
    r1 = c; g1 = x; b1 = 0;
  } else if (hue < 120) {
    r1 = x; g1 = c; b1 = 0;
  } else if (hue < 180) {
    r1 = 0; g1 = c; b1 = x;
  } else if (hue < 240) {
    r1 = 0; g1 = x; b1 = c;
  } else if (hue < 300) {
    r1 = x; g1 = 0; b1 = c;
  } else {
    r1 = c; g1 = 0; b1 = x;
  }

  const toHex = (n) => Math.round((n + m) * 255).toString(16).padStart(2, "0");
  return `#${toHex(r1)}${toHex(g1)}${toHex(b1)}`;
}

function normalizeBackgroundColor(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (raw.startsWith("#")) return raw;

  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length < 3) return null;
  const h = Number(parts[0]);
  const s = Number(String(parts[1]).replace("%", ""));
  const l = Number(String(parts[2]).replace("%", ""));
  if (!Number.isFinite(h) || !Number.isFinite(s) || !Number.isFinite(l)) return null;
  return hslToHex(h, s, l);
}

function parseBackgroundFromIndexHtml(indexHtml, theme) {
  if (!indexHtml) return null;

  const block =
    theme === "dark"
      ? indexHtml.match(/\.dark\s*\{[\s\S]*?\}/)
      : indexHtml.match(/:root\s*\{[\s\S]*?\}/);

  const within = block?.[0] || indexHtml;
  const m = within.match(/--background:\s*([^;]+);/);
  const raw = m?.[1]?.trim();
  if (!raw) return null;

  const parts = raw.split(/\s+/).filter(Boolean);
  if (parts.length < 3) return null;

  const h = Number(parts[0]);
  const s = Number(String(parts[1]).replace("%", ""));
  const l = Number(String(parts[2]).replace("%", ""));

  if (!Number.isFinite(h) || !Number.isFinite(s) || !Number.isFinite(l)) return null;
  return hslToHex(h, s, l);
}

function resolveIndexHtmlPath(electronDir) {
  const dist = path.join(electronDir, "../dist/index.html");
  const root = path.join(electronDir, "../index.html");
  if (fs.existsSync(dist)) return dist;
  if (fs.existsSync(root)) return root;
  return dist;
}

function resolveFrontendBackgroundColor(electronDir, theme) {
  try {
    const htmlPath = resolveIndexHtmlPath(electronDir);
    if (!htmlPath || !fs.existsSync(htmlPath)) return null;
    const indexHtml = fs.readFileSync(htmlPath, "utf8");
    return parseBackgroundFromIndexHtml(indexHtml, theme);
  } catch {
    return null;
  }
}

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

function createExternalOnlyWindowOpenHandler(shell) {
  return (details) => {
    const targetUrl = details?.url;
    if (targetUrl && typeof targetUrl === "string" && /^https?:/i.test(targetUrl)) {
      try {
        void shell?.openExternal?.(targetUrl);
      } catch {
        // ignore
      }
    }
    return { action: "deny" };
  };
}

function createAppWindowOpenHandler(shell, { backgroundColor, appIcon }) {
  const allowedPopupHosts = new Set([
    // OAuth (PKCE loopback)
    "accounts.google.com",
    "login.microsoftonline.com",
    "login.live.com",
  ]);

  const isAllowedInAppPopupUrl = (rawUrl) => {
    try {
      const u = new URL(String(rawUrl));
      if (u.protocol === "https:") {
        return allowedPopupHosts.has(u.hostname);
      }
      if (u.protocol === "http:") {
        // Allow ONLY the loopback OAuth callback page.
        const isLoopback =
          u.hostname === "127.0.0.1" || u.hostname === "localhost";
        return isLoopback && u.port === String(OAUTH_LOOPBACK_PORT) && u.pathname === "/oauth/callback";
      }
      return false;
    } catch {
      return false;
    }
  };

  return (details) => {
    const targetUrl = details?.url;
    if (!targetUrl || typeof targetUrl !== "string" || !/^https?:/i.test(targetUrl)) {
      return { action: "deny" };
    }

    // Default: open in system browser to reduce remote-content attack surface.
    if (!isAllowedInAppPopupUrl(targetUrl)) {
      try {
        void shell?.openExternal?.(targetUrl);
      } catch {
        // ignore
      }
      return { action: "deny" };
    }

    const size = parseWindowOpenFeatures(details?.features);
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        width: size.width || OAUTH_DEFAULT_WIDTH,
        height: size.height || OAUTH_DEFAULT_HEIGHT,
        minWidth: 420,
        minHeight: 560,
        backgroundColor,
        icon: appIcon,
        autoHideMenuBar: true,
        menuBarVisible: false,
        title: "Netcatty Authorization",
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          // Sandboxed because this window renders remote content and does not need a preload bridge.
          sandbox: true,
          v8CacheOptions: V8_CACHE_OPTIONS,
        },
      },
    };
  };
}

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

/**
 * Create the main application window
 */
async function createWindow(electronModule, options) {
  const { BrowserWindow, nativeTheme, app, screen, shell } = electronModule;
  const { preload, devServerUrl, isDev, appIcon, isMac, onRegisterBridge, electronDir } = options;

  // Store app reference for window state persistence
  electronApp = app;

  const osTheme = nativeTheme?.shouldUseDarkColors ? "dark" : "light";
  const effectiveTheme = currentTheme === "dark" || currentTheme === "light" ? currentTheme : osTheme;
  const frontendBackground = resolveFrontendBackgroundColor(electronDir || __dirname, effectiveTheme);
  const backgroundColor = frontendBackground || "#1a1a1a";
  const themeConfig = THEME_COLORS[effectiveTheme] || THEME_COLORS.light;

  // Load saved window state
  const savedState = loadWindowState();
  let windowBounds = {
    width: DEFAULT_WINDOW_WIDTH,
    height: DEFAULT_WINDOW_HEIGHT,
  };

  if (savedState) {
    // Use saved dimensions, but clamp to the minimum so a previously
    // shrunk window from an older build cannot start below the minimum.
    windowBounds.width = Math.max(savedState.width, MIN_WINDOW_WIDTH);
    windowBounds.height = Math.max(savedState.height, MIN_WINDOW_HEIGHT);

    // Only use saved position if the screen is available at that location
    if (typeof savedState.x === "number" && typeof savedState.y === "number") {
      try {
        // Check if the saved position is within any available display
        const displays = screen?.getAllDisplays?.() || [];
        const isPositionVisible = displays.some((display) => {
          const { x, y, width, height } = display.bounds;
          // Check if at least part of the window would be visible on this display
          return (
            savedState.x < x + width &&
            savedState.x + savedState.width > x &&
            savedState.y < y + height &&
            savedState.y + savedState.height > y
          );
        });

        if (isPositionVisible) {
          windowBounds.x = savedState.x;
          windowBounds.y = savedState.y;
        }
      } catch {
        // Ignore screen check errors, just don't set position
      }
    }
  }

  const win = new BrowserWindow({
    ...windowBounds,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    backgroundColor,
    icon: appIcon,
    show: false,
    frame: isMac,
    titleBarStyle: isMac ? "hiddenInset" : undefined,
    trafficLightPosition: isMac ? { x: 12, y: 12 } : undefined,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      v8CacheOptions: V8_CACHE_OPTIONS,
    },
  });

  mainWindow = win;

  // Clear reference when the main window is destroyed
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  // Log renderer crashes for diagnostics (skip normal clean exits)
  win.webContents.on("render-process-gone", (_event, details) => {
    if (details?.reason === "clean-exit") return;
    try {
      const crashLogBridge = require("./crashLogBridge.cjs");
      crashLogBridge.captureError("render-process-gone", new Error(
        `Renderer process gone: reason=${details?.reason}, exitCode=${details?.exitCode}`
      ), { reason: details?.reason, exitCode: details?.exitCode });
    } catch {}
    console.error("[WindowManager] Renderer process gone:", details);
  });

  // Prevent top-level navigation away from the app origin. If a remote origin ever
  // loads in a privileged window (with preload), it can become an RCE vector.
  const allowedOrigins = new Set(["app://netcatty"]);
  if (isDev && devServerUrl) {
    try {
      allowedOrigins.add(new URL(getDevRendererBaseUrl(devServerUrl)).origin);
    } catch {
      // ignore invalid dev server URL
    }
  }
  const isAllowedTopLevelUrl = (targetUrl) => {
    try {
      return allowedOrigins.has(new URL(String(targetUrl)).origin);
    } catch {
      return false;
    }
  };
  const blockUntrustedNavigation = (event, targetUrl) => {
    if (isAllowedTopLevelUrl(targetUrl)) return;
    try {
      event.preventDefault();
    } catch {
      // ignore
    }
    debugLog("Blocked navigation to untrusted origin", { targetUrl });
  };
  win.webContents.on("will-navigate", blockUntrustedNavigation);
  win.webContents.on("will-redirect", blockUntrustedNavigation);

  // Prevent Chromium from consuming Alt+Arrow as browser back/forward navigation.
  // Terminal apps need these keys to pass through to the remote shell (e.g., byobu, tmux).
  // Using setIgnoreMenuShortcuts lets the keydown still reach the page (xterm.js)
  // while preventing Chromium's built-in shortcuts from triggering.
  win.webContents.on("before-input-event", (_event, input) => {
    if (input.alt && !input.control && !input.meta) {
      if (input.key === "ArrowLeft" || input.key === "ArrowRight") {
        win.webContents.setIgnoreMenuShortcuts(true);
        return;
      }
    }
    win.webContents.setIgnoreMenuShortcuts(false);
  });

  // Restore maximized state if it was saved
  if (savedState?.isMaximized && !savedState?.isFullScreen) {
    win.once("ready-to-show", () => {
      try {
        win.maximize();
      } catch {
        // ignore
      }
    });
  }

  // Track window bounds for saving (use last non-maximized/non-fullscreen bounds)
  let lastNormalBounds = null;
  let saveStateTimer = null;

  const updateNormalBounds = () => {
    if (!win.isDestroyed() && !win.isMaximized() && !win.isFullScreen()) {
      lastNormalBounds = win.getBounds();
    }
  };

  const scheduleSaveState = () => {
    if (saveStateTimer) clearTimeout(saveStateTimer);
    saveStateTimer = setTimeout(() => {
      const state = getWindowBoundsState(win, lastNormalBounds);
      if (state) queueWindowStateSave(state);
    }, 500);
  };

  // Update normal bounds on resize/move when not maximized/fullscreen
  win.on("resize", () => {
    updateNormalBounds();
    scheduleSaveState();
  });

  win.on("move", () => {
    updateNormalBounds();
    scheduleSaveState();
  });

  win.on("maximize", scheduleSaveState);
  win.on("unmaximize", () => {
    updateNormalBounds();
    scheduleSaveState();
  });

  // Save state when window is about to close
  win.on("close", (event) => {
    // Check if close-to-tray is enabled
    if (!isQuitting && getGlobalShortcutBridge().handleWindowClose(event, win)) {
      // Window was hidden to tray - save state before returning
      if (saveStateTimer) clearTimeout(saveStateTimer);
      const state = getWindowBoundsState(win, lastNormalBounds);
      if (state) saveWindowStateSync(state);
      hideSettingsWindow();
      return;
    }

    if (windowStateCloseRequested) {
      return;
    }
    windowStateCloseRequested = true;
    if (saveStateTimer) clearTimeout(saveStateTimer);
    const state = getWindowBoundsState(win, lastNormalBounds);
    if (pendingWindowStateWrite) {
      event.preventDefault();
      if (state) queuedWindowState = state;
      pendingWindowStateWrite
        .catch(() => {
          // ignore async write errors before closing
        })
        .finally(() => {
          const finalState = getWindowBoundsState(win, lastNormalBounds);
          if (finalState) saveWindowStateSync(finalState);
          closeSettingsWindow();
          try {
            win.close();
          } catch {
            // ignore
          }
        });
      return;
    }
    if (state) saveWindowStateSync(state);
    closeSettingsWindow();
  });

  const safeSend = (channel, ...args) => {
    try {
      if (!win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
        win.webContents.send(channel, ...args);
      }
    } catch {
      // Render frame disposed during HMR / reload – safe to ignore
    }
  };

  win.on("enter-full-screen", () => {
    safeSend("netcatty:window:fullscreen-changed", true);
    scheduleSaveState();
  });

  win.on("leave-full-screen", () => {
    safeSend("netcatty:window:fullscreen-changed", false);
    updateNormalBounds();
    scheduleSaveState();
  });

  // Ensure native background matches frontend background, even before first paint.
  try {
    win.setBackgroundColor(backgroundColor);
  } catch {
    // ignore
  }

  // Defer show until renderer is ready; use fallback timeout to avoid keeping window hidden forever.
  // Production gets a shorter timeout since the splash screen provides visual feedback.
  setupDeferredShow(win, { timeoutMs: isDev ? 3000 : 1500 });

  win.webContents.on("did-create-window", (childWindow) => {
    try {
      childWindow.setMenuBarVisibility(false);
      childWindow.autoHideMenuBar = true;
      childWindow.removeMenu();
    } catch {
      // ignore
    }
    try {
      if (appIcon && childWindow.setIcon) childWindow.setIcon(appIcon);
    } catch {
      // ignore
    }
    // Never allow chained popups from remote content windows.
    try {
      childWindow.webContents?.setWindowOpenHandler?.(createExternalOnlyWindowOpenHandler(shell));
    } catch {
      // ignore
    }
    attachOAuthLoadingOverlay(childWindow);
  });

  win.webContents.setWindowOpenHandler(
    createAppWindowOpenHandler(shell, { backgroundColor, appIcon })
  );

  // Register window control handlers
  registerWindowHandlers(electronModule.ipcMain, nativeTheme);

  // Register IPC handlers BEFORE loading any URL so the renderer never
  // calls a handler that hasn't been registered yet.
  onRegisterBridge?.(win);

  if (isDev) {
    try {
      await win.loadURL(getDevRendererBaseUrl(devServerUrl));
      win.webContents.openDevTools({ mode: "detach" });
      return win;
    } catch (e) {
      console.warn("Dev server not reachable, falling back to bundled dist.", e);
    }
  }

  // Production mode - load via custom protocol.
  await win.loadURL("app://netcatty/index.html");
  return win;
}

/**
 * Create or focus the settings window
 */
async function openSettingsWindow(electronModule, options, { showOnLoad = true } = {}) {
  const { BrowserWindow, shell } = electronModule;
  const { preload, devServerUrl, isDev, appIcon, isMac, electronDir } = options;

  // If settings window already exists, show and focus it
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return settingsWindow;
  }

  const osTheme = electronModule?.nativeTheme?.shouldUseDarkColors ? "dark" : "light";
  const effectiveTheme = currentTheme === "dark" || currentTheme === "light" ? currentTheme : osTheme;
  const frontendBackground = resolveFrontendBackgroundColor(electronDir || __dirname, effectiveTheme);
  const backgroundColor = frontendBackground || "#1a1a1a";
  const themeConfig = THEME_COLORS[effectiveTheme] || THEME_COLORS.light;

  // Center the settings window on the same display as the main window
  const settingsWidth = 980;
  const settingsHeight = 720;
  let settingsX, settingsY;
  if (mainWindow && !mainWindow.isDestroyed()) {
    const { screen } = electronModule;
    const mainBounds = mainWindow.getBounds();
    const display = screen.getDisplayMatching(mainBounds);
    const { x: dx, y: dy, width: dw, height: dh } = display.workArea;
    settingsX = Math.round(dx + (dw - settingsWidth) / 2);
    settingsY = Math.round(dy + (dh - settingsHeight) / 2);
  }

  const win = new BrowserWindow({
    title: "netcatty Settings",
    width: settingsWidth,
    height: settingsHeight,
    ...(settingsX !== undefined && settingsY !== undefined ? { x: settingsX, y: settingsY } : {}),
    minWidth: 820,
    minHeight: 600,
    backgroundColor,
    icon: appIcon,
    fullscreenable: !isMac,
    // NOTE: Do NOT set parent - on macOS this causes rendering issues when dragging
    // the window to a different screen (the window becomes invisible while still
    // appearing in "Show All Windows" in the Dock). On Windows it can cause the
    // main window to close when the settings window is closed.
    modal: false,
    show: false,
    frame: isMac,
    titleBarStyle: isMac ? "hiddenInset" : undefined,
    trafficLightPosition: isMac ? { x: 12, y: 12 } : undefined,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      v8CacheOptions: V8_CACHE_OPTIONS,
    },
  });

  settingsWindow = win;

  // Open external links in system browser by default, and allow only known OAuth hosts in-app.
  try {
    win.webContents?.setWindowOpenHandler?.(
      createAppWindowOpenHandler(shell, { backgroundColor, appIcon })
    );
  } catch {
    // ignore
  }

  // Never allow chained popups from remote content windows spawned from settings.
  win.webContents?.on?.("did-create-window", (childWindow) => {
    try {
      childWindow.webContents?.setWindowOpenHandler?.(createExternalOnlyWindowOpenHandler(shell));
    } catch {
      // ignore
    }
  });

  // Same navigation hardening as the main window (settings has preload access too).
  const allowedOrigins = new Set(["app://netcatty"]);
  if (isDev && devServerUrl) {
    try {
      allowedOrigins.add(new URL(getDevRendererBaseUrl(devServerUrl)).origin);
    } catch {
      // ignore invalid dev server URL
    }
  }
  const isAllowedTopLevelUrl = (targetUrl) => {
    try {
      return allowedOrigins.has(new URL(String(targetUrl)).origin);
    } catch {
      return false;
    }
  };
  const blockUntrustedNavigation = (event, targetUrl) => {
    if (isAllowedTopLevelUrl(targetUrl)) return;
    try {
      event.preventDefault();
    } catch {
      // ignore
    }
    debugLog("Blocked navigation to untrusted origin (settings)", { targetUrl });
  };
  win.webContents.on("will-navigate", blockUntrustedNavigation);
  win.webContents.on("will-redirect", blockUntrustedNavigation);

  if (isMac) {
    try {
      win.setWindowButtonVisibility(true);
    } catch {
      // ignore
    }
  }

  const safeSend = (channel, ...args) => {
    try {
      if (!win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
        win.webContents.send(channel, ...args);
      }
    } catch {
      // Render frame disposed during HMR / reload – safe to ignore
    }
  };

  win.on("enter-full-screen", () => {
    safeSend("netcatty:window:fullscreen-changed", true);
  });

  win.on("leave-full-screen", () => {
    safeSend("netcatty:window:fullscreen-changed", false);
  });

  // Ensure native background matches frontend background, even before first paint.
  try {
    win.setBackgroundColor(backgroundColor);
  } catch {
    // ignore
  }

  // Hide instead of close so the window can be reused instantly.
  // When the app is quitting, allow normal close/destroy.
  win.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      try {
        win.hide();
      } catch {
        // ignore
      }
    }
  });

  // Clean up reference when actually destroyed
  win.on('closed', () => {
    settingsWindow = null;
  });

  // Prevent HTML <title> from overriding the window title
  win.on('page-title-updated', (e) => { e.preventDefault(); });

  // Load the settings page
  const settingsPath = '/#/settings';

  if (isDev) {
    try {
      const baseUrl = getDevRendererBaseUrl(devServerUrl);
      await win.loadURL(`${baseUrl}${settingsPath}`);
      if (showOnLoad) { win.show(); win.focus(); }
      return win;
    } catch (e) {
      console.warn("Dev server not reachable for settings window", e);
    }
  }

  // Production mode - load via custom protocol.
  await win.loadURL("app://netcatty/index.html#/settings");
  if (showOnLoad) { win.show(); win.focus(); }

  return win;
}

/**
 * Destroy the settings window (used when the app is quitting).
 */
function closeSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    try {
      settingsWindow.destroy();
    } catch {
      // ignore
    }
    settingsWindow = null;
  }
}

/**
 * Hide the settings window without destroying it (used when main window hides to tray).
 */
function hideSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    try {
      settingsWindow.hide();
    } catch {
      // ignore
    }
  }
}

/**
 * Pre-warm the settings window in the background so that opening it later is instant.
 * The window is created hidden and fully loaded; `openSettingsWindow` will simply show it.
 */
async function prewarmSettingsWindow(electronModule, options) {
  if (settingsWindow && !settingsWindow.isDestroyed()) return;
  try {
    await openSettingsWindow(electronModule, options, { showOnLoad: false });
  } catch (err) {
    debugLog("Failed to pre-warm settings window", { error: String(err) });
  }
}

/**
 * Register window control IPC handlers (only once)
 */
function registerWindowHandlers(ipcMain, nativeTheme) {
  // Prevent duplicate registration
  if (handlersRegistered) {
    return;
  }
  handlersRegistered = true;

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

  ipcMain.handle("netcatty:setTheme", (_event, theme) => {
    currentTheme = theme;
    nativeTheme.themeSource = theme;
    const effectiveTheme = theme === "system"
      ? (nativeTheme?.shouldUseDarkColors ? "dark" : "light")
      : theme;
    const themeConfig = THEME_COLORS[effectiveTheme] || THEME_COLORS.light;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setBackgroundColor(themeConfig.background);
    }
    // Also update settings window if open
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.setBackgroundColor(themeConfig.background);
    }
    return true;
  });

  ipcMain.handle("netcatty:setBackgroundColor", (_event, color) => {
    const normalized = normalizeBackgroundColor(color);
    if (!normalized) return false;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setBackgroundColor(normalized);
    }
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.setBackgroundColor(normalized);
    }
    return true;
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
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed() && mainWindow.webContents.id !== senderId) {
        mainWindow.webContents.send("netcatty:settings:changed", payload);
      }
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
    const cb = rendererReadyCallbacksByWebContentsId.get(wcId);
    if (cb) cb();
  });
}

/**
 * Build the application menu
 */
function buildAppMenu(Menu, app, isMac, language = currentLanguage) {
  // Save deps so later language changes can rebuild the menu.
  menuDeps = { Menu, app, isMac };
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
        { role: "forceReload" },
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
          ? [{ type: "separator" }, { role: "front" }]
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
  return mainWindow;
}

/**
 * Get the settings window instance
 */
function getSettingsWindow() {
  return settingsWindow;
}

module.exports = {
  createWindow,
  openSettingsWindow,
  closeSettingsWindow,
  prewarmSettingsWindow,
  buildAppMenu,
  getMainWindow,
  getSettingsWindow,
  setIsQuitting,
  THEME_COLORS,
};
