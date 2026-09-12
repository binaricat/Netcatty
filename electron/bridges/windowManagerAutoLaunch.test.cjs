const test = require("node:test");
const assert = require("node:assert/strict");

const { createMainWindowApi } = require("./windowManager/mainWindow.cjs");

class BrowserWindowStub {
  constructor() {
    this._listeners = new Map();
    this.webContents = {
      id: 1,
      on() {},
      once() {},
      isDestroyed() {
        return false;
      },
      isCrashed() {
        return false;
      },
      setIgnoreMenuShortcuts() {},
      setWindowOpenHandler() {},
      openDevTools() {},
      getZoomFactor() {
        return 1;
      },
      setZoomFactor() {},
    };
  }

  on(event, handler) {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event).push(handler);
  }

  once() {}
  isDestroyed() { return false; }
  isMaximized() { return false; }
  isFullScreen() { return false; }
  getBounds() { return { x: 0, y: 0, width: 1400, height: 900 }; }
  setBackgroundColor() {}
  setOpacity() {}
  async loadURL() {}
  close() {}

  /** Test helper: fire a registered event listener, e.g. simulating win.show(). */
  emit(event) {
    for (const handler of this._listeners.get(event) || []) handler();
  }
}

function createApi({ setupDeferredShow, getGlobalShortcutBridge } = {}) {
  return createMainWindowApi({
    mainWindow: null,
    electronApp: null,
    currentTheme: "light",
    isQuitting: false,
    pendingWindowStateWrite: null,
    queuedWindowState: null,
    windowStateCloseRequested: false,
    DEFAULT_WINDOW_WIDTH: 1400,
    DEFAULT_WINDOW_HEIGHT: 900,
    MIN_WINDOW_WIDTH: 1100,
    MIN_WINDOW_HEIGHT: 640,
    V8_CACHE_OPTIONS: "bypassHeatCheck",
    THEME_COLORS: { light: { background: "#fff" } },
    unhealthyWebContentsIds: new Set(),
    rendererReadySeenByWebContentsId: new Set(),
    __dirname,
    URL,
    require,
    console,
    setTimeout,
    clearTimeout,
    getGlobalShortcutBridge: getGlobalShortcutBridge || (() => ({ handleWindowClose: () => false })),
    debugLog() {},
    resolveFrontendBackgroundColor() { return null; },
    loadWindowState() { return null; },
    getDevRendererBaseUrl(url) { return url; },
    getWindowBoundsState() { return null; },
    queueWindowStateSave() {},
    saveWindowStateSync() {},
    setupDeferredShow: setupDeferredShow || (() => {}),
    createExternalOnlyWindowOpenHandler() { return {}; },
    createAppWindowOpenHandler() { return {}; },
    attachOAuthLoadingOverlay() {},
    registerWindowHandlers() {},
    requestWindowCommandClose() { return true; },
    shouldCloseWindowFromInput() { return false; },
    applyWindowOpacityToWindow() {},
    closeSettingsWindow() {},
    hideSettingsWindow() {},
  });
}

async function createWindowWith(api, { startHidden, onRegisterBridge } = {}) {
  return api.createWindow(
    {
      BrowserWindow: BrowserWindowStub,
      nativeTheme: {},
      app: {},
      screen: {},
      shell: {},
      ipcMain: {},
    },
    {
      preload: "/tmp/preload.cjs",
      devServerUrl: "http://localhost:5173",
      isDev: true,
      appIcon: null,
      isMac: false,
      electronDir: __dirname,
      onRegisterBridge,
      startHidden,
    },
  );
}

test("createWindow forwards startHidden to setupDeferredShow", async () => {
  const deferredShowCalls = [];
  const api = createApi({
    setupDeferredShow: (win, options) => { deferredShowCalls.push(options); },
  });

  await createWindowWith(api, { startHidden: true });

  assert.equal(deferredShowCalls.length, 1);
  assert.equal(deferredShowCalls[0].startHidden, true);
});

test("createWindow defaults startHidden to false when omitted", async () => {
  const deferredShowCalls = [];
  const api = createApi({
    setupDeferredShow: (win, options) => { deferredShowCalls.push(options); },
  });

  await createWindowWith(api, {});

  assert.equal(deferredShowCalls.length, 1);
  assert.equal(deferredShowCalls[0].startHidden, false);
});

test("createWindow(startHidden) pins the tray open right after bridges register", async () => {
  const callOrder = [];
  const api = createApi({
    getGlobalShortcutBridge: () => ({
      handleWindowClose: () => false,
      pinTrayForHiddenLaunch: () => { callOrder.push("pinTrayForHiddenLaunch"); },
    }),
  });

  await createWindowWith(api, {
    startHidden: true,
    onRegisterBridge: () => { callOrder.push("onRegisterBridge"); },
  });

  assert.deepEqual(callOrder, ["onRegisterBridge", "pinTrayForHiddenLaunch"]);
});

test("createWindow(startHidden) tolerates a tray pin failure without throwing", async () => {
  const api = createApi({
    getGlobalShortcutBridge: () => ({
      handleWindowClose: () => false,
      pinTrayForHiddenLaunch: () => { throw new Error("electronModule not ready"); },
    }),
  });

  await assert.doesNotReject(() => createWindowWith(api, { startHidden: true }));
});

test("createWindow without startHidden does not pin the tray open", async () => {
  let pinCalls = 0;
  const api = createApi({
    getGlobalShortcutBridge: () => ({
      handleWindowClose: () => false,
      pinTrayForHiddenLaunch: () => { pinCalls += 1; },
    }),
  });

  await createWindowWith(api, {});

  assert.equal(pinCalls, 0);
});

test("a hidden cold start releases the tray pin once the window is actually shown", async () => {
  let releaseCalls = 0;
  const api = createApi({
    getGlobalShortcutBridge: () => ({
      handleWindowClose: () => false,
      pinTrayForHiddenLaunch: () => {},
      releaseHiddenLaunchTrayPin: () => { releaseCalls += 1; },
    }),
  });

  const win = await createWindowWith(api, { startHidden: true });
  assert.equal(releaseCalls, 0, "must stay pinned until the window is actually shown");

  win.emit("show");
  assert.equal(releaseCalls, 1);
});

test("a normal (non-hidden) cold start never touches the hidden-launch tray pin", async () => {
  let releaseCalls = 0;
  const api = createApi({
    getGlobalShortcutBridge: () => ({
      handleWindowClose: () => false,
      releaseHiddenLaunchTrayPin: () => { releaseCalls += 1; },
    }),
  });

  const win = await createWindowWith(api, {});
  win.emit("show");

  assert.equal(releaseCalls, 0);
});

test("releasing the tray pin tolerates a failure without throwing", async () => {
  const api = createApi({
    getGlobalShortcutBridge: () => ({
      handleWindowClose: () => false,
      pinTrayForHiddenLaunch: () => {},
      releaseHiddenLaunchTrayPin: () => { throw new Error("tray already gone"); },
    }),
  });

  const win = await createWindowWith(api, { startHidden: true });

  assert.doesNotThrow(() => win.emit("show"));
});
