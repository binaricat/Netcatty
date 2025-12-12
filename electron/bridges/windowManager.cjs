/**
 * Window Manager - Handles Electron window creation and management
 * Extracted from main.cjs for single responsibility
 */

const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");

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
let handlersRegistered = false; // Prevent duplicate IPC handler registration
let staticServer = null;
let staticServerBaseUrl = null;

/**
 * Normalize dev server URL for WebAuthn compatibility
 */
function normalizeDevServerUrl(urlString) {
  if (!urlString) return urlString;
  try {
    const u = new URL(urlString);
    const host = u.hostname;
    // WebAuthn RP IDs can be rejected for non-registrable hosts (e.g. 0.0.0.0).
    // Using localhost is the most compatible option across platforms.
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

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
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
  return mimeTypes[ext] || "application/octet-stream";
}

function getCacheControlHeader(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  // HTML should not be cached aggressively; assets can be long-cached (Vite uses hashed filenames).
  if (ext === ".html") return "no-store";
  return "public, max-age=31536000, immutable";
}

async function ensureProductionStaticServer(electronDir) {
  if (staticServerBaseUrl) return staticServerBaseUrl;

  const distPath = path.join(electronDir, "../dist");
  if (!fs.existsSync(distPath)) {
    throw new Error(`Missing dist directory at ${distPath}`);
  }

  staticServer = http.createServer((req, res) => {
    try {
      const reqUrl = new URL(req.url || "/", "http://localhost");
      let pathname = decodeURIComponent(reqUrl.pathname);
      if (!pathname || pathname === "/") pathname = "/index.html";

      const hasExtension = path.extname(pathname) !== "";
      let fullPath = path.join(distPath, pathname);

      // Security: ensure path is within dist directory
      const normalizedDistPath = path.resolve(distPath) + path.sep;
      const normalizedFullPath = path.resolve(fullPath);
      if (!normalizedFullPath.startsWith(normalizedDistPath)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden");
        return;
      }

      // SPA fallback: serve index.html for unknown routes without extension
      if (!fs.existsSync(normalizedFullPath) && !hasExtension) {
        fullPath = path.join(distPath, "index.html");
      } else {
        fullPath = normalizedFullPath;
      }

      if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
        return;
      }

      const stat = fs.statSync(fullPath);
      res.writeHead(200, {
        "Content-Type": getMimeType(fullPath),
        "Content-Length": stat.size.toString(),
        "Cache-Control": getCacheControlHeader(fullPath),
      });

      fs.createReadStream(fullPath).pipe(res);
    } catch (_err) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
    }
  });

  await new Promise((resolve, reject) => {
    staticServer.once("error", reject);
    staticServer.listen(0, "127.0.0.1", () => resolve());
  });

  const address = staticServer.address();
  const port = address && typeof address === "object" ? address.port : null;
  if (!port) throw new Error("Failed to bind production static server");

  // Use localhost so WebAuthn RP ID can be "localhost"
  staticServerBaseUrl = `http://localhost:${port}`;
  return staticServerBaseUrl;
}

function shutdownProductionStaticServer() {
  const server = staticServer;
  staticServer = null;
  staticServerBaseUrl = null;
  if (server) {
    try {
      server.close();
    } catch {}
  }
}

/**
 * Create the main application window
 */
async function createWindow(electronModule, options) {
  const { BrowserWindow, nativeTheme, protocol } = electronModule;
  const { preload, devServerUrl, isDev, appIcon, isMac, electronDir, onRegisterBridge } = options;
  
  const themeConfig = THEME_COLORS[currentTheme];
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: themeConfig.background,
    icon: appIcon,
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

  // Register window control handlers
  registerWindowHandlers(electronModule.ipcMain, nativeTheme);

  if (isDev) {
    try {
      await win.loadURL(normalizeDevServerUrl(devServerUrl));
      win.webContents.openDevTools({ mode: "detach" });
      onRegisterBridge?.(win);
      return win;
    } catch (e) {
      console.warn("Dev server not reachable, falling back to bundled dist.", e);
    }
  }

  // Production mode - serve from localhost HTTP for WebAuthn compatibility.
  // Chromium blocks WebAuthn on custom schemes even when marked as secure.
  const baseUrl = await ensureProductionStaticServer(electronDir);
  console.log("[Main] Loading production build via", baseUrl);
  await win.loadURL(`${baseUrl}/index.html`);
  
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
  
  const themeConfig = THEME_COLORS[currentTheme];
  const win = new BrowserWindow({
    width: 800,
    height: 650,
    minWidth: 700,
    minHeight: 500,
    backgroundColor: themeConfig.background,
    icon: appIcon,
    parent: mainWindow,
    modal: false,
    show: false,
    frame: false,
    titleBarStyle: isMac ? "hiddenInset" : undefined,
    trafficLightPosition: isMac ? { x: 16, y: 18 } : undefined,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  settingsWindow = win;

  // Show window when ready to prevent flicker
  win.once('ready-to-show', () => {
    win.show();
  });

  // Clean up reference when closed
  win.on('closed', () => {
    settingsWindow = null;
  });

  // Load the settings page
  const settingsPath = '/#/settings';
  
  if (isDev) {
    try {
      await win.loadURL(normalizeDevServerUrl(devServerUrl) + settingsPath);
      return win;
    } catch (e) {
      console.warn("Dev server not reachable for settings window", e);
    }
  }

  // Production mode - serve from localhost HTTP for WebAuthn compatibility.
  const baseUrl = await ensureProductionStaticServer(electronDir);
  await win.loadURL(`${baseUrl}/index.html#/settings`);
  
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

  ipcMain.handle("netcatty:window:minimize", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.minimize();
    }
  });

  ipcMain.handle("netcatty:window:maximize", () => {
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

  ipcMain.handle("netcatty:window:close", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.close();
    }
  });

  ipcMain.handle("netcatty:window:isMaximized", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      return mainWindow.isMaximized();
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

  // Settings window close handler
  ipcMain.handle("netcatty:settings:close", () => {
    closeSettingsWindow();
  });
}

/**
 * Build the application menu
 */
function buildAppMenu(Menu, app, isMac) {
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
      label: "Edit",
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
      label: "View",
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
      label: "Window",
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
  shutdownProductionStaticServer,
  getMainWindow,
  getSettingsWindow,
  THEME_COLORS,
};
