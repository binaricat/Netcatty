const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveWindowMinimumSize, attachDisplayMinimumSync } = require("./mainWindow.cjs");

test("caps the minimum at half the work area so tiling cells fit", () => {
  const size = resolveWindowMinimumSize(
    { getPrimaryDisplay: () => ({ workArea: { width: 1920, height: 1080 } }) },
    1100,
    640,
  );
  assert.deepEqual(size, { width: 944, height: 524 });
});

test("caps the minimum for the display containing the target bounds", () => {
  const primary = { workArea: { width: 1920, height: 1080 } };
  const secondary = { workArea: { width: 1093, height: 585 } };
  const size = resolveWindowMinimumSize(
    {
      getPrimaryDisplay: () => primary,
      getDisplayMatching: (bounds) => (bounds.x > 1920 ? secondary : primary),
    },
    1100,
    640,
    { x: 2000, y: 0, width: 1000, height: 700 },
  );
  assert.deepEqual(size, { width: Math.floor(1093 / 2) - 16, height: Math.floor(585 / 2) - 16 });
});

test("falls back to the primary display when the target cannot be matched", () => {
  const size = resolveWindowMinimumSize(
    {
      getPrimaryDisplay: () => ({ workArea: { width: 1093, height: 585 } }),
      getDisplayMatching: () => null,
    },
    1100,
    640,
    { x: 0, y: 0, width: 1000, height: 700 },
  );
  assert.deepEqual(size, { width: Math.floor(1093 / 2) - 16, height: Math.floor(585 / 2) - 16 });
});

test("refreshes the window minimum when display metrics change", () => {
  const { EventEmitter } = require("node:events");
  const screenModule = new EventEmitter();
  screenModule.getPrimaryDisplay = () => ({ workArea: { width: 1920, height: 1080 } });
  const win = new EventEmitter();
  win.isDestroyed = () => false;
  win.getBounds = () => ({ x: 0, y: 0, width: 1100, height: 640 });
  let minimum = { width: 1100, height: 640 };
  win.getMinimumSize = () => [minimum.width, minimum.height];
  win.setMinimumSize = (width, height) => { minimum = { width, height }; };

  const detach = attachDisplayMinimumSync({ win, screen: screenModule, minWidth: 1100, minHeight: 640 });
  try {
    // Docking change shrinks the primary work area under the window.
    screenModule.getPrimaryDisplay = () => ({ workArea: { width: 1093, height: 585 } });
    screenModule.emit("display-metrics-changed");
    assert.deepEqual(minimum, { width: Math.floor(1093 / 2) - 16, height: Math.floor(585 / 2) - 16 });

    // No-op emission keeps the same minimum.
    screenModule.emit("display-metrics-changed");
    assert.deepEqual(minimum, { width: Math.floor(1093 / 2) - 16, height: Math.floor(585 / 2) - 16 });
  } finally {
    detach();
  }
});

test("ignores display events after detach", () => {
  const { EventEmitter } = require("node:events");
  const screenModule = new EventEmitter();
  const win = new EventEmitter();
  win.isDestroyed = () => false;
  win.getBounds = () => ({ x: 0, y: 0, width: 1100, height: 640 });
  win.getMinimumSize = () => [1100, 640];
  let called = 0;
  win.setMinimumSize = () => { called += 1; };

  const detach = attachDisplayMinimumSync({ win, screen: screenModule, minWidth: 1100, minHeight: 640 });
  detach();
  screenModule.emit("display-metrics-changed");
  screenModule.emit("display-removed");
  assert.equal(called, 0);
});

test("shrinks the minimum to fit a small primary work area (#3647)", () => {
  // 1366×768 at 125% Windows scaling leaves ~1093×585 logical px of work area.
  const size = resolveWindowMinimumSize(
    { getPrimaryDisplay: () => ({ workArea: { width: 1093, height: 585 } }) },
    1100,
    640,
  );
  assert.equal(size.width, Math.floor(1093 / 2) - 16);
  assert.equal(size.height, Math.floor(585 / 2) - 16);
  assert.ok(size.width < 1100 && size.height < 640);
});

