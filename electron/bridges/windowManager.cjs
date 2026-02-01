/**
 * Window Manager - Handles Electron window creation and management
 * Extracted from main.cjs for single responsibility
 */

const path = require("node:path");
const fs = require("node:fs");

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
const rendererReadyCallbacksByWebContentsId = new Map();
const DEBUG_WINDOWS = process.env.NETCATTY_DEBUG_WINDOWS === "1";
const OAUTH_DEFAULT_WIDTH = 600;
const OAUTH_DEFAULT_HEIGHT = 700;
const OAUTH_OVERLAY_ID = "__netcatty_oauth_loading__";
const WINDOW_STATE_FILE = "window-state.json";
const DEFAULT_WINDOW_WIDTH = 1400;
const DEFAULT_WINDOW_HEIGHT = 900;

function debugLog(...args) {
  if (!DEBUG_WINDOWS) return;
  try {
    // eslint-disable-next-line no-console
    console.log("[WindowManager]", ...args);
  } catch {
    // ignore
  }
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
  en: { edit: "Edit", view: "View", window: "Window" },
  "zh-CN": { edit: "编辑", view: "视图", window: "窗口" },
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
    win.webContents.executeJavaScript(injectOverlayScript, true).catch(() => {});
  });

  win.webContents.on("did-stop-loading", () => {
    win.webContents.executeJavaScript(removeOverlayScript, true).catch(() => {});
  });

  win.webContents.on("did-fail-load", () => {
    win.webContents.executeJavaScript(removeOverlayScript, true).catch(() => {});
  });
}

async function waitForRootPaint(win, { timeoutMs = 400, intervalMs = 30 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (win.isDestroyed()) return false;
      const count = await win.webContents.executeJavaScript(
        `(() => {
          const root = document.getElementById("root");
          return root ? root.children.length : 0;
        })()`,
        true,
      );
      if (Number(count) > 0) return true;
    } catch {
      return false;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
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

  win.webContents.once("did-finish-load", () => {
    void (async () => {
      // If the renderer mounts shortly after load, wait briefly to avoid showing a blank root.
      const painted = await waitForRootPaint(win, { timeoutMs: 800, intervalMs: 50 });
      if (painted) markRendererReady();
    })();
  });

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
  const { BrowserWindow, nativeTheme, app, screen } = electronModule;
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
    // Use saved dimensions
    windowBounds.width = savedState.width;
    windowBounds.height = savedState.height;

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
    },
  });

  mainWindow = win;

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

  win.on("enter-full-screen", () => {
    win.webContents?.send("netcatty:window:fullscreen-changed", true);
    scheduleSaveState();
  });

  win.on("leave-full-screen", () => {
    win.webContents?.send("netcatty:window:fullscreen-changed", false);
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
    attachOAuthLoadingOverlay(childWindow);
  });

  win.webContents.setWindowOpenHandler((details) => {
    const url = details?.url;
    if (!url || !/^https?:/i.test(url)) {
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
          sandbox: false,
        },
      },
    };
  });

  // Register window control handlers
  registerWindowHandlers(electronModule.ipcMain, nativeTheme);

  if (isDev) {
    try {
      await win.loadURL(getDevRendererBaseUrl(devServerUrl));
      win.webContents.openDevTools({ mode: "detach" });
      onRegisterBridge?.(win);
      return win;
    } catch (e) {
      console.warn("Dev server not reachable, falling back to bundled dist.", e);
    }
  }

  // Production mode - load via custom protocol.
  await win.loadURL("app://netcatty/index.html");
  
  onRegisterBridge?.(win);
  return win;
}

/**
 * Create or focus the settings window
 */
async function openSettingsWindow(electronModule, options) {
  const { BrowserWindow } = electronModule;
  const { preload, devServerUrl, isDev, appIcon, isMac, electronDir } = options;
  
  // If settings window already exists, just focus it
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return settingsWindow;
  }
  
  const osTheme = electronModule?.nativeTheme?.shouldUseDarkColors ? "dark" : "light";
  const effectiveTheme = currentTheme === "dark" || currentTheme === "light" ? currentTheme : osTheme;
  const frontendBackground = resolveFrontendBackgroundColor(electronDir || __dirname, effectiveTheme);
  const backgroundColor = frontendBackground || "#1a1a1a";
  const themeConfig = THEME_COLORS[effectiveTheme] || THEME_COLORS.light;

  const win = new BrowserWindow({
    width: 980,
    height: 720,
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
    },
  });

  settingsWindow = win;

  if (isMac) {
    try {
      win.setWindowButtonVisibility(true);
    } catch {
      // ignore
    }
  }

  win.on("enter-full-screen", () => {
    win.webContents?.send("netcatty:window:fullscreen-changed", true);
  });

  win.on("leave-full-screen", () => {
    win.webContents?.send("netcatty:window:fullscreen-changed", false);
  });

  // Ensure native background matches frontend background, even before first paint.
  try {
    win.setBackgroundColor(backgroundColor);
  } catch {
    // ignore
  }

  // Defer show until renderer is ready; use fallback timeout to avoid keeping window hidden forever.
  setupDeferredShow(win, { timeoutMs: isDev ? 1200 : 600, waitForRendererReady: false });

  // Clean up reference when closed
  win.on('closed', () => {
    settingsWindow = null;
  });

  // Load the settings page
  const settingsPath = '/#/settings';
  
  if (isDev) {
    try {
      const baseUrl = getDevRendererBaseUrl(devServerUrl);
      await win.loadURL(`${baseUrl}${settingsPath}`);
      return win;
    } catch (e) {
      console.warn("Dev server not reachable for settings window", e);
    }
  }

  // Production mode - load via custom protocol.
  await win.loadURL("app://netcatty/index.html#/settings");
  
  return win;
}

/**
 * Close the settings window
 */
function closeSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.close();
    settingsWindow = null;
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
    const themeConfig = THEME_COLORS[theme] || THEME_COLORS.light;
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
    // Prefer closing the tracked settings window (if any).
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      debugLog("settings:close (tracked)", {
        senderId: event?.sender?.id,
        settingsId: settingsWindow.webContents?.id,
      });
      closeSettingsWindow();
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
        { role: "reload" },
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
  buildAppMenu,
  getMainWindow,
  getSettingsWindow,
  THEME_COLORS,
};
