const assert = require("node:assert/strict");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const { createMainWindowApi } = require("./mainWindow.cjs");
const tick = () => new Promise((resolve) => setImmediate(resolve));

for (const peer of [true, false]) {
  test(`${peer ? "peer session" : "main"} window keeps its renderer until detached ownership is released`, async () => {
    let finish;
    let ownsTabs = true;
    let ownerChecks = 0;
    let dirtyChecks = 0;
    class Window extends EventEmitter {
      constructor() {
        super(); this.destroyed = false;
        this.webContents = Object.assign(new EventEmitter(), { id: 71, isDestroyed: () => this.destroyed, setWindowOpenHandler() {}, openDevTools() {}, send() {} });
      }
      close() { const event = { prevented: false, preventDefault() { this.prevented = true; } }; this.emit("close", event); if (!event.prevented) { this.destroyed = true; this.emit("closed"); } }
      isDestroyed() { return this.destroyed; }
      isMaximized() { return false; }
      isFullScreen() { return false; }
      getBounds() { return { width: 1000, height: 700 }; }
      setBackgroundColor() {}
      loadURL() { return Promise.resolve(); }
    }
    const api = createMainWindowApi({
      mainWindow: null, electronApp: null, currentTheme: "light", isQuitting: false,
      pendingWindowStateWrite: null, queuedWindowState: null,
      DEFAULT_WINDOW_WIDTH: 1400, DEFAULT_WINDOW_HEIGHT: 900, MIN_WINDOW_WIDTH: 1100, MIN_WINDOW_HEIGHT: 640,
      V8_CACHE_OPTIONS: "code", THEME_COLORS: { light: {} },
      unhealthyWebContentsIds: new Set(), rendererReadySeenByWebContentsId: new Set(),
      __dirname, URL, require, console, setTimeout, clearTimeout,
      getGlobalShortcutBridge: () => ({ handleWindowClose: () => false }),
      getMainWindowCount: () => 1,
      debugLog() {}, resolveFrontendBackgroundColor() { return null; }, loadWindowState() { return null; },
      getDevRendererBaseUrl: (url) => url, getWindowBoundsState() { return null; },
      queueWindowStateSave() {}, saveWindowStateSync() {}, setupDeferredShow() {},
      createExternalOnlyWindowOpenHandler() { return {}; }, createAppWindowOpenHandler() { return {}; },
      attachOAuthLoadingOverlay() {}, registerWindowHandlers() {}, requestWindowCommandClose() {}, shouldCloseWindowFromInput() { return false; },
      registerMainWindow() {}, unregisterMainWindow() {}, registerAppContentWindow() {}, unregisterAppContentWindow() {},
      notifyAppContentWindowClosed() {}, applyWindowOpacityToWindow() {}, closeSettingsWindow() {}, hideSettingsWindow() {},
      hasEditorTabsForSource: () => ownsTabs,
      closeEditorTabsForSource: () => { ownerChecks++; return new Promise((resolve) => { finish = resolve; }); },
      queryDirtyEditors: async () => { dirtyChecks++; return false; },
    });
    const win = await api.createWindow({ BrowserWindow: Window, nativeTheme: {}, app: {}, screen: {}, shell: {}, ipcMain: {} }, {
      preload: "/tmp/preload.cjs", devServerUrl: "http://localhost:5173", isDev: true, isMac: true,
      electronDir: __dirname, route: peer ? "session-window" : undefined, registerAsMainWindow: !peer,
    });
    win.close(); win.close();
    assert.equal(ownerChecks, 1, "repeat close must share the ownership check");
    assert.equal(dirtyChecks, 0, "the short dirty query must not race a detached Save/Cancel prompt");
    assert.equal(win.destroyed, false);
    finish({ success: true, cancelled: true }); await tick();
    assert.equal(win.destroyed, false, "Cancel keeps the source save/dock renderer alive");
    assert.equal(dirtyChecks, 0);
    win.close();
    ownsTabs = false;
    finish({ success: true, cancelled: false }); await tick();
    assert.equal(dirtyChecks, 1);
    assert.equal(win.destroyed, true, "close proceeds only after all owned editors settled");
  });
}
