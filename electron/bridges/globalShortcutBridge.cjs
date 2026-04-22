/**
 * Global Shortcut Bridge - Handles global keyboard shortcuts and system tray
 * Implements the "Quake mode" / drop-down terminal feature
 */

const path = require("node:path");
const fs = require("node:fs");

let electronModule = null;
let tray = null;
let closeToTray = false;
let currentHotkey = null;
let hotkeyEnabled = false;

const STATUS_TEXT = {
  session: {
    connected: "Connected",
    connecting: "Connecting",
    disconnected: "Disconnected",
  },
  portForward: {
    active: "Active",
    connecting: "Connecting",
    inactive: "Inactive",
    error: "Error",
  },
};
// Dynamic tray menu data (synced from renderer)
let trayMenuData = {
  sessions: [],        // { id, label, hostLabel, status }
  portForwardRules: [], // { id, label, type, localPort, remoteHost, remotePort, status, hostId }
};

let trayPanelWindow = null;

let trayPanelRefreshTimer = null;
// Watchdog: if `leave-full-screen` never arrives (edge case / stuck transition)
// we eventually give up and force a hide attempt. Better a visible window than
// a hung close-to-tray path.
const FULLSCREEN_LEAVE_WATCHDOG_MS = 5000;
// After `leave-full-screen` fires, macOS emits a trailing `show` event while
// the native space transition finishes. Calling `win.hide()` before that show
// causes the window to pop back on screen. We wait for the trailing show, or
// fall back on this timeout — whichever comes first.
const FULLSCREEN_TRAILING_SHOW_FALLBACK_MS = 300;
const pendingFullscreenHideByWindow = new WeakMap();

function clearPendingFullscreenHide(win) {
  if (!win || typeof win !== "object") return;
  const pending = pendingFullscreenHideByWindow.get(win);
  if (!pending) return;

  if (pending.watchdogTimer) {
    clearTimeout(pending.watchdogTimer);
    pending.watchdogTimer = null;
  }
  if (pending.trailingShowTimer) {
    clearTimeout(pending.trailingShowTimer);
    pending.trailingShowTimer = null;
  }

  try {
    if (pending.onLeaveFullScreen) {
      win.removeListener?.("leave-full-screen", pending.onLeaveFullScreen);
    }
    if (pending.onClosed) {
      win.removeListener?.("closed", pending.onClosed);
    }
    if (pending.onTrailingShow) {
      win.removeListener?.("show", pending.onTrailingShow);
    }
  } catch {
    // ignore
  }

  pendingFullscreenHideByWindow.delete(win);
}

function performPendingFullscreenHide(win) {
  const pending = pendingFullscreenHideByWindow.get(win);
  if (!pending) return "cancelled";
  if (!win || win.isDestroyed?.()) {
    clearPendingFullscreenHide(win);
    return "cancelled";
  }

  clearPendingFullscreenHide(win);

  try {
    win.hide();
    return "hidden";
  } catch (err) {
    console.warn("[GlobalShortcut] Error hiding window after leaving fullscreen:", err);
    return "failed";
  }
}

function handleLeaveFullScreenForPendingHide(win) {
  const pending = pendingFullscreenHideByWindow.get(win);
  if (!pending) return;
  if (!win || win.isDestroyed?.()) {
    clearPendingFullscreenHide(win);
    return;
  }

  pending.leaveFullScreenFired = true;

  if (pending.watchdogTimer) {
    clearTimeout(pending.watchdogTimer);
    pending.watchdogTimer = null;
  }

  // Wait for the trailing `show` that macOS emits as the space transition
  // finishes, then hide on top of it. If it never fires within the fallback
  // window, hide anyway.
  pending.onTrailingShow = () => {
    pending.onTrailingShow = null;
    if (pending.trailingShowTimer) {
      clearTimeout(pending.trailingShowTimer);
      pending.trailingShowTimer = null;
    }
    performPendingFullscreenHide(win);
  };
  try {
    win.once?.("show", pending.onTrailingShow);
  } catch {
    // ignore
  }

  pending.trailingShowTimer = setTimeout(() => {
    pending.trailingShowTimer = null;
    if (pending.onTrailingShow) {
      try {
        win.removeListener?.("show", pending.onTrailingShow);
      } catch {
        // ignore
      }
      pending.onTrailingShow = null;
    }
    performPendingFullscreenHide(win);
  }, FULLSCREEN_TRAILING_SHOW_FALLBACK_MS);
}

