/* eslint-disable no-undef */

const crashLogBridge = require("../crashLogBridge.cjs");

function createTerminalPopupWindowApi(ctx) {
  with (ctx) {
    const terminalPopupWindows = new Map();

    function isLiveWindow(win) {
      return Boolean(win && typeof win.isDestroyed === "function" && !win.isDestroyed());
    }

    async function openTerminalPopupWindow(electronModule, options, payload) {
      const { BrowserWindow, shell } = electronModule;
      const { preload, devServerUrl, isDev, appIcon, isMac, electronDir, sourceWindow } = options;

      const osTheme = electronModule?.nativeTheme?.shouldUseDarkColors ? "dark" : "light";
      const effectiveTheme = currentTheme === "dark" || currentTheme === "light" ? currentTheme : osTheme;
      const frontendBackground = resolveFrontendBackgroundColor(electronDir || __dirname, effectiveTheme);
      const backgroundColor = frontendBackground || "#1a1a1a";

      const popupWidth = 920;
      const popupHeight = 580;
      const { x: popupX, y: popupY } = resolveSettingsWindowBounds(electronModule, {
        sourceWindow: sourceWindow || mainWindow,
        settingsWidth: popupWidth,
        settingsHeight: popupHeight,
      });

      const title = typeof payload?.title === "string" && payload.title.trim()
        ? payload.title.trim()
        : "Terminal";

      crashLogBridge.captureDiagnostic("terminal-popup", "creating popup window", {
        popupId: payload?.popupId,
        title,
        isDev,
        popupX,
        popupY,
      });

      const win = new BrowserWindow({
        title,
        width: popupWidth,
        height: popupHeight,
        ...(popupX !== undefined && popupY !== undefined ? { x: popupX, y: popupY } : {}),
        minWidth: 480,
        minHeight: 320,
        backgroundColor,
        icon: appIcon,
        show: false,
        frame: false,
        ...(isMac ? { trafficLightPosition: { x: 12, y: 12 } } : {}),
        webPreferences: {
          preload,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
          v8CacheOptions: V8_CACHE_OPTIONS,
        },
      });

      const popupId = String(payload?.popupId || Date.now());
      terminalPopupWindows.set(popupId, win);
      crashLogBridge.captureDiagnostic("terminal-popup", "popup BrowserWindow created", {
        popupId,
        title,
        webContentsId: win.webContents?.id,
      });

      try {
        win.webContents?.setWindowOpenHandler?.(
          createExternalOnlyWindowOpenHandler(shell),
        );
      } catch {
        // ignore
      }

      win.on("closed", () => {
        terminalPopupWindows.delete(popupId);
      });

      try {
        win.webContents?.on?.("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
          console.warn("[TerminalPopup] Failed to load renderer", {
            popupId,
            errorCode,
            errorDescription,
            validatedURL,
          });
        });
        win.webContents?.on?.("render-process-gone", (_event, details) => {
          console.warn("[TerminalPopup] Renderer process gone", { popupId, details });
        });
        win.webContents?.on?.("console-message", (_event, level, message, line, sourceId) => {
          crashLogBridge.captureDiagnostic("terminal-popup-console", message, {
            popupId,
            level,
            line,
            sourceId,
          });
        });
      } catch {
        // ignore diagnostics wiring failures
      }

      win.on("page-title-updated", (e) => { e.preventDefault(); });

      try {
        win.setBackgroundColor(backgroundColor);
      } catch {
        // ignore
      }

      applyWindowOpacityToWindow(win);

      if (isMac) {
        try {
          win.setWindowButtonVisibility(true);
        } catch {
          // ignore
        }
        try {
          win.setWindowButtonPosition({ x: 12, y: 12 });
        } catch {
          // ignore
        }
      }

      const popupPath = "#/terminal-popup";

      if (isDev) {
        try {
          const baseUrl = getDevRendererBaseUrl(devServerUrl);
          crashLogBridge.captureDiagnostic("terminal-popup", "loading dev popup URL", {
            popupId,
            url: `${baseUrl}${popupPath}`,
          });
          await win.loadURL(`${baseUrl}${popupPath}`);
        } catch (e) {
          console.warn("[TerminalPopup] Dev server not reachable", e);
          crashLogBridge.captureError("terminal-popup", e, {
            popupId,
            step: "load dev popup URL",
          });
          await win.loadURL(`app://netcatty/index.html${popupPath}`);
        }
      } else {
        crashLogBridge.captureDiagnostic("terminal-popup", "loading packaged popup URL", {
          popupId,
          url: `app://netcatty/index.html${popupPath}`,
        });
        await win.loadURL(`app://netcatty/index.html${popupPath}`);
      }

      win.webContents.send("netcatty:window:terminalPopupConfig", { ...payload, popupId });
      crashLogBridge.captureDiagnostic("terminal-popup", "popup config delivered", {
        popupId,
        title,
      });
      showAndFocusWindow(win);
      crashLogBridge.captureDiagnostic("terminal-popup", "popup window shown", {
        popupId,
        title,
        visible: typeof win.isVisible === "function" ? win.isVisible() : undefined,
      });
      return { success: true, popupId };
    }

    function closeTerminalPopupWindow(popupId) {
      const win = terminalPopupWindows.get(popupId);
      if (isLiveWindow(win)) {
        try { win.close(); } catch { /* ignore */ }
      }
      terminalPopupWindows.delete(popupId);
    }

    return {
      openTerminalPopupWindow,
      closeTerminalPopupWindow,
    };
  }
}

module.exports = { createTerminalPopupWindowApi };
