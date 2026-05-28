/* eslint-disable no-undef */
function createExternalWindowApi(ctx) {
  with (ctx) {
    const fallbackBrowserWindows = new Set();
    
    /**
     * Open a URL in a minimal in-app BrowserWindow. Used as a fallback when the
     * host OS cannot open the URL with the system browser (e.g. Tiny11 / Windows
     * with no default browser configured — error 0x483). The window is
     * intentionally stripped down:
     *   - no preload script (remote content must NEVER touch contextBridge)
     *   - sandboxed + contextIsolated renderer
     *   - a separate persisted session partition so cookies and storage do not
     *     leak into the main app session
     */
    function openFallbackBrowser(url, options = {}) {
      const { backgroundColor, appIcon } = options;
      const electron = require("electron");
      const { BrowserWindow, screen } = electron;
    
      // Size and center relative to the main window when possible.
      let bounds = { width: 1100, height: 740 };
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          const mainBounds = mainWindow.getBounds();
          const display = screen.getDisplayMatching(mainBounds);
          const area = display.workArea;
          const w = Math.min(1200, Math.round(area.width * 0.85));
          const h = Math.min(800, Math.round(area.height * 0.85));
          bounds = {
            width: w,
            height: h,
            x: Math.round(area.x + (area.width - w) / 2),
            y: Math.round(area.y + (area.height - h) / 2),
          };
        }
      } catch {
        // Fall through to default bounds.
      }
    
      const win = new BrowserWindow({
        ...bounds,
        title: url,
        backgroundColor: backgroundColor || THEME_COLORS[currentTheme]?.background,
        icon: appIcon,
        show: false,
        autoHideMenuBar: true,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
          // Isolated session so users' browsing does not mix with main app state.
          partition: "persist:netcatty-fallback-browser",
        },
      });
    
      fallbackBrowserWindows.add(win);
      win.on("closed", () => {
        fallbackBrowserWindows.delete(win);
      });
    
      // Reflect the loaded page title in the window bar; fall back to the URL.
      try {
        win.webContents.on("page-title-updated", (_event, title) => {
          try {
            win.setTitle(title || url);
          } catch {
            // ignore
          }
        });
      } catch {
        // ignore
      }
    
      // Popups inside the fallback browser: open them in another fallback window
      // rather than looping back through shell.openExternal (which is what
      // failed in the first place). These popups are fire-and-forget, so we
      // explicitly catch the `loaded` rejection to avoid unhandledRejection.
      try {
        win.webContents.setWindowOpenHandler((details) => {
          const targetUrl = details?.url;
          if (targetUrl && typeof targetUrl === "string" && /^https?:/i.test(targetUrl)) {
            try {
              const popup = openFallbackBrowser(targetUrl, { backgroundColor, appIcon });
              popup.loaded.catch((err) => {
                console.warn("[windowManager] fallback popup loadURL failed:", err?.message || err);
              });
            } catch (popupErr) {
              console.warn("[windowManager] fallback popup open failed:", popupErr?.message || popupErr);
            }
          }
          return { action: "deny" };
        });
      } catch {
        // ignore
      }
    
      // Minimal keyboard navigation: Alt+← / Alt+→ / Ctrl/Cmd+R.
      try {
        win.webContents.on("before-input-event", (_event, input) => {
          if (input.type !== "keyDown") return;
          try {
            const history = win.webContents.navigationHistory;
            if (input.alt && input.key === "ArrowLeft" && history?.canGoBack?.()) {
              history.goBack();
            } else if (input.alt && input.key === "ArrowRight" && history?.canGoForward?.()) {
              history.goForward();
            } else if ((input.control || input.meta) && typeof input.key === "string" && input.key.toLowerCase() === "r") {
              win.webContents.reload();
            }
          } catch {
            // ignore navigation errors
          }
        });
      } catch {
        // ignore
      }
    
      win.once("ready-to-show", () => {
        try {
          win.show();
        } catch {
          // ignore
        }
      });
    
      // Return the window together with its initial-load Promise. Callers that
      // care about whether the page actually loaded can await `loaded`; fire-
      // and-forget callers must still catch the rejection themselves to avoid
      // turning it into an unhandledRejection.
      const loaded = win.loadURL(url);
    
      return { window: win, loaded };
    }
    
    /**
     * Try to open a URL with the OS default browser via shell.openExternal; if
     * that fails (e.g. no default browser configured), fall back to the in-app
     * BrowserWindow. Resolves on success (either via system browser, or when
     * the in-app fallback window finishes its initial load). Throws on total
     * failure so callers that rely on rejection semantics (e.g. OAuth flows
     * waiting on a Promise.race) still abort cleanly when no browser path is
     * available.
     */
    async function tryOpenExternalWithFallback(shell, url, options = {}) {
      if (!url || typeof url !== "string" || !/^https?:/i.test(url)) {
        throw new Error("openExternal: invalid URL");
      }
      try {
        await shell?.openExternal?.(url);
        return;
      } catch (err) {
        const message = err?.message || String(err);
        console.warn("[windowManager] shell.openExternal failed, using in-app fallback:", message);
    
        let fallback;
        try {
          fallback = openFallbackBrowser(url, options);
        } catch (createErr) {
          console.warn("[windowManager] fallback browser creation failed:", createErr?.message || createErr);
          throw err instanceof Error ? err : new Error(message);
        }
    
        try {
          // Wait for the fallback window's initial load. If the URL is
          // unreachable or malformed, loadURL rejects — surface that as a real
          // failure so callers (e.g. OAuth flows) can cancel early instead of
          // waiting for a downstream timeout.
          await fallback.loaded;
          return;
        } catch (loadErr) {
          console.warn("[windowManager] fallback browser loadURL failed:", loadErr?.message || loadErr);
          try {
            if (fallback.window && !fallback.window.isDestroyed()) {
              fallback.window.close();
            }
          } catch {
            // ignore cleanup errors
          }
          throw err instanceof Error ? err : new Error(message);
        }
      }
    }
    
    function createExternalOnlyWindowOpenHandler(shell, options = {}) {
      return (details) => {
        const targetUrl = details?.url;
        if (targetUrl && typeof targetUrl === "string" && /^https?:/i.test(targetUrl)) {
          // Run async fallback path without blocking the window-open decision.
          tryOpenExternalWithFallback(shell, targetUrl, options).catch((err) => {
            console.warn("[windowManager] tryOpenExternalWithFallback threw:", err?.message || err);
          });
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
            // Allow ONLY the loopback OAuth callback page, and only while an
            // OAuth flow is actively prepared — the acceptable port matches
            // whatever oauthBridge just bound for this session.
            const isLoopback =
              u.hostname === "127.0.0.1" || u.hostname === "localhost";
            if (!isLoopback || u.pathname !== "/oauth/callback") return false;
            const activePort = oauthBridge.getActiveOAuthPort?.();
            return activePort != null && u.port === String(activePort);
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
          // Try system browser first, fall back to an in-app BrowserWindow when
          // the OS has no handler for the URL (see tryOpenExternalWithFallback).
          tryOpenExternalWithFallback(shell, targetUrl, { backgroundColor, appIcon }).catch((err) => {
            console.warn("[windowManager] tryOpenExternalWithFallback threw:", err?.message || err);
          });
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

    return {
      openFallbackBrowser,
      tryOpenExternalWithFallback,
      createExternalOnlyWindowOpenHandler,
      createAppWindowOpenHandler,
    };
  }
}

module.exports = { createExternalWindowApi };
