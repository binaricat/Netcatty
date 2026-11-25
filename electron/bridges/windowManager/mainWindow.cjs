/* eslint-disable no-undef */
const {
  windowsFramelessContentChromeOptions,
} = require("./windowsWindowChrome.cjs");
const { attachDisplayRecovery } = require("./displayRecovery.cjs");
const perfTrace = require("../../perfTrace.cjs");
const { finalizeSessionLogs } = require("../sessionLogShutdown.cjs");

const TERMINAL_KEYBOARD_FOCUS = Symbol("netcattyTerminalKeyboardFocus");

// #3647: the layout minimum can be larger than the usable workspace on
// small laptops (e.g. 1366×768 at 125% Windows scaling leaves only ~1093×574
// logical px), which made those windows impossible to fit — let alone shrink.
// Keep the layout minimum on capable screens, but cap it so the window can
// always fit the display the window targets.
//
// The cap is half the work area, not the whole work area: macOS/Windows window
// tiling asks the app for a half-screen (or corner quarter-screen) cell, and
// the OS keeps the app's minimum size when that minimum is larger than the
// requested cell. The window then spills past the screen edge instead of
// stopping at the tile. Half the work area is the largest minimum that still
// lets every standard tiling cell fit.
//
// macOS keeps a margin around and between tiled windows by default (Settings →
// Desktop & Dock → Windows → "Tiled windows have margins", about 8px per side),
// so reserve a little more than that: the OS stretches the window to the cell
// when the minimum is smaller, and a minimum that is even a few pixels too wide
// would still hang past the screen edge.
const MIN_SIZE_TILE_FACTOR = 0.5;
const MIN_SIZE_TILE_MARGIN = 16;
const MIN_WINDOW_FLOOR_WIDTH = 320;
const MIN_WINDOW_FLOOR_HEIGHT = 240;

function pickTargetDisplay(screenModule, bounds) {
  if (!screenModule || typeof screenModule.getDisplayMatching !== "function") {
    return screenModule?.getPrimaryDisplay?.() || null;
  }
  try {
    return screenModule.getDisplayMatching(bounds) || screenModule.getPrimaryDisplay?.() || null;
  } catch {
    try {
      return screenModule.getPrimaryDisplay?.() || null;
    } catch {
      return null;
    }
  }
}

function minimumSizeForDisplay(display, minWidth, minHeight) {
  let effectiveWidth = minWidth;
  let effectiveHeight = minHeight;
  try {
    const workArea = display?.workArea;
    if (Number.isFinite(workArea?.width) && workArea.width > 0) {
      effectiveWidth = Math.min(
        effectiveWidth,
        Math.floor(workArea.width * MIN_SIZE_TILE_FACTOR) - MIN_SIZE_TILE_MARGIN,
      );
    }
    if (Number.isFinite(workArea?.height) && workArea.height > 0) {
      effectiveHeight = Math.min(
        effectiveHeight,
        Math.floor(workArea.height * MIN_SIZE_TILE_FACTOR) - MIN_SIZE_TILE_MARGIN,
      );
    }
  } catch {
    // screen unavailable (e.g. before app ready): keep the static minimums
  }
  return {
    width: Math.max(MIN_WINDOW_FLOOR_WIDTH, effectiveWidth),
    height: Math.max(MIN_WINDOW_FLOOR_HEIGHT, effectiveHeight),
  };
}

function resolveWindowMinimumSize(screenModule, minWidth, minHeight, bounds) {
  let display = null;
  try {
    // Size for the display the window actually lives on (saved position or
    // current placement), falling back to the primary display.
    display = bounds
      ? pickTargetDisplay(screenModule, bounds)
      : screenModule?.getPrimaryDisplay?.();
  } catch {
    // screen unavailable (e.g. before app ready): keep the static minimums
  }
  return minimumSizeForDisplay(display, minWidth, minHeight);
}

function isFiniteBounds(bounds) {
  return Boolean(
    bounds &&
    Number.isFinite(bounds.x) &&
    Number.isFinite(bounds.y) &&
    Number.isFinite(bounds.width) &&
    Number.isFinite(bounds.height) &&
    bounds.width > 0 &&
    bounds.height > 0
  );
}

