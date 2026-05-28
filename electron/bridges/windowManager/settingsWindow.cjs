/* eslint-disable no-undef */
function createSettingsWindowApi(ctx) {
  // The extracted window helpers intentionally share the parent window-manager state.
  with (ctx) {
    function restoreWindowInputFocus(win, options = {}) {
      if (!win || win.isDestroyed()) return false;
      const shouldShow = options.show === true;
      const platform = options.platform || process.platform;
    
      if (shouldShow) {
        try {
          win.show();
        } catch {
          // ignore
        }
      }
    
      if (platform === "win32") {
        try {
          win.setAlwaysOnTop(true);
        } catch {
          // ignore
        }
        try {
          win.focus();
        } catch {
          // ignore
        } finally {
          try {
            win.setAlwaysOnTop(false);
          } catch {
            // ignore
          }
        }
      } else {
        try {
          win.focus();
        } catch {
          // ignore
        }
      }
    
      try {
        if (win.webContents && !win.webContents.isDestroyed()) {
          win.webContents.focus();
        }
      } catch {
        // ignore
      }
      return true;
    }
    
    function showAndFocusWindow(win) {
      restoreWindowInputFocus(win, { show: true });
    }
    
    function isLiveWindow(win) {
      return Boolean(win && typeof win.isDestroyed === "function" && !win.isDestroyed());
    }
    
    function resolveSettingsWindowBounds(
      electronModule,
      { sourceWindow, settingsWidth, settingsHeight } = {},
    ) {
      const { screen } = electronModule || {};
      if (!screen || !isLiveWindow(sourceWindow)) return {};
    
      try {
        const sourceBounds = sourceWindow.getBounds();
        const display = screen.getDisplayMatching(sourceBounds);
        const { x: dx, y: dy, width: dw, height: dh } = display.workArea;
        return {
          x: Math.round(dx + (dw - settingsWidth) / 2),
          y: Math.round(dy + (dh - settingsHeight) / 2),
        };
      } catch {
        return {};
      }
    }
    
    function centerSettingsWindowOnSourceDisplay(win, electronModule, sourceWindow) {
      if (!isLiveWindow(win)) return;
      let bounds = { width: 980, height: 720 };
      try {
        bounds = win.getBounds();
      } catch {
        // keep defaults
      }
      const nextPosition = resolveSettingsWindowBounds(electronModule, {
        sourceWindow,
        settingsWidth: bounds.width,
        settingsHeight: bounds.height,
      });
      if (nextPosition.x === undefined || nextPosition.y === undefined) return;
      try {
        win.setPosition(nextPosition.x, nextPosition.y);
      } catch {
        // ignore
      }
    }
    
    async function openSettingsWindow(electronModule, options, { showOnLoad = true } = {}) {
      const { BrowserWindow, shell } = electronModule;
      const { preload, devServerUrl, isDev, appIcon, isMac, electronDir, sourceWindow } = options;
    
      // If settings window already exists, show and focus it
      if (settingsWindow && !settingsWindow.isDestroyed()) {
        centerSettingsWindowOnSourceDisplay(settingsWindow, electronModule, sourceWindow || mainWindow);
        showAndFocusWindow(settingsWindow);
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
      const { x: settingsX, y: settingsY } = resolveSettingsWindowBounds(electronModule, {
        sourceWindow: sourceWindow || mainWindow,
        settingsWidth,
        settingsHeight,
      });
    
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
          if (showOnLoad) { showAndFocusWindow(win); }
          return win;
        } catch (e) {
          console.warn("Dev server not reachable for settings window", e);
        }
      }
    
      // Production mode - load via custom protocol.
      await win.loadURL("app://netcatty/index.html#/settings");
      if (showOnLoad) { showAndFocusWindow(win); }
    
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

    return {
      restoreWindowInputFocus,
      showAndFocusWindow,
      isLiveWindow,
      resolveSettingsWindowBounds,
      centerSettingsWindowOnSourceDisplay,
      openSettingsWindow,
      closeSettingsWindow,
      hideSettingsWindow,
      prewarmSettingsWindow,
    };
  }
}

module.exports = { createSettingsWindowApi };