test("never shrinks below a small usable floor", () => {
  const size = resolveWindowMinimumSize(
    { getPrimaryDisplay: () => ({ workArea: { width: 300, height: 200 } }) },
    1100,
    640,
  );
  assert.deepEqual(size, { width: 320, height: 240 });
});

test("keeps the static minimums when screen is unavailable", () => {
  assert.deepEqual(resolveWindowMinimumSize(null, 1100, 640), { width: 1100, height: 640 });
  assert.deepEqual(resolveWindowMinimumSize({}, 1100, 640), { width: 1100, height: 640 });
  assert.deepEqual(
    resolveWindowMinimumSize(
      { getPrimaryDisplay: () => { throw new Error("screen not ready"); } },
      1100,
      640,
    ),
    { width: 1100, height: 640 },
  );
});

test("createWindow clamps saved bounds and BrowserWindow minima to the fitted size", async () => {
  const { EventEmitter } = require("node:events");
  const { createMainWindowApi } = require("./mainWindow.cjs");

  let constructedOptions = null;
  class Window extends EventEmitter {
    constructor(options) {
      super();
      constructedOptions = options;
      this.destroyed = false;
      this.webContents = Object.assign(new EventEmitter(), {
        id: 71,
        isDestroyed: () => this.destroyed,
        setWindowOpenHandler() {},
        openDevTools() {},
        send() {},
      });
    }
    close() {}
    isDestroyed() { return this.destroyed; }
    isMaximized() { return false; }
    isFullScreen() { return false; }
    getBounds() { return { width: 1000, height: 700 }; }
    setBackgroundColor() {}
    loadURL() { return Promise.resolve(); }
  }

  const api = createMainWindowApi({
    mainWindow: null, electronApp: null, currentTheme: "light", isQuitting: false,
    pendingWindowStateWrite: null, queuedWindowState: null, windowStateCloseRequested: false,
    DEFAULT_WINDOW_WIDTH: 1400, DEFAULT_WINDOW_HEIGHT: 900, MIN_WINDOW_WIDTH: 1100, MIN_WINDOW_HEIGHT: 640,
    V8_CACHE_OPTIONS: "code", THEME_COLORS: { light: {} },
    unhealthyWebContentsIds: new Set(), rendererReadySeenByWebContentsId: new Set(),
    __dirname, URL, require, console, setTimeout, clearTimeout,
    getGlobalShortcutBridge: () => ({ handleWindowClose: () => false }),
    getMainWindowCount: () => 1,
    debugLog() {}, resolveFrontendBackgroundColor() { return null; },
    loadWindowState() { return { width: 980, height: 560, x: 0, y: 0 }; },
    getDevRendererBaseUrl: (url) => url, getWindowBoundsState() { return null; },
    queueWindowStateSave() {}, saveWindowStateSync() {}, setupDeferredShow() {},
    createExternalOnlyWindowOpenHandler() { return {}; }, createAppWindowOpenHandler() { return {}; },
    attachOAuthLoadingOverlay() {}, registerWindowHandlers() {}, requestWindowCommandClose() {},
    shouldCloseWindowFromInput() { return false; },
    registerMainWindow() {}, unregisterMainWindow() {}, registerAppContentWindow() {}, unregisterAppContentWindow() {},
    closeSettingsWindow() {}, hideSettingsWindow() {}, applyWindowOpacityToWindow() {},
  });

  await api.createWindow(
    {
      BrowserWindow: Window,
      nativeTheme: {},
      app: {},
      screen: {
        getPrimaryDisplay: () => ({ workArea: { width: 1093, height: 585 } }),
        getAllDisplays: () => [],
      },
      shell: {},
      ipcMain: {},
    },
    {
      preload: "/tmp/preload.cjs",
      devServerUrl: "http://localhost:5173",
      isDev: true,
      appIcon: null,
      isMac: true,
      electronDir: __dirname,
    },
  );

  assert.ok(constructedOptions);
  assert.equal(constructedOptions.minWidth, Math.floor(1093 / 2) - 16);
  assert.equal(constructedOptions.minHeight, Math.floor(585 / 2) - 16);
  assert.equal(constructedOptions.width, Math.max(980, Math.floor(1093 / 2) - 16));
  assert.equal(constructedOptions.height, Math.max(560, Math.floor(585 / 2) - 16));
});