function rectsIntersect(a, b) {
  return Boolean(
    isFiniteBounds(a) &&
    isFiniteBounds(b) &&
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

function intersectionArea(a, b) {
  if (!isFiniteBounds(a) || !isFiniteBounds(b)) return 0;
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

// The area a window may occupy on one display: the work area when Electron
// reports one (menu bar / dock / taskbar excluded), else the full display.
function displayPlacementArea(display) {
  if (isFiniteBounds(display?.workArea)) return display.workArea;
  if (isFiniteBounds(display?.bounds)) return display.bounds;
  return null;
}

function displayPlacementAreas(screenModule) {
  try {
    const areas = [];
    for (const display of screenModule?.getAllDisplays?.() || []) {
      const area = displayPlacementArea(display);
      if (area) areas.push(area);
    }
    return areas;
  } catch {
    return [];
  }
}

function pickDisplayForBounds(screenModule, bounds) {
  try {
    const displays = screenModule?.getAllDisplays?.() || [];
    if (displays.length > 0) {
      let best = null;
      let bestArea = 0;
      for (const display of displays) {
        const area = displayPlacementArea(display);
        if (!area) continue;
        const overlap = intersectionArea(bounds, area);
        if (overlap > bestArea) {
          best = display;
          bestArea = overlap;
        }
      }
      if (best) return best;
      // Fall back to full display bounds (e.g. a window overlapping only the
      // menu bar/taskbar region) before treating the screen as removed.
      for (const display of displays) {
        if (!isFiniteBounds(display?.bounds)) continue;
        const overlap = intersectionArea(bounds, display.bounds);
        if (overlap > bestArea) {
          best = display;
          bestArea = overlap;
        }
      }
      if (best) return best;
      // Saved bounds do not intersect any connected display (removed monitor):
      // fall back to primary instead of getDisplayMatching()'s nearest secondary.
      return screenModule?.getPrimaryDisplay?.() || null;
    }
    if (typeof screenModule?.getDisplayMatching === "function") {
      const matched = screenModule.getDisplayMatching(bounds);
      if (matched) {
        const matchedBounds = isFiniteBounds(matched?.bounds)
          ? matched.bounds
          : displayPlacementArea(matched);
        if (!matchedBounds || rectsIntersect(bounds, matchedBounds)) {
          return matched;
        }
      }
    }
    return screenModule?.getPrimaryDisplay?.() || null;
  } catch {
    try {
      return screenModule?.getPrimaryDisplay?.() || null;
    } catch {
      return null;
    }
  }
}

// Subtract `cut` from `rect`, returning the rectangles that remain.
function subtractRect(rect, cut) {
  if (!rectsIntersect(rect, cut)) return [rect];
  const overlapTop = Math.max(rect.y, cut.y);
  const overlapBottom = Math.min(rect.y + rect.height, cut.y + cut.height);
  const pieces = [];
  if (rect.y < cut.y) {
    pieces.push({ x: rect.x, y: rect.y, width: rect.width, height: cut.y - rect.y });
  }
  if (rect.y + rect.height > cut.y + cut.height) {
    pieces.push({
      x: rect.x,
      y: cut.y + cut.height,
      width: rect.width,
      height: rect.y + rect.height - (cut.y + cut.height),
    });
  }
  if (rect.x < cut.x) {
    pieces.push({
      x: rect.x,
      y: overlapTop,
      width: cut.x - rect.x,
      height: overlapBottom - overlapTop,
    });
  }
  if (rect.x + rect.width > cut.x + cut.width) {
    pieces.push({
      x: cut.x + cut.width,
      y: overlapTop,
      width: rect.x + rect.width - (cut.x + cut.width),
      height: overlapBottom - overlapTop,
    });
  }
  return pieces;
}

// True when every pixel of `bounds` sits on the work area of some display.
// A window spanning two adjacent monitors passes; a window hanging past the
// outer edge (or into the gap between offset monitors) does not.
function isBoundsCoveredByAreas(bounds, areas) {
  let uncovered = [bounds];
  for (const area of areas) {
    const next = [];
    for (const rect of uncovered) next.push(...subtractRect(rect, area));
    uncovered = next;
    if (!uncovered.length) return true;
  }
  return uncovered.length === 0;
}

/**
 * Resolve the bounds the main window starts with.
 *
 * Initial normal bounds only: live display recovery and manual placement keep
 * their existing lifecycle. Electron screen coordinates are already DIPs.
 *
 * Saved bounds are honored when they are fully on screen (including windows
 * that intentionally span adjacent displays). When the saved rectangle hangs
 * past a screen edge — a larger display was unplugged, the display layout
 * changed, or a tiled placement was persisted — it is capped to the display's
 * work area and moved back inside, so no part of the window starts off screen.
 */
function resolveStartupBounds(screenModule, savedState, defaults, minWidth, minHeight) {
  const hasSavedPosition = Boolean(
    savedState &&
    Number.isFinite(savedState.x) &&
    Number.isFinite(savedState.y)
  );
  const savedPosition = hasSavedPosition
    ? { x: savedState.x, y: savedState.y }
    : null;
  const intendedWidth = Number.isFinite(savedState?.width) && savedState.width > 0
    ? savedState.width
    : defaults.width;
  const intendedHeight = Number.isFinite(savedState?.height) && savedState.height > 0
    ? savedState.height
    : defaults.height;
  const savedRect = hasSavedPosition
    ? { x: savedState.x, y: savedState.y, width: intendedWidth, height: intendedHeight }
    : null;

  let display = null;
  try {
    display = savedRect
      ? pickDisplayForBounds(screenModule, savedRect)
      : screenModule?.getPrimaryDisplay?.() || null;
  } catch {
    // Keep static sizes when Electron cannot supply a display.
  }

  const minimum = minimumSizeForDisplay(display, minWidth, minHeight);
  let width = Math.max(minimum.width, intendedWidth);
  let height = Math.max(minimum.height, intendedHeight);
  const areas = displayPlacementAreas(screenModule);

  if (!savedPosition) {
    // No usable position: let Electron center the window, but never start
    // larger than the display it targets.
    const area = displayPlacementArea(display);
    const maxWidth = area?.width ?? (Number.isFinite(display?.workArea?.width) && display.workArea.width > 0 ? display.workArea.width : null);
    const maxHeight = area?.height ?? (Number.isFinite(display?.workArea?.height) && display.workArea.height > 0 ? display.workArea.height : null);
    if (maxWidth) {
      width = Math.max(minimum.width, Math.min(width, maxWidth));
    }
    if (maxHeight) {
      height = Math.max(minimum.height, Math.min(height, maxHeight));
    }
    return { bounds: { width, height }, minimum };
  }

  const candidate = { x: savedPosition.x, y: savedPosition.y, width, height };
  if (!areas.length || isBoundsCoveredByAreas(candidate, areas)) {
    return { bounds: candidate, minimum };
  }

  // Part of the saved rectangle is off screen. Fit it into the display it
  // overlaps most (or primary when the previous display was removed),
  // preserving the size when the work area can hold it.
  const target = pickDisplayForBounds(screenModule, candidate) || display;
  const targetMinimum = target && target !== display
    ? minimumSizeForDisplay(target, minWidth, minHeight)
    : minimum;
  const area = displayPlacementArea(target);
  if (!area) return { bounds: { width, height }, minimum: targetMinimum };
  width = Math.max(targetMinimum.width, Math.min(Math.max(targetMinimum.width, intendedWidth), area.width));
  height = Math.max(targetMinimum.height, Math.min(Math.max(targetMinimum.height, intendedHeight), area.height));
  const x = Math.max(area.x, Math.min(savedPosition.x, area.x + area.width - width));
  const y = Math.max(area.y, Math.min(savedPosition.y, area.y + area.height - height));
  return { bounds: { x, y, width, height }, minimum: targetMinimum };
}

// Keep the BrowserWindow minimum in sync with the display it currently lives
// on: docking, unplugging a screen, or display-scaling changes can move the
// window onto a display with a different work area.
function attachDisplayMinimumSync({ win, screen: screenModule, minWidth, minHeight }) {
  if (!win || !screenModule || typeof screenModule.on !== "function") return () => {};

  const applyMinimumForCurrentDisplay = () => {
    try {
      if (win.isDestroyed?.()) return;
      const next = resolveWindowMinimumSize(screenModule, minWidth, minHeight, win.getBounds());
      const [currentWidth, currentHeight] = win.getMinimumSize?.() || [];
      if (next.width === currentWidth && next.height === currentHeight) return;
      win.setMinimumSize(next.width, next.height);
    } catch {
      // Best-effort only.
    }
  };

  const onDisplayMetricsChanged = () => applyMinimumForCurrentDisplay();
  const onDisplayRemoved = () => applyMinimumForCurrentDisplay();
  const onWindowMoved = () => applyMinimumForCurrentDisplay();
  try {
    screenModule.on("display-metrics-changed", onDisplayMetricsChanged);
    screenModule.on("display-removed", onDisplayRemoved);
    win.on("move", onWindowMoved);
  } catch {
    try {
      win.removeListener?.("move", onWindowMoved);
    } catch {
      // ignore
    }
    return () => {};
  }
  return function detachDisplayMinimumSync() {
    try {
      screenModule.removeListener?.("display-metrics-changed", onDisplayMetricsChanged);
      screenModule.removeListener?.("display-removed", onDisplayRemoved);
    } catch {
      // ignore
    }
    try {
      win.removeListener?.("move", onWindowMoved);
    } catch {
      // ignore
    }
  };
}

function setTerminalKeyboardFocusForWindow(win, focused) {
  if (!win || win.isDestroyed?.() || !win.webContents) return false;
  const isFocused = focused === true;
  try {
    win[TERMINAL_KEYBOARD_FOCUS] = isFocused;
    win.webContents.setIgnoreMenuShortcuts?.(isFocused);
    return true;
  } catch {
    return false;
  }
}

function hasTerminalKeyboardFocus(win) {
  return win?.[TERMINAL_KEYBOARD_FOCUS] === true;
}

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
        onAppContentWindowClosed,
        registerAsMainWindow = true,
        persistWindowState = registerAsMainWindow,
        registerAsAppContentWindow = true,
        startHidden = false,
      } = options;
      const rendererHash = typeof route === "string" && route.trim()
        ? `#/${route.trim().replace(/^#?\/*/, "")}`
        : "";
      const CHROMIUM_ZOOM_FACTORS = [
        0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5,
      ];

      const isPrimaryZoomInEqualInput = (input) => {
        if (input?.type !== "keyDown") return false;
        if (input.alt) return false;
        const hasPrimaryModifier = isMac
          ? Boolean(input.meta) && !input.control
          : Boolean(input.control) && !input.meta;
        if (!hasPrimaryModifier || input.shift) return false;
        return String(input.key || "") === "=";
      };

      const isPrimaryZoomOutMinusInput = (input) => {
        if (input?.type !== "keyDown") return false;
        if (input.alt) return false;
        const hasPrimaryModifier = isMac
          ? Boolean(input.meta) && !input.control
          : Boolean(input.control) && !input.meta;
        if (!hasPrimaryModifier || input.shift) return false;
        return String(input.key || "") === "-";
      };

      const isPrimaryResetZoomInput = (input) => {
        if (input?.type !== "keyDown") return false;
        if (input.alt) return false;
        const hasPrimaryModifier = isMac
          ? Boolean(input.meta) && !input.control
          : Boolean(input.control) && !input.meta;
        if (!hasPrimaryModifier || input.shift) return false;
        return String(input.key || "") === "0";
      };

      const adjustWindowZoom = (mode) => {
        const webContents = win?.webContents;
        if (!webContents || webContents.isDestroyed?.()) return false;
        const currentFactor = Number(webContents.getZoomFactor?.());
        const safeCurrentFactor = Number.isFinite(currentFactor) ? currentFactor : 1;
        const nextFactor = mode === "in"
          ? CHROMIUM_ZOOM_FACTORS.find((factor) => factor > safeCurrentFactor + 0.0001)
          : mode === "out"
            ? [...CHROMIUM_ZOOM_FACTORS].reverse().find((factor) => factor < safeCurrentFactor - 0.0001)
            : 1;
        if (!nextFactor) return false;
        try {
          webContents.setZoomFactor?.(nextFactor);
          return true;
        } catch {
          return false;
        }
      };
    
      // Store app reference for window state persistence
      electronApp = app;
    
      const osTheme = nativeTheme?.shouldUseDarkColors ? "dark" : "light";
      const effectiveTheme = currentTheme === "dark" || currentTheme === "light" ? currentTheme : osTheme;
      const frontendBackground = resolveFrontendBackgroundColor(electronDir || __dirname, effectiveTheme);
      const backgroundColor = frontendBackground || "#1a1a1a";
      const themeConfig = THEME_COLORS[effectiveTheme] || THEME_COLORS.light;
    
      // Load saved window state and fit it to the display it will open on.
      // Saved bounds that hang past a screen edge are pulled back inside;
      // bounds that are fully on screen (including a window spanning adjacent
      // displays) are restored as the user left them.
      const savedState = persistWindowState ? loadWindowState() : null;
      const { bounds: windowBounds, minimum: windowMinimumSize } = resolveStartupBounds(
        screen,
        savedState,
        { width: DEFAULT_WINDOW_WIDTH, height: DEFAULT_WINDOW_HEIGHT },
        MIN_WINDOW_WIDTH,
        MIN_WINDOW_HEIGHT,
      );

      const windowsChrome = !isMac ? windowsFramelessContentChromeOptions() : {};

      perfTrace.mark("main:create-window");
      const win = new BrowserWindow({
        ...windowBounds,
        minWidth: windowMinimumSize.width,
        minHeight: windowMinimumSize.height,
        backgroundColor,
        transparent: isMac,
        icon: appIcon,
        show: false,
        frame: isMac,
        titleBarStyle: isMac ? "hiddenInset" : undefined,
        trafficLightPosition: isMac ? { x: 12, y: 12 } : undefined,
        ...(isMac ? { visualEffectState: "active" } : {}),
        ...windowsChrome,
        webPreferences: {
          preload,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
          spellcheck: false,
          backgroundThrottling: false,
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
        registerAppContentWindow(win, { queryDirtyEditors: true });
      }
    
      // Multi-monitor recovery (#3244): Windows lock/sleep can temporarily
      // tear down a secondary display and the OS relocates the window onto
      // the primary display. When the display comes back, put the window back
      // where the user left it.
      let detachDisplayRecovery = null;
      try {
        detachDisplayRecovery = attachDisplayRecovery({ win, screen });
      } catch {
        detachDisplayRecovery = null;
      }

      // #3647: docking / display-scaling changes can move the window onto a
      // display with a different work area; keep the minimum in sync so the
      // window can always fit its current display.
      const detachDisplayMinimumSync = attachDisplayMinimumSync({
        win,
        screen,
        // Pass the configured (layout) minimum as the baseline, not the
        // display-fitted value resolved above: otherwise a reduced minimum
        // would become a permanent ceiling and could never grow back to
        // MIN_WINDOW_WIDTH × MIN_WINDOW_HEIGHT on a larger display.
        minWidth: MIN_WINDOW_WIDTH,
        minHeight: MIN_WINDOW_HEIGHT,
      });

      // Clear reference when the main window is destroyed
      win.on('closed', () => {
        try {
          detachDisplayRecovery?.();
        } catch {
          // ignore
        }
        try {
          detachDisplayMinimumSync?.();
        } catch {
          // ignore
        }
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
        if (registerAsAppContentWindow) {
          try {
            if (typeof notifyAppContentWindowClosed === "function") {
              notifyAppContentWindowClosed(win);
            } else {
              onAppContentWindowClosed?.(win);
            }
          } catch {
            // The application-level close fallback must not disrupt teardown.
          }
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

        const isTerminalFontShortcut =
          isPrimaryZoomInEqualInput(input)
          || isPrimaryZoomOutMinusInput(input)
          || isPrimaryResetZoomInput(input);
        if (hasTerminalKeyboardFocus(win) && isTerminalFontShortcut) {
          win.webContents.setIgnoreMenuShortcuts(true);
          return;
        }

        if (isPrimaryZoomInEqualInput(input) && adjustWindowZoom("in")) {
          event.preventDefault();
          return;
        }

        if (isPrimaryZoomOutMinusInput(input) && adjustWindowZoom("out")) {
          event.preventDefault();
          return;
        }

        if (isPrimaryResetZoomInput(input) && adjustWindowZoom("reset")) {
          event.preventDefault();
          return;
        }

        if (input.alt && !input.control && !input.meta) {
          // Keep Alt+M pane zoom and shortcut recording clear of the Minimize menu mnemonic.
          if (input.key === "ArrowLeft" || input.key === "ArrowRight" || input.key === "m" || input.key === "M") {
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
      let editorCloseCheckPending = false;
    
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
        if (editorCloseCheckPending) return;
        editorCloseCheckPending = true;
        if (markCloseRequested) {
          thisWindowCloseRequested = true;
        }
        const dirtyEditorQuery = (async () => {
          // A detached editor still uses this renderer's SFTP save/dock route.
          // Run its existing Save/Discard/Cancel flow before destroying the owner.
          if (typeof closeEditorTabsForSource === "function") {
            const result = await closeEditorTabsForSource(electronModule, win.webContents);
            if (!result.success || result.cancelled) return true;
          }
          return typeof queryDirtyEditors === "function"
            ? queryDirtyEditors(win.webContents, 5000, { ipcMain: electronModule.ipcMain })
            : false;
        })();
        Promise.resolve(dirtyEditorQuery)
          .then(async (hasDirty) => {
            if (hasDirty) {
              thisWindowCloseRequested = false;
              return;
            }
            await finalizeSessionLogs(win.webContents, { ipcMain: electronModule.ipcMain });
            dirtyEditorCloseConfirmed = true;
            try {
              win.close();
            } catch {
              // ignore
            }
          })
          .catch(() => {
            // A failed ownership check must keep the source save route alive.
            thisWindowCloseRequested = false;
          })
          .finally(() => { editorCloseCheckPending = false; });
      };

      // Save state when window is about to close
      win.on("close", (event) => {
        // Recheck if another editor was opened while the local dirty query ran.
        if (typeof hasEditorTabsForSource === "function" && hasEditorTabsForSource(win.webContents)) {
          dirtyEditorCloseConfirmed = false;
        }
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
        if (startHidden) {
          // The hidden-launch tray pin exists so a --hidden cold start is
          // never a windowless, trayless zombie; once this window is
          // actually visible that concern no longer applies, so hand tray
          // lifetime back to the user's normal close-to-tray preference.
          try {
            getGlobalShortcutBridge().releaseHiddenLaunchTrayPin?.();
          } catch (err) {
            console.warn("[MainWindow] Failed to release hidden-launch tray pin:", err?.message || err);
          }
        }
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
      setupDeferredShow(win, { timeoutMs: isDev ? 3000 : 1500, startHidden });
    
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
      perfTrace.mark("main:register-bridges:start");
      onRegisterBridge?.(win);
      perfTrace.mark("main:register-bridges:end");

      if (startHidden) {
        // Belt-and-suspenders: guarantee a tray icon exists as soon as
        // bridges (and electronModule) are ready, and keep it pinned
        // (independent of the user's separate close-to-tray preference)
        // until this window is actually shown — see releaseHiddenLaunchTrayPin
        // in the "show" handler below.
        try {
          getGlobalShortcutBridge().pinTrayForHiddenLaunch?.();
        } catch (err) {
          console.warn("[MainWindow] Failed to create tray for hidden launch:", err?.message || err);
        }
      }

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
      if (perfTrace.isEnabled()) {
        win.webContents.once("did-finish-load", () => perfTrace.mark("main:did-finish-load"));
      }
      perfTrace.mark("main:load-url");
      await win.loadURL(`app://netcatty/index.html${rendererHash}`);
      return win;
    }

    return { createWindow };
  }
}

module.exports = {
  attachDisplayMinimumSync,
  createMainWindowApi,
  resolveStartupBounds,
  resolveWindowMinimumSize,
  setTerminalKeyboardFocusForWindow,
};
