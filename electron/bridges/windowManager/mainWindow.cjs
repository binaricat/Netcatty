/* eslint-disable no-undef */
function createMainWindowApi(ctx) {
  with (ctx) {
    async function createWindow(electronModule, options) {
      const { BrowserWindow, nativeTheme, app, screen, shell } = electronModule;
      const {
        preload,
        devServerUrl,
        isDev,
        appIcon,
        isMac,
        onRegisterBridge,
        electronDir,
        route,
        registerAsMainWindow = true,
        persistWindowState = registerAsMainWindow,
        registerAsAppContentWindow = true,
      } = options;
      const rendererHash = typeof route === "string" && route.trim()
        ? `#/${route.trim().replace(/^#?\/*/, "")}`
        : "";
    
      // Store app reference for window state persistence
      electronApp = app;
    
      const osTheme = nativeTheme?.shouldUseDarkColors ? "dark" : "light";
      const effectiveTheme = currentTheme === "dark" || currentTheme === "light" ? currentTheme : osTheme;
      const frontendBackground = resolveFrontendBackgroundColor(electronDir || __dirname, effectiveTheme);
      const backgroundColor = frontendBackground || "#1a1a1a";
      const themeConfig = THEME_COLORS[effectiveTheme] || THEME_COLORS.light;
    
      // Load saved window state
      const savedState = persistWindowState ? loadWindowState() : null;
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
    
      if (registerAsMainWindow) {
        if (typeof registerMainWindow === "function") {
          registerMainWindow(win);
        } else {
          mainWindow = win;
        }
      } else if (registerAsAppContentWindow && typeof registerAppContentWindow === "function") {
        registerAppContentWindow(win);
      }
    
      // Clear reference when the main window is destroyed
      win.on('closed', () => {
        try {
          if (win?.webContents?.id) {
            unhealthyWebContentsIds.delete(win.webContents.id);
            rendererReadySeenByWebContentsId.delete(win.webContents.id);
          }
        } catch {
          // ignore
        }
        if (registerAsMainWindow) {
          if (typeof unregisterMainWindow === "function") {
            unregisterMainWindow(win);
          } else if (mainWindow === win) {
            mainWindow = null;
          }
        } else if (registerAsAppContentWindow && typeof unregisterAppContentWindow === "function") {
          unregisterAppContentWindow(win);
        }
      });
    
      // Log renderer crashes for diagnostics (skip normal clean exits)
      win.webContents.on("render-process-gone", (_event, details) => {
        if (details?.reason === "clean-exit") return;
        try {
          if (win.webContents?.id) {
            unhealthyWebContentsIds.add(win.webContents.id);
          }
        } catch {
          // ignore
        }
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
          const parsedUrl = new URL(String(targetUrl));
          if (parsedUrl.protocol === "app:" && parsedUrl.host === "netcatty") return true;
          return allowedOrigins.has(parsedUrl.origin);
        } catch {
          return false;
        }
      };
      win.webContents.on("did-start-navigation", (_event, targetUrl, isInPlace, isMainFrame) => {
        if (isMainFrame === false || isInPlace === true || !isAllowedTopLevelUrl(targetUrl)) return;
        try {
          if (typeof clearRendererReadyForWebContents === "function") {
            clearRendererReadyForWebContents(win.webContents?.id);
          }
        } catch {
          // ignore
        }
      });
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
      win.webContents.on("before-input-event", (event, input) => {
        if (isMac && shouldCloseWindowFromInput(input)) {
          event.preventDefault();
          requestWindowCommandClose(win);
          return;
        }

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
      let thisWindowCloseRequested = false;
      let dirtyEditorCloseConfirmed = false;
    
      const updateNormalBounds = () => {
        if (!win.isDestroyed() && !win.isMaximized() && !win.isFullScreen()) {
          lastNormalBounds = win.getBounds();
        }
      };
    
      const scheduleSaveState = () => {
        if (!persistWindowState) return;
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
    
      const queryDirtyEditorsBeforeClose = (event, { markCloseRequested = false } = {}) => {
        event.preventDefault();
        if (markCloseRequested) {
          thisWindowCloseRequested = true;
        }
        const dirtyEditorQuery = typeof queryDirtyEditors === "function"
          ? queryDirtyEditors(win.webContents, 5000, { ipcMain: electronModule.ipcMain })
          : false;
        Promise.resolve(dirtyEditorQuery)
          .then((hasDirty) => {
            if (hasDirty) {
              thisWindowCloseRequested = false;
              return;
            }
            dirtyEditorCloseConfirmed = true;
            try {
              win.close();
            } catch {
              // ignore
            }
          })
          .catch(() => {
            dirtyEditorCloseConfirmed = true;
            try {
              win.close();
            } catch {
              // ignore
            }
          });
      };

      // Save state when window is about to close
      win.on("close", (event) => {
        if (!registerAsMainWindow && registerAsAppContentWindow && !isQuitting && !dirtyEditorCloseConfirmed) {
          queryDirtyEditorsBeforeClose(event, { markCloseRequested: true });
          return;
        }

        // Check if close-to-tray is enabled
        const trackedMainWindowCount = typeof getMainWindowCount === "function" ? getMainWindowCount() : 1;
        if (registerAsMainWindow && trackedMainWindowCount <= 1 && !isQuitting && getGlobalShortcutBridge().handleWindowClose(event, win)) {
          // Window was hidden to tray - save state before returning
          if (saveStateTimer) clearTimeout(saveStateTimer);
          const state = persistWindowState ? getWindowBoundsState(win, lastNormalBounds) : null;
          if (state) saveWindowStateSync(state);
          hideSettingsWindow();
          return;
        }

        if (registerAsMainWindow && registerAsAppContentWindow && !isQuitting && !dirtyEditorCloseConfirmed) {
          queryDirtyEditorsBeforeClose(event);
          return;
        }
    
        if (thisWindowCloseRequested) {
          return;
        }
        thisWindowCloseRequested = true;
        if (saveStateTimer) clearTimeout(saveStateTimer);
        const state = persistWindowState ? getWindowBoundsState(win, lastNormalBounds) : null;
        if (pendingWindowStateWrite) {
          event.preventDefault();
          if (state) queuedWindowState = state;
          pendingWindowStateWrite
            .catch(() => {
              // ignore async write errors before closing
            })
            .finally(() => {
              const finalState = persistWindowState ? getWindowBoundsState(win, lastNormalBounds) : null;
              if (finalState) saveWindowStateSync(finalState);
              if (registerAsMainWindow) closeSettingsWindow();
              try {
                win.close();
              } catch {
                // ignore
              }
            });
          return;
        }
        if (state) saveWindowStateSync(state);
        if (registerAsMainWindow) closeSettingsWindow();
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

      win.on("show", () => {
        safeSend("netcatty:window:shown");
      });
    
      // Ensure native background matches frontend background, even before first paint.
      try {
        win.setBackgroundColor(backgroundColor);
      } catch {
        // ignore
      }

      applyWindowOpacityToWindow(win);
    
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
          const iconPath = resolveLiveAppIcon(appIcon);
          if (iconPath && childWindow.setIcon) childWindow.setIcon(iconPath);
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
        createAppWindowOpenHandler(shell, {
          backgroundColor,
          appIcon,
          getAppIcon: () => resolveLiveAppIcon(appIcon),
        })
      );
    
      // Register window control handlers
      registerWindowHandlers(electronModule.ipcMain, nativeTheme);
    
      // Register IPC handlers BEFORE loading any URL so the renderer never
      // calls a handler that hasn't been registered yet.
      onRegisterBridge?.(win);
    
      if (isDev) {
        try {
          await win.loadURL(`${getDevRendererBaseUrl(devServerUrl)}${rendererHash}`);
          win.webContents.openDevTools({ mode: "detach" });
          return win;
        } catch (e) {
          console.warn("Dev server not reachable, falling back to bundled dist.", e);
        }
      }
    
      // Production mode - load via custom protocol.
      await win.loadURL(`app://netcatty/index.html${rendererHash}`);
      return win;
    }

    return { createWindow };
  }
}

module.exports = { createMainWindowApi };