function startPendingFullscreenHideWatchdog(win) {
  const pending = pendingFullscreenHideByWindow.get(win);
  if (!pending) return;

  pending.watchdogTimer = setTimeout(() => {
    pending.watchdogTimer = null;
    if (!pendingFullscreenHideByWindow.has(win)) return;
    if (!win || win.isDestroyed?.()) {
      clearPendingFullscreenHide(win);
      return;
    }
    if (pending.leaveFullScreenFired) return;

    console.warn("[GlobalShortcut] Timed out waiting for leave-full-screen before hiding to tray; forcing hide");
    // Give up and hide anyway. Simulate the leave path so the trailing-show
    // wait still applies (defence in depth against spurious show events).
    handleLeaveFullScreenForPendingHide(win);
  }, FULLSCREEN_LEAVE_WATCHDOG_MS);
}

function openMainWindow() {
  const { app } = electronModule;
  const win = getMainWindow();
  if (!win) return;
  clearPendingFullscreenHide(win);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  try {
    app.focus({ steal: true });
  } catch {
    // ignore
  }
}

function getTrayPanelUrl() {
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    return `${devServerUrl.replace(/\/$/, "")}/#/tray`;
  }
  return "app://netcatty/index.html#/tray";
}

function ensureTrayPanelWindow() {
  const { BrowserWindow } = electronModule;
  if (trayPanelWindow && !trayPanelWindow.isDestroyed()) return trayPanelWindow;

  trayPanelWindow = new BrowserWindow({
    width: 360,
    height: 520,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: true,
    hasShadow: true,
    webPreferences: {
      preload: path.join(__dirname, "../preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  trayPanelWindow.webContents.on("console-message", (_event, level, message) => {
    // Forward renderer logs to main process output for easy debugging.
    console.log(`[TrayPanel:renderer:${level}] ${message}`);
  });

  trayPanelWindow.on("blur", () => {
    try {
      trayPanelWindow?.hide();
    } catch {
      // ignore
    }
  });

  const url = getTrayPanelUrl();
  console.log("[TrayPanel] loadURL", url);
  void trayPanelWindow.loadURL(url);

  trayPanelWindow.webContents.on("did-finish-load", () => {
    try {
      trayPanelWindow?.webContents?.send("netcatty:trayPanel:setMenuData", trayMenuData);
    } catch {
      // ignore
    }
  });

  return trayPanelWindow;
}

function showTrayPanel() {
  if (!tray) return;
  const { screen } = electronModule;
  const win = ensureTrayPanelWindow();

  const trayBounds = tray.getBounds();
  const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
  const workArea = display.workArea;

  const panelBounds = win.getBounds();
  const x = Math.min(
    Math.max(trayBounds.x + Math.round(trayBounds.width / 2) - Math.round(panelBounds.width / 2), workArea.x),
    workArea.x + workArea.width - panelBounds.width,
  );
  const y = Math.min(trayBounds.y + trayBounds.height + 6, workArea.y + workArea.height - panelBounds.height);

  win.setBounds({ x, y, width: panelBounds.width, height: panelBounds.height }, false);
  win.show();
  win.focus();

  try {
    win.webContents?.send("netcatty:trayPanel:setMenuData", trayMenuData);
  } catch {
    // ignore
  }

  if (trayPanelRefreshTimer) clearInterval(trayPanelRefreshTimer);
  trayPanelRefreshTimer = setInterval(() => {
    try {
      if (!trayPanelWindow || trayPanelWindow.isDestroyed() || !trayPanelWindow.isVisible()) return;
      trayPanelWindow.webContents?.send("netcatty:trayPanel:refresh");
    } catch {
      // ignore
    }
  }, 1000);
}

function hideTrayPanel() {
  if (trayPanelWindow && !trayPanelWindow.isDestroyed()) {
    trayPanelWindow.hide();
  }

  if (trayPanelRefreshTimer) {
    clearInterval(trayPanelRefreshTimer);
    trayPanelRefreshTimer = null;
  }
}

function toggleTrayPanel() {
  if (trayPanelWindow && !trayPanelWindow.isDestroyed() && trayPanelWindow.isVisible()) {
    hideTrayPanel();
  } else {
    showTrayPanel();
  }
}

function resolveTrayIconPath() {
  const { app } = electronModule;

  // Use different icons for different platforms
  // macOS: template image (black + transparent, system handles color)
  // Windows/Linux: colored icon
  const isMac = process.platform === "darwin";
  const iconName = isMac ? "tray-iconTemplate.png" : "tray-icon.png";

  // Security: Only use known packaged icon locations, ignore renderer-provided paths
  const candidates = [
    path.join(app.getAppPath(), "dist", iconName),
    path.join(app.getAppPath(), "public", iconName),
    path.join(__dirname, "../../public", iconName),
    path.join(__dirname, "../../dist", iconName),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Initialize the bridge with dependencies
 */
function init(deps) {
  electronModule = deps.electronModule;
}

/**
 * Get the main window reference
 * Uses windowManager's tracked mainWindow for reliability
 */
function getMainWindow() {
  // Prefer the explicitly tracked main window from windowManager
  const windowManager = require("./windowManager.cjs");
  const tracked = windowManager.getMainWindow?.();
  if (tracked && !tracked.isDestroyed?.()) {
    return tracked;
  }
  // Fallback: filter out tray panel window from all windows
  const { BrowserWindow } = electronModule;
  const wins = BrowserWindow.getAllWindows();
  const mainWins = wins.filter((w) => w !== trayPanelWindow && !w.isDestroyed?.());
  return mainWins && mainWins.length ? mainWins[0] : null;
}

function hideWindowRespectingMacFullscreen(win) {
  if (!win || win.isDestroyed?.()) return false;

  clearPendingFullscreenHide(win);

  if (process.platform === "darwin" && win.isFullScreen?.()) {
    // Close-to-tray on a native-fullscreen window on macOS has two traps:
    //
    // 1. `isFullScreen()` can flip to false BEFORE the exit animation
    //    completes. Polling it and calling `win.hide()` at that moment
    //    hides the window mid-transition, which macOS then undoes when
    //    the animation finishes.
    // 2. Right after the real `leave-full-screen` event, macOS emits an
    //    internal `show` event as part of finalizing the space transition
    //    — this show undoes any earlier hide.
    //
    // Strategy: wait for `leave-full-screen`, then wait for the trailing
    // `show` that follows it (or a short timeout), and only then hide.
    // All legitimate "bring the window back" entry points (openMainWindow,
    // toggleWindowVisibility, setCloseToTray(false), app.on("activate"),
    // closed) explicitly call clearPendingFullscreenHide so we never race
    // with genuine user intent.
    const pending = {
      watchdogTimer: null,
      trailingShowTimer: null,
      leaveFullScreenFired: false,
      onLeaveFullScreen: null,
      onClosed: null,
      onTrailingShow: null,
    };
    pending.onLeaveFullScreen = () => {
      handleLeaveFullScreenForPendingHide(win);
    };
    pending.onClosed = () => {
      clearPendingFullscreenHide(win);
    };

    try {
      pendingFullscreenHideByWindow.set(win, pending);
      win.once?.("leave-full-screen", pending.onLeaveFullScreen);
      win.once?.("closed", pending.onClosed);
      startPendingFullscreenHideWatchdog(win);
      win.setFullScreen(false);
      return true;
    } catch (err) {
      clearPendingFullscreenHide(win);
      console.warn("[GlobalShortcut] Error leaving fullscreen before hiding window:", err);
    }
  }

  try {
    win.hide();
    return true;
  } catch (err) {
    console.warn("[GlobalShortcut] Error hiding window:", err);
    return false;
  }
}

/**
 * Convert a hotkey string from frontend format to Electron accelerator format
 * e.g., "⌘ + Space" -> "CommandOrControl+Space"
 *       "Ctrl + `" -> "CommandOrControl+`"
 *       "Alt + Space" -> "Alt+Space"
 */
function toElectronAccelerator(hotkeyStr) {
  if (!hotkeyStr || hotkeyStr === "Disabled" || hotkeyStr === "") {
    return null;
  }

  // Parse the hotkey string
  const parts = hotkeyStr.split("+").map((p) => p.trim());

  // Convert each part to Electron accelerator format
  const acceleratorParts = parts.map((part) => {
    // Mac symbols to Electron format
    if (part === "⌘" || part === "Cmd" || part === "Command") {
      return "CommandOrControl";
    }
    if (part === "⌃" || part === "Ctrl" || part === "Control") {
      return "Control";
    }
    if (part === "⌥" || part === "Alt" || part === "Option") {
      return "Alt";
    }
    if (part === "Shift") {
      return "Shift";
    }
    if (part === "Win" || part === "Super" || part === "Meta") {
      return "Super";
    }
    // Arrow symbols
    if (part === "↑") return "Up";
    if (part === "↓") return "Down";
    if (part === "←") return "Left";
    if (part === "→") return "Right";
    // Special keys
    if (part === "↵" || part === "Enter" || part === "Return") return "Return";
    if (part === "⇥" || part === "Tab") return "Tab";
    if (part === "⌫" || part === "Backspace") return "Backspace";
    if (part === "Del" || part === "Delete") return "Delete";
    if (part === "Esc" || part === "Escape") return "Escape";
    if (part === "Space") return "Space";
    // Backtick/grave accent
    if (part === "`" || part === "~") return "`";
    // Function keys
    if (/^F\d+$/i.test(part)) return part.toUpperCase();
    // Single character - keep as-is
    return part;
  });

  return acceleratorParts.join("+");
}

/**
 * Toggle the main window visibility
 */
function toggleWindowVisibility() {
  const win = getMainWindow();
  if (!win) return;

  try {
    // Check if window is minimized first - minimized windows may still report isVisible() = true
    if (win.isMinimized()) {
      clearPendingFullscreenHide(win);
      win.restore();
      win.show();
      win.focus();
      const { app } = electronModule;
      try {
        app.focus({ steal: true });
      } catch {
        // ignore
      }
    } else if (win.isVisible()) {
      if (win.isFocused()) {
        // Window is visible and focused - hide it
        hideWindowRespectingMacFullscreen(win);
      } else {
        // Window is visible but not focused - focus it
        clearPendingFullscreenHide(win);
        win.focus();
        const { app } = electronModule;
        try {
          app.focus({ steal: true });
        } catch {
          // ignore
        }
      }
    } else {
      // Window is hidden - show and focus it
      clearPendingFullscreenHide(win);
      win.show();
      win.focus();
      const { app } = electronModule;
      try {
        app.focus({ steal: true });
      } catch {
        // ignore
      }
    }
  } catch (err) {
    console.warn("[GlobalShortcut] Error toggling window visibility:", err);
  }
}

/**
 * Register the global toggle hotkey
 */
function registerGlobalHotkey(hotkeyStr) {
  const { globalShortcut } = electronModule;

  // Unregister existing hotkey first
  unregisterGlobalHotkey();

  if (!hotkeyStr || hotkeyStr === "Disabled" || hotkeyStr === "") {
    hotkeyEnabled = false;
    currentHotkey = null;
    return { success: true, enabled: false };
  }

  const accelerator = toElectronAccelerator(hotkeyStr);
  if (!accelerator) {
    hotkeyEnabled = false;
    currentHotkey = null;
    return { success: false, error: "Invalid hotkey format" };
  }

  try {
    const registered = globalShortcut.register(accelerator, toggleWindowVisibility);
    if (registered) {
      hotkeyEnabled = true;
      currentHotkey = hotkeyStr;
      console.log(`[GlobalShortcut] Registered hotkey: ${accelerator}`);
      return { success: true, enabled: true, accelerator };
    } else {
      console.warn(`[GlobalShortcut] Failed to register hotkey: ${accelerator}`);
      return { success: false, error: "Hotkey may be in use by another application" };
    }
  } catch (err) {
    console.error("[GlobalShortcut] Error registering hotkey:", err);
    return { success: false, error: err.message };
  }
}

/**
 * Unregister the global toggle hotkey
 */
function unregisterGlobalHotkey() {
  if (!hotkeyEnabled || !currentHotkey) return;

  const { globalShortcut } = electronModule;
  const accelerator = toElectronAccelerator(currentHotkey);

  if (accelerator) {
    try {
      globalShortcut.unregister(accelerator);
      console.log(`[GlobalShortcut] Unregistered hotkey: ${accelerator}`);
    } catch (err) {
      console.warn("[GlobalShortcut] Error unregistering hotkey:", err);
    }
  }

  hotkeyEnabled = false;
  currentHotkey = null;
}

/**
 * Create the system tray icon
 */
function createTray() {
  const { Tray, Menu, app, nativeImage } = electronModule;

  if (tray) {
    // Tray already exists
    return;
  }

  try {
    // Load the tray icon
    let trayIcon;
    const resolvedIconPath = resolveTrayIconPath();
    if (resolvedIconPath) {
      trayIcon = nativeImage.createFromPath(resolvedIconPath);
      if (process.platform === "darwin") {
        trayIcon = trayIcon.resize({ width: 16, height: 16 });
        trayIcon.setTemplateImage(true);
      } else {
        // Windows/Linux: attach the @2x representation so the OS can pick
        // the right pixel size per DPI scale. Force-resizing to 16x16 here
        // produces blurry icons on HiDPI displays where the tray slot is
        // rendered larger than 16px.
        const hiDpiPath = resolvedIconPath.replace(/\.png$/i, "@2x.png");
        if (fs.existsSync(hiDpiPath)) {
          trayIcon.addRepresentation({
            scaleFactor: 2,
            buffer: fs.readFileSync(hiDpiPath),
          });
        }
      }
    }

    tray = new Tray(trayIcon || nativeImage.createEmpty());
    tray.setToolTip("Netcatty");

    // Build and set initial context menu
    updateTrayMenu();

    // Click on tray icon toggles tray panel
    tray.on("click", () => {
      toggleTrayPanel();
    });

    console.log("[GlobalShortcut] System tray created");
  } catch (err) {
    console.error("[GlobalShortcut] Error creating tray:", err);
  }
}

/**
 * Build the tray context menu with dynamic content
 */
function buildTrayMenuTemplate() {
  const { app } = electronModule;
  const menuTemplate = [];

  // Open Main Window
  menuTemplate.push({
    label: "Open Main Window",
    click: () => {
      openMainWindow();
    },
  });

  menuTemplate.push({ type: "separator" });

  // Active Sessions
  if (trayMenuData.sessions && trayMenuData.sessions.length > 0) {
    menuTemplate.push({
      label: "Sessions",
      enabled: false,
    });
    for (const session of trayMenuData.sessions) {
      const statusText =
        session.status === "connected"
          ? STATUS_TEXT.session.connected
          : session.status === "connecting"
            ? STATUS_TEXT.session.connecting
            : STATUS_TEXT.session.disconnected;
      menuTemplate.push({
        label: `  ${session.hostLabel || session.label}  (${statusText})`,
        click: () => {
          // Focus window and switch to this session
          const win = getMainWindow();
          if (win) {
            if (win.isMinimized()) win.restore();
            win.show();
            win.focus();
            // Notify renderer to focus this session
            win.webContents?.send("netcatty:tray:focusSession", session.id);
          }
        },
      });
    }
    menuTemplate.push({ type: "separator" });
  }

  // Port Forwarding Rules
  if (trayMenuData.portForwardRules && trayMenuData.portForwardRules.length > 0) {
    menuTemplate.push({
      label: "Port Forwarding",
      enabled: false,
    });
    for (const rule of trayMenuData.portForwardRules) {
      const isActive = rule.status === "active";
      const isConnecting = rule.status === "connecting";
      const statusText =
        rule.status === "active"
          ? STATUS_TEXT.portForward.active
          : rule.status === "connecting"
            ? STATUS_TEXT.portForward.connecting
            : rule.status === "error"
              ? STATUS_TEXT.portForward.error
              : STATUS_TEXT.portForward.inactive;
      const typeLabel = rule.type === "local" ? "L" : rule.type === "remote" ? "R" : "D";
      const portInfo = rule.type === "dynamic"
        ? `${rule.localPort}`
        : `${rule.localPort} → ${rule.remoteHost}:${rule.remotePort}`;

      menuTemplate.push({
        label: `  [${typeLabel}] ${rule.label || portInfo}  (${statusText})`,
        enabled: !isConnecting,
        click: () => {
          const win = getMainWindow();
          if (win) {
            win.webContents?.send("netcatty:tray:togglePortForward", rule.id, !isActive);
          }
        },
      });
    }
    menuTemplate.push({ type: "separator" });
  }

  // Quit
  menuTemplate.push({
    label: "Quit",
    click: () => {
      closeToTray = false;
      app.quit();
    },
  });

  return menuTemplate;
}

/**
 * Update the tray context menu
 */
function updateTrayMenu() {
  if (!tray) return;
  // Avoid showing a context menu on left-click; we toggle our custom panel instead.
  // On macOS, right-click may still show a menu if one is set, so we don't set any.
  try {
    tray.setContextMenu(null);
  } catch {
    // ignore
  }
}

/**
 * Update tray menu data from renderer
 */
function setTrayMenuData(data) {
  if (data.sessions !== undefined) {
    trayMenuData.sessions = data.sessions;
  }
  if (data.portForwardRules !== undefined) {
    trayMenuData.portForwardRules = data.portForwardRules;
  }
  // Rebuild menu with new data
  updateTrayMenu();
}

/**
 * Destroy the system tray icon
 */
function destroyTray() {
  if (tray) {
    try {
      tray.destroy();
      tray = null;
      console.log("[GlobalShortcut] System tray destroyed");
    } catch (err) {
      console.warn("[GlobalShortcut] Error destroying tray:", err);
    }
  }
}

/**
 * Set close-to-tray behavior
 */
function setCloseToTray(enabled) {
  closeToTray = !!enabled;

  if (closeToTray) {
    // Create tray if it doesn't exist
    if (!tray) {
      createTray();
    }
  } else {
    clearPendingFullscreenHide(getMainWindow());
    // Destroy tray if it exists
    destroyTray();
  }

  return { success: true, enabled: closeToTray };
}

/**
 * Check if close-to-tray is enabled
 */
function isCloseToTrayEnabled() {
  return closeToTray;
}

/**
 * Get current hotkey status
 */
function getHotkeyStatus() {
  return {
    enabled: hotkeyEnabled,
    hotkey: currentHotkey,
  };
}

/**
 * Handle window close event - hide to tray instead of closing
 */
function handleWindowClose(event, win) {
  if (closeToTray && tray) {
    event.preventDefault();
    hideWindowRespectingMacFullscreen(win);
    return true; // Prevented close
  }
  return false; // Allow close
}

/**
 * Register IPC handlers
 */
function registerHandlers(ipcMain) {
  // Register global toggle hotkey
  ipcMain.handle("netcatty:globalHotkey:register", async (_event, { hotkey }) => {
    return registerGlobalHotkey(hotkey);
  });

  // Unregister global toggle hotkey
  ipcMain.handle("netcatty:globalHotkey:unregister", async () => {
    unregisterGlobalHotkey();
    return { success: true };
  });

  // Get current hotkey status
  ipcMain.handle("netcatty:globalHotkey:status", async () => {
    return getHotkeyStatus();
  });

  // Set close-to-tray behavior
  ipcMain.handle("netcatty:tray:setCloseToTray", async (_event, { enabled }) => {
    return setCloseToTray(enabled);
  });

  // Get close-to-tray status
  ipcMain.handle("netcatty:tray:isCloseToTray", async () => {
    return { enabled: closeToTray };
  });

  // Update tray menu data
  ipcMain.handle("netcatty:tray:updateMenuData", async (_event, data) => {
    setTrayMenuData(data);
    return { success: true };
  });

  ipcMain.handle("netcatty:trayPanel:hide", async () => {
    hideTrayPanel();
    return { success: true };
  });

  ipcMain.handle("netcatty:trayPanel:openMainWindow", async () => {
    openMainWindow();
    return { success: true };
  });

  ipcMain.handle("netcatty:trayPanel:jumpToSession", async (_event, sessionId) => {
    openMainWindow();
    try {
      const win = getMainWindow();
      win?.webContents?.send("netcatty:trayPanel:jumpToSession", sessionId);
    } catch {
      // ignore
    }
    return { success: true };
  });

  ipcMain.handle("netcatty:trayPanel:connectToHost", async (_event, hostId) => {
    openMainWindow();
    try {
      const win = getMainWindow();
      win?.webContents?.send("netcatty:trayPanel:connectToHost", hostId);
    } catch {
      // ignore
    }
    return { success: true };
  });

  ipcMain.handle("netcatty:trayPanel:quitApp", async () => {
    const { app } = electronModule;
    closeToTray = false;
    app.quit();
    return { success: true };
  });

  console.log("[GlobalShortcut] IPC handlers registered");
}

/**
 * Cleanup on app quit
 */
function cleanup() {
  unregisterGlobalHotkey();
  destroyTray();

  if (trayPanelRefreshTimer) {
    clearInterval(trayPanelRefreshTimer);
    trayPanelRefreshTimer = null;
  }

  if (trayPanelWindow && !trayPanelWindow.isDestroyed()) {
    try {
      trayPanelWindow.destroy();
    } catch {
      // ignore
    }
    trayPanelWindow = null;
  }
}

module.exports = {
  init,
  registerHandlers,
  handleWindowClose,
  clearPendingFullscreenHide,
  cleanup,
};
