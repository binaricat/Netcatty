/* eslint-disable no-undef */

const { randomUUID } = require("node:crypto");

const crashLogBridge = require("../crashLogBridge.cjs");
const {
  isAttachPopupClosePrepared,
  registerAttachPopupAuthorization,
  releaseAttachPopupAuthorization,
  restoreAttachedSessionOutput,
} = require("../terminalAttachRestore.cjs");

const ATTACH_CLOSE_PREPARE_TIMEOUT_MS = 2000;

function createTerminalPopupWindowApi(ctx) {
  with (ctx) {
    const terminalPopupWindows = new Map();
    /** attachSessionId -> popupId for AI silent-session observe windows */
    const attachSessionPopups = new Map();

    function isLiveWindow(win) {
      return Boolean(win && typeof win.isDestroyed === "function" && !win.isDestroyed());
    }

    async function openTerminalPopupWindow(electronModule, options, payload) {
      const { BrowserWindow, shell } = electronModule;
      const { preload, devServerUrl, isDev, appIcon, isMac, electronDir, sourceWindow } = options;

      const attachSessionId = typeof payload?.attachSessionId === "string" && payload.attachSessionId
        ? payload.attachSessionId
        : null;
      const attachAuthorization = attachSessionId ? randomUUID() : null;
      if (attachSessionId) {
        const existingPopupId = attachSessionPopups.get(attachSessionId);
        const existing = existingPopupId ? terminalPopupWindows.get(existingPopupId) : null;
        if (existing && isLiveWindow(existing.win)) {
          try {
            showAndFocusWindow(existing.win);
          } catch {
            // ignore focus races
          }
          return { success: true, popupId: existingPopupId, reused: true };
        }
        if (existingPopupId) attachSessionPopups.delete(attachSessionId);
      }

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
      const popupId = String(payload?.popupId || randomUUID());
      if (terminalPopupWindows.has(popupId)) {
        throw new Error(`Terminal popup ID is already active: ${popupId}`);
      }

      crashLogBridge.captureDiagnostic("terminal-popup", "creating popup window", {
        popupId,
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
          backgroundThrottling: false,
          v8CacheOptions: V8_CACHE_OPTIONS,
        },
      });

      let lifecycleReleased = false;
      let closePreparationRequested = false;
      let closePreparationTimer = null;
      const releaseLifecycle = () => {
        if (lifecycleReleased) return;
        lifecycleReleased = true;
        if (closePreparationTimer) clearTimeout(closePreparationTimer);
        terminalPopupWindows.delete(popupId);
        if (attachSessionId && attachSessionPopups.get(attachSessionId) === popupId) {
          attachSessionPopups.delete(attachSessionId);
          // Window may be destroyed before React cleanup runs; always restore
          // the display route from the main-process lifecycle.
          try {
            restoreAttachedSessionOutput(attachSessionId);
          } catch (err) {
            crashLogBridge.captureError?.("terminal-popup", err, {
              popupId,
              attachSessionId,
              step: "restore attach output on close",
            });
          }
        }
        releaseAttachPopupAuthorization(attachAuthorization);
        unregisterAppContentWindow(win);
        notifyAppContentWindowClosed(win);
      };
      terminalPopupWindows.set(popupId, { releaseLifecycle, win });
      if (attachSessionId) {
        attachSessionPopups.set(attachSessionId, popupId);
        registerAttachPopupAuthorization(
          attachAuthorization,
          attachSessionId,
          win.webContents.id,
        );
      }
      registerAppContentWindow(win);
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

      win.on("close", (event) => {
        if (!attachSessionId || isAttachPopupClosePrepared(attachAuthorization)) return;
        event?.preventDefault?.();
        if (closePreparationRequested) return;
        closePreparationRequested = true;
        try {
          win.webContents.send("netcatty:terminal-popup:prepare-close", {
            sessionId: attachSessionId,
            authorization: attachAuthorization,
          });
        } catch {
          // Timeout below force-closes and restores the route.
        }
        closePreparationTimer = setTimeout(() => {
          closePreparationTimer = null;
          try {
            if (isLiveWindow(win)) win.destroy();
          } catch {
            releaseLifecycle();
          }
        }, ATTACH_CLOSE_PREPARE_TIMEOUT_MS);
      });
      win.on("closed", releaseLifecycle);

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
          if (attachSessionId) {
            restoreAttachedSessionOutput(attachSessionId);
          }
          try {
            if (isLiveWindow(win)) win.destroy();
          } catch {
            releaseLifecycle();
          }
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

      try {
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

        win.webContents.send("netcatty:window:terminalPopupConfig", {
          ...payload,
          popupId,
          ...(attachAuthorization ? { attachAuthorization } : {}),
        });
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
      } catch (error) {
        try {
          if (isLiveWindow(win)) {
            if (typeof win.destroy === "function") win.destroy();
            else win.close();
          }
        } catch {
          // Lifecycle cleanup below remains fail-safe if Electron cleanup throws.
        }
        releaseLifecycle();
        throw error;
      }
    }

    function closeTerminalPopupWindow(popupId) {
      const record = terminalPopupWindows.get(popupId);
      if (!record) return;
      if (!isLiveWindow(record.win)) {
        record.releaseLifecycle();
        return;
      }
      try {
        record.win.close();
      } catch {
        try {
          record.win.destroy?.();
        } catch {
          // The lifecycle registry must still be released below.
        } finally {
          record.releaseLifecycle();
        }
      }
    }

    return {
      openTerminalPopupWindow,
      closeTerminalPopupWindow,
    };
  }
}

module.exports = { createTerminalPopupWindowApi };
