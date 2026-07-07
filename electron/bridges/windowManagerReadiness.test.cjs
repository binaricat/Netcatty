const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildAppMenu,
  clampWindowOpacity,
  applyWindowOpacity,
  isWindowUsable,
  registerMainWindow,
  registerWindowHandlers,
  resolveSettingsWindowBounds,
  restoreWindowInputFocus,
  showAndFocusMainWindow,
  notifyWindowWillHide,
  requestWindowCommandClose,
  sendWhenRendererReady,
  shouldCloseWindowFromInput,
  unregisterMainWindow,
} = require("./windowManager.cjs");
const { createMainWindowApi } = require("./windowManager/mainWindow.cjs");

function createWindowStub({ destroyed = false, webContents } = {}) {
  return {
    isDestroyed() {
      return destroyed;
    },
    isVisible() {
      return true;
    },
    webContents,
  };
}

test("clampWindowOpacity keeps values within 0.5 and 1", () => {
  assert.equal(clampWindowOpacity(1), 1);
  assert.equal(clampWindowOpacity(0.85), 0.85);
  assert.equal(clampWindowOpacity(0.3), 0.5);
  assert.equal(clampWindowOpacity(1.5), 1);
  assert.equal(clampWindowOpacity("bad"), 1);
});

test("applyWindowOpacity clamps and applies to registered main windows", () => {
  const opacityCalls = [];
  const win = {
    isDestroyed() {
      return false;
    },
    setOpacity(value) {
      opacityCalls.push(value);
    },
    webContents: {
      id: 901,
      isDestroyed() {
        return false;
      },
    },
  };
  registerMainWindow(win);

  try {
    assert.equal(applyWindowOpacity(0.85), 0.85);
    assert.deepEqual(opacityCalls, [0.85]);

    assert.equal(applyWindowOpacity(0.2), 0.5);
    assert.deepEqual(opacityCalls, [0.85, 0.5]);
  } finally {
    unregisterMainWindow(win);
    applyWindowOpacity(1);
  }
});

test("isWindowUsable returns false when webContents is crashed", () => {
  const win = createWindowStub({
    webContents: {
      isDestroyed() {
        return false;
      },
      isCrashed() {
        return true;
      },
    },
  });

  assert.equal(isWindowUsable(win), false);
});

test("isWindowUsable returns true for a healthy live window", () => {
  const win = createWindowStub({
    webContents: {
      isDestroyed() {
        return false;
      },
      isCrashed() {
        return false;
      },
    },
  });

  assert.equal(isWindowUsable(win), true);
});

test("isWindowUsable can require a visible window", () => {
  const hiddenWin = {
    ...createWindowStub({
      webContents: {
        isDestroyed() {
          return false;
        },
        isCrashed() {
          return false;
        },
      },
    }),
    isVisible() {
      return false;
    },
  };

  assert.equal(isWindowUsable(hiddenWin, { requireVisible: true }), false);
  assert.equal(isWindowUsable(hiddenWin, { requireVisible: false }), true);
});

test("restoreWindowInputFocus focuses the window and renderer on Windows without showing hidden windows", () => {
  const calls = [];
  const win = {
    isDestroyed() {
      return false;
    },
    show() {
      calls.push("show");
    },
    focus() {
      calls.push("focus");
    },
    setAlwaysOnTop(value) {
      calls.push(`alwaysOnTop:${value}`);
    },
    webContents: {
      isDestroyed() {
        return false;
      },
      focus() {
        calls.push("webContents.focus");
      },
    },
  };

  const restored = restoreWindowInputFocus(win, { platform: "win32" });

  assert.equal(restored, true);
  assert.deepEqual(calls, [
    "alwaysOnTop:true",
    "focus",
    "alwaysOnTop:false",
    "webContents.focus",
  ]);
});

test("restoreWindowInputFocus clears Windows always-on-top even if window focus throws", () => {
  const calls = [];
  const win = {
    isDestroyed() {
      return false;
    },
    focus() {
      calls.push("focus");
      throw new Error("focus failed");
    },
    setAlwaysOnTop(value) {
      calls.push(`alwaysOnTop:${value}`);
    },
    webContents: {
      isDestroyed() {
        return false;
      },
      focus() {
        calls.push("webContents.focus");
      },
    },
  };

  const restored = restoreWindowInputFocus(win, { platform: "win32" });

  assert.equal(restored, true);
  assert.deepEqual(calls, [
    "alwaysOnTop:true",
    "focus",
    "alwaysOnTop:false",
    "webContents.focus",
  ]);
});

test("restoreWindowInputFocus can show the window when requested", () => {
  const calls = [];
  const win = {
    isDestroyed() {
      return false;
    },
    show() {
      calls.push("show");
    },
    focus() {
      calls.push("focus");
    },
    webContents: {
      isDestroyed() {
        return false;
      },
      focus() {
        calls.push("webContents.focus");
      },
    },
  };

  const restored = restoreWindowInputFocus(win, { platform: "darwin", show: true });

  assert.equal(restored, true);
  assert.deepEqual(calls, ["show", "focus", "webContents.focus"]);
});

test("showAndFocusMainWindow restores minimized windows before focusing", () => {
  const calls = [];
  const win = {
    isDestroyed() {
      return false;
    },
    isMinimized() {
      return true;
    },
    restore() {
      calls.push("restore");
    },
    show() {
      calls.push("show");
    },
    focus() {
      calls.push("focus");
    },
    webContents: {
      isDestroyed() {
        return false;
      },
      focus() {
        calls.push("webContents.focus");
      },
    },
  };

  const restored = showAndFocusMainWindow(win);

  assert.equal(restored, true);
  assert.deepEqual(calls, ["restore", "show", "focus", "webContents.focus"]);
});

test("notifyWindowWillHide sends will-hide IPC before native hide", () => {
  const sent = [];
  const win = {
    isDestroyed() {
      return false;
    },
    webContents: {
      isDestroyed() {
        return false;
      },
      send(channel) {
        sent.push(channel);
      },
    },
  };

  notifyWindowWillHide(win);

  assert.deepEqual(sent, ["netcatty:window:will-hide"]);
});

test("buildAppMenu closes a non-app window directly when Cmd+W is invoked", () => {
  let capturedTemplate = null;
  const Menu = {
    buildFromTemplate(template) {
      capturedTemplate = template;
      return { template };
    },
  };

  buildAppMenu(Menu, { name: "Netcatty" }, true);

  const windowMenu = capturedTemplate.find((item) => item.label === "Window");
  assert.ok(windowMenu);
  const closeItem = windowMenu.submenu.find((item) => item.accelerator === "CommandOrControl+W");
  assert.ok(closeItem);
  assert.equal(closeItem.label, "Close Window");

  const calls = [];
  closeItem.click(null, {
    isDestroyed() { return false; },
    close() {
      calls.push("close");
    },
    webContents: {
      isDestroyed() { return false; },
      send(channel) {
        calls.push(`send:${channel}`);
      },
    },
  });

  assert.deepEqual(calls, ["close"]);
});

test("buildAppMenu sends Cmd+W to any registered main window renderer", () => {
  let capturedTemplate = null;
  const Menu = {
    buildFromTemplate(template) {
      capturedTemplate = template;
      return { template };
    },
  };

  const calls = [];
  const firstMainWindow = {
    isDestroyed() { return false; },
    on() {},
    webContents: {
      isDestroyed() { return false; },
      send(channel) {
        calls.push(`first:${channel}`);
      },
    },
  };
  const secondMainWindow = {
    isDestroyed() { return false; },
    on() {},
    webContents: {
      isDestroyed() { return false; },
      send(channel) {
        calls.push(`second:${channel}`);
      },
    },
  };

  registerMainWindow(firstMainWindow);
  registerMainWindow(secondMainWindow);
  try {
    buildAppMenu(Menu, { name: "Netcatty" }, true);
    const windowMenu = capturedTemplate.find((item) => item.label === "Window");
    const closeItem = windowMenu.submenu.find((item) => item.accelerator === "CommandOrControl+W");

    closeItem.click(null, firstMainWindow);

    assert.deepEqual(calls, ["first:netcatty:window:command-close"]);
  } finally {
    unregisterMainWindow(firstMainWindow);
    unregisterMainWindow(secondMainWindow);
  }
});

test("buildAppMenu keeps app reload click-only so custom reload-like shortcuts reach the renderer", () => {
  let capturedTemplate = null;
  const Menu = {
    buildFromTemplate(template) {
      capturedTemplate = template;
      return { template };
    },
  };

  buildAppMenu(Menu, { name: "Netcatty" }, false);

  const viewMenu = capturedTemplate.find((item) => item.label === "View");
  assert.ok(viewMenu);
  assert.equal(viewMenu.submenu.some((item) => item.role === "reload"), false);
  assert.equal(viewMenu.submenu.some((item) => item.role === "forceReload"), false);
  assert.equal(viewMenu.submenu.some((item) => item.accelerator === "CommandOrControl+R"), false);
  assert.equal(viewMenu.submenu.some((item) => item.accelerator === "CommandOrControl+Shift+R"), false);

  const reloadItem = viewMenu.submenu.find((item) => item.label === "Reload");
  assert.ok(reloadItem);
  assert.equal(reloadItem.role, undefined);
  assert.equal(reloadItem.accelerator, undefined);

  const calls = [];
  reloadItem.click(null, {
    reload() {
      calls.push("reload");
    },
  });

  assert.deepEqual(calls, ["reload"]);
});

test("requestWindowCommandClose sends command-close to renderer-capable windows", () => {
  const sentChannels = [];
  const win = {
    isDestroyed() { return false; },
    webContents: {
      isDestroyed() { return false; },
      send(channel) {
        sentChannels.push(channel);
      },
    },
  };

  assert.equal(requestWindowCommandClose(win), true);
  assert.deepEqual(sentChannels, ["netcatty:window:command-close"]);
});

test("shouldCloseWindowFromInput only matches macOS Command+W keydown", () => {
  assert.equal(shouldCloseWindowFromInput({ type: "keyDown", meta: true, key: "w" }), true);
  assert.equal(shouldCloseWindowFromInput({ type: "keyDown", meta: true, key: "W" }), true);
  assert.equal(shouldCloseWindowFromInput({ type: "keyUp", meta: true, key: "w" }), false);
  assert.equal(shouldCloseWindowFromInput({ type: "keyDown", control: true, key: "w" }), false);
  assert.equal(shouldCloseWindowFromInput({ type: "keyDown", meta: true, shift: true, key: "w" }), false);
});

test("main window asks renderer to close tabs from macOS Command+W before-input-event", async () => {
  let beforeInputHandler = null;
  const commandCloseRequests = [];

  class BrowserWindowStub {
    constructor() {
      this.webContents = {
        id: 1,
        on(channel, handler) {
          if (channel === "before-input-event") beforeInputHandler = handler;
        },
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
      };
    }

    on() {}
    once() {}
    isDestroyed() { return false; }
    isMaximized() { return false; }
    isFullScreen() { return false; }
    getBounds() { return { x: 0, y: 0, width: 1400, height: 900 }; }
    setBackgroundColor() {}
    setOpacity() {}
    async loadURL() {}
    close() {}
  }

  const api = createMainWindowApi({
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
    getGlobalShortcutBridge() {
      return { handleWindowClose: () => false };
    },
    debugLog() {},
    resolveFrontendBackgroundColor() { return null; },
    loadWindowState() { return null; },
    getDevRendererBaseUrl(url) { return url; },
    getWindowBoundsState() { return null; },
    queueWindowStateSave() {},
    saveWindowStateSync() {},
    setupDeferredShow() {},
    createExternalOnlyWindowOpenHandler() { return {}; },
    createAppWindowOpenHandler() { return {}; },
    attachOAuthLoadingOverlay() {},
    registerWindowHandlers() {},
    requestWindowCommandClose(win) {
      commandCloseRequests.push(win);
      return true;
    },
    shouldCloseWindowFromInput,
    applyWindowOpacityToWindow() {},
    closeSettingsWindow() {},
    hideSettingsWindow() {},
  });

  await api.createWindow(
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
      isMac: true,
      electronDir: __dirname,
    },
  );

  let prevented = false;
  beforeInputHandler({ preventDefault: () => { prevented = true; } }, {
    type: "keyDown",
    meta: true,
    key: "w",
  });

  assert.equal(prevented, true);
  assert.equal(commandCloseRequests.length, 1);
});

test("main window leaves primary-modifier reload-like shortcuts available to renderer handlers", async () => {
  let beforeInputHandler = null;
  const ignoreMenuShortcutValues = [];

  class BrowserWindowStub {
    constructor() {
      this.webContents = {
        id: 1,
        on(channel, handler) {
          if (channel === "before-input-event") beforeInputHandler = handler;
        },
        once() {},
        isDestroyed() {
          return false;
        },
        isCrashed() {
          return false;
        },
        setIgnoreMenuShortcuts(value) {
          ignoreMenuShortcutValues.push(value);
        },
        setWindowOpenHandler() {},
        openDevTools() {},
      };
    }

    on() {}
    once() {}
    isDestroyed() { return false; }
    isMaximized() { return false; }
    isFullScreen() { return false; }
    getBounds() { return { x: 0, y: 0, width: 1400, height: 900 }; }
    setBackgroundColor() {}
    setOpacity() {}
    async loadURL() {}
    close() {}
  }

  const api = createMainWindowApi({
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
    getGlobalShortcutBridge() {
      return { handleWindowClose: () => false };
    },
    debugLog() {},
    resolveFrontendBackgroundColor() { return null; },
    loadWindowState() { return null; },
    getDevRendererBaseUrl(url) { return url; },
    getWindowBoundsState() { return null; },
    queueWindowStateSave() {},
    saveWindowStateSync() {},
    setupDeferredShow() {},
    createExternalOnlyWindowOpenHandler() { return {}; },
    createAppWindowOpenHandler() { return {}; },
    attachOAuthLoadingOverlay() {},
    registerWindowHandlers() {},
    requestWindowCommandClose() {
      return true;
    },
    shouldCloseWindowFromInput,
    applyWindowOpacityToWindow() {},
    closeSettingsWindow() {},
    hideSettingsWindow() {},
  });

  await api.createWindow(
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
    },
  );

  let prevented = false;
  beforeInputHandler({ preventDefault: () => { prevented = true; } }, {
    type: "keyDown",
    control: true,
    shift: true,
    key: "R",
  });

  assert.equal(prevented, false);
  assert.deepEqual(ignoreMenuShortcutValues, [false]);
});

test("main window clears renderer readiness when the main frame starts navigating", async () => {
  const webContentsHandlers = {};
  const rendererReadyIds = new Set([7]);
  const clearedReadyIds = [];

  class BrowserWindowStub {
    constructor() {
      this.webContents = {
        id: 7,
        on(channel, handler) {
          webContentsHandlers[channel] = handler;
        },
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
      };
    }

    on() {}
    once() {}
    isDestroyed() { return false; }
    isMaximized() { return false; }
    isFullScreen() { return false; }
    getBounds() { return { x: 0, y: 0, width: 1400, height: 900 }; }
    setBackgroundColor() {}
    setOpacity() {}
    async loadURL() {}
    close() {}
  }

  const api = createMainWindowApi({
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
    rendererReadySeenByWebContentsId: rendererReadyIds,
    __dirname,
    URL,
    require,
    console,
    setTimeout,
    clearTimeout,
    getGlobalShortcutBridge() {
      return { handleWindowClose: () => false };
    },
    debugLog() {},
    resolveFrontendBackgroundColor() { return null; },
    loadWindowState() { return null; },
    getDevRendererBaseUrl(url) { return url; },
    getWindowBoundsState() { return null; },
    queueWindowStateSave() {},
    saveWindowStateSync() {},
    setupDeferredShow() {},
    clearRendererReadyForWebContents(id) {
      clearedReadyIds.push(id);
      rendererReadyIds.delete(id);
    },
    createExternalOnlyWindowOpenHandler() { return {}; },
    createAppWindowOpenHandler() { return {}; },
    attachOAuthLoadingOverlay() {},
    registerWindowHandlers() {},
    requestWindowCommandClose() {
      return true;
    },
    shouldCloseWindowFromInput,
    applyWindowOpacityToWindow() {},
    closeSettingsWindow() {},
    hideSettingsWindow() {},
  });

  await api.createWindow(
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
    },
  );

  assert.equal(rendererReadyIds.has(7), true);
  assert.equal(typeof webContentsHandlers["did-start-navigation"], "function");
  assert.equal(typeof webContentsHandlers["will-navigate"], "function");

  webContentsHandlers["did-start-navigation"]({}, "app://netcatty/index.html", false, false);
  assert.equal(rendererReadyIds.has(7), true);
  assert.deepEqual(clearedReadyIds, []);

  webContentsHandlers["did-start-navigation"]({}, "app://netcatty/index.html#/vault", true, true);
  assert.equal(rendererReadyIds.has(7), true);
  assert.deepEqual(clearedReadyIds, []);

  let blockedNavigation = false;
  webContentsHandlers["will-navigate"](
    { preventDefault() { blockedNavigation = true; } },
    "https://example.com/",
  );
  assert.equal(blockedNavigation, true);

  webContentsHandlers["did-start-navigation"]({}, "https://example.com/", false, true);
  assert.equal(rendererReadyIds.has(7), true);
  assert.deepEqual(clearedReadyIds, []);

  let blockedAppPortNavigation = false;
  webContentsHandlers["will-navigate"](
    { preventDefault() { blockedAppPortNavigation = true; } },
    "app://netcatty:123/index.html",
  );
  assert.equal(blockedAppPortNavigation, true);

  webContentsHandlers["did-start-navigation"]({}, "app://netcatty:123/index.html", false, true);
  assert.equal(rendererReadyIds.has(7), true);
  assert.deepEqual(clearedReadyIds, []);

  webContentsHandlers["did-start-navigation"]({}, "app://netcatty/index.html", false, true);
  assert.equal(rendererReadyIds.has(7), false);
  assert.deepEqual(clearedReadyIds, [7]);
});

test("createWindow registers each main window as an independent app window", async () => {
  const registered = [];
  const unregistered = [];

  class BrowserWindowStub {
    constructor() {
      this.webContents = {
        id: registered.length + 1,
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
      };
    }

    on(channel, handler) {
      if (channel === "closed") this._closedHandler = handler;
    }
    once() {}
    isDestroyed() { return false; }
    isMaximized() { return false; }
    isFullScreen() { return false; }
    getBounds() { return { x: 0, y: 0, width: 1400, height: 900 }; }
    setBackgroundColor() {}
    setOpacity() {}
    async loadURL() {}
    close() {
      this._closedHandler?.();
    }
  }

  const api = createMainWindowApi({
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
    getGlobalShortcutBridge() {
      return { handleWindowClose: () => false };
    },
    debugLog() {},
    resolveFrontendBackgroundColor() { return null; },
    loadWindowState() { return null; },
    getDevRendererBaseUrl(url) { return url; },
    getWindowBoundsState() { return null; },
    queueWindowStateSave() {},
    saveWindowStateSync() {},
    setupDeferredShow() {},
    createExternalOnlyWindowOpenHandler() { return {}; },
    createAppWindowOpenHandler() { return {}; },
    attachOAuthLoadingOverlay() {},
    registerWindowHandlers() {},
    requestWindowCommandClose() {
      return true;
    },
    shouldCloseWindowFromInput,
    registerMainWindow(win) {
      registered.push(win);
    },
    unregisterMainWindow(win) {
      unregistered.push(win);
    },
    applyWindowOpacityToWindow() {},
    closeSettingsWindow() {},
    hideSettingsWindow() {},
  });

  const electronModule = {
    BrowserWindow: BrowserWindowStub,
    nativeTheme: {},
    app: {},
    screen: {},
    shell: {},
    ipcMain: {},
  };
  const options = {
    preload: "/tmp/preload.cjs",
    devServerUrl: "http://localhost:5173",
    isDev: true,
    appIcon: null,
    isMac: true,
    electronDir: __dirname,
  };

  const first = await api.createWindow(electronModule, options);
  const second = await api.createWindow(electronModule, options);

  assert.equal(registered.length, 2);
  assert.equal(registered[0], first);
  assert.equal(registered[1], second);
  assert.notEqual(first, second);

  first.close();
  assert.deepEqual(unregistered, [first]);
});

test("each main window close saves its own state", async () => {
  const closeHandlers = [];
  const savedStates = [];

  class BrowserWindowStub {
    constructor() {
      this.webContents = {
        id: closeHandlers.length + 1,
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
      };
    }

    on(channel, handler) {
      if (channel === "close") closeHandlers.push(handler);
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
  }

  const api = createMainWindowApi({
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
    getGlobalShortcutBridge() {
      return { handleWindowClose: () => false };
    },
    debugLog() {},
    resolveFrontendBackgroundColor() { return null; },
    loadWindowState() { return null; },
    getDevRendererBaseUrl(url) { return url; },
    getWindowBoundsState(win) {
      return { windowId: win.webContents.id };
    },
    queueWindowStateSave() {},
    saveWindowStateSync(state) {
      savedStates.push(state);
    },
    setupDeferredShow() {},
    createExternalOnlyWindowOpenHandler() { return {}; },
    createAppWindowOpenHandler() { return {}; },
    attachOAuthLoadingOverlay() {},
    registerWindowHandlers() {},
    requestWindowCommandClose() {
      return true;
    },
    shouldCloseWindowFromInput,
    registerMainWindow() {},
    unregisterMainWindow() {},
    registerAppContentWindow() {},
    unregisterAppContentWindow() {},
    queryDirtyEditors: async () => false,
    applyWindowOpacityToWindow() {},
    closeSettingsWindow() {},
    hideSettingsWindow() {},
  });

  const electronModule = {
    BrowserWindow: BrowserWindowStub,
    nativeTheme: {},
    app: {},
    screen: {},
    shell: {},
    ipcMain: {},
  };
  const options = {
    preload: "/tmp/preload.cjs",
    devServerUrl: "http://localhost:5173",
    isDev: true,
    appIcon: null,
    isMac: true,
    electronDir: __dirname,
  };

  await api.createWindow(electronModule, options);
  await api.createWindow(electronModule, options);

  assert.equal(closeHandlers.length, 2);
  closeHandlers[0]({ preventDefault() {} });
  closeHandlers[1]({ preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  closeHandlers[0]({ preventDefault() {} });
  closeHandlers[1]({ preventDefault() {} });

  assert.deepEqual(savedStates, [{ windowId: 1 }, { windowId: 2 }]);
});

test("peer session windows do not load or save shared main window state", async () => {
  const closeHandlers = [];
  const resizeHandlers = [];
  const savedStates = [];
  let loadWindowStateCount = 0;
  let closeSettingsWindowCount = 0;

  class BrowserWindowStub {
    constructor() {
      this.webContents = {
        id: 1,
        on() {},
        setWindowOpenHandler() {},
        openDevTools() {},
        send() {},
        isDestroyed: () => false,
      };
    }
    on(channel, handler) {
      if (channel === "close") closeHandlers.push(handler);
      if (channel === "resize") resizeHandlers.push(handler);
    }
    once() {}
    isDestroyed() { return false; }
    isMaximized() { return false; }
    isFullScreen() { return false; }
    getBounds() { return { width: 1000, height: 700 }; }
    setBackgroundColor() {}
    loadURL() { return Promise.resolve(); }
  }

  const api = createMainWindowApi({
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
    getGlobalShortcutBridge() {
      return { handleWindowClose: () => false };
    },
    debugLog() {},
    resolveFrontendBackgroundColor() { return null; },
    loadWindowState() {
      loadWindowStateCount += 1;
      return { width: 1234, height: 777 };
    },
    getDevRendererBaseUrl(url) { return url; },
    getWindowBoundsState(win) {
      return { windowId: win.webContents.id };
    },
    queueWindowStateSave(state) {
      savedStates.push(state);
    },
    saveWindowStateSync(state) {
      savedStates.push(state);
    },
    setupDeferredShow() {},
    createExternalOnlyWindowOpenHandler() { return {}; },
    createAppWindowOpenHandler() { return {}; },
    attachOAuthLoadingOverlay() {},
    registerWindowHandlers() {},
    requestWindowCommandClose() {
      return true;
    },
    shouldCloseWindowFromInput,
    registerMainWindow() {
      throw new Error("peer window should not register as main");
    },
    unregisterMainWindow() {},
    applyWindowOpacityToWindow() {},
    closeSettingsWindow() {
      closeSettingsWindowCount += 1;
    },
    hideSettingsWindow() {},
  });

  const win = await api.createWindow(
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
      isMac: true,
      electronDir: __dirname,
      route: "session-window",
      registerAsMainWindow: false,
    },
  );

  assert.ok(win);
  assert.equal(loadWindowStateCount, 0);
  resizeHandlers[0]?.();
  closeHandlers[0]?.({ preventDefault() {} });
  assert.deepEqual(savedStates, []);
  assert.equal(closeSettingsWindowCount, 0);
});

test("peer session windows register as app content windows for dirty editor guard", async () => {
  const registeredContentWindows = [];
  const unregisteredContentWindows = [];
  const closeHandlers = [];

  class BrowserWindowStub {
    constructor() {
      this.webContents = {
        id: 1,
        on() {},
        setWindowOpenHandler() {},
        openDevTools() {},
        send() {},
        isDestroyed: () => false,
      };
    }
    on(channel, handler) {
      if (channel === "closed") closeHandlers.push(handler);
    }
    once() {}
    isDestroyed() { return false; }
    isMaximized() { return false; }
    isFullScreen() { return false; }
    getBounds() { return { width: 1000, height: 700 }; }
    setBackgroundColor() {}
    loadURL() { return Promise.resolve(); }
  }

  const api = createMainWindowApi({
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
    getGlobalShortcutBridge() {
      return { handleWindowClose: () => false };
    },
    debugLog() {},
    resolveFrontendBackgroundColor() { return null; },
    loadWindowState() { return null; },
    getDevRendererBaseUrl(url) { return url; },
    getWindowBoundsState(win) {
      return { windowId: win.webContents.id };
    },
    queueWindowStateSave() {},
    saveWindowStateSync() {},
    setupDeferredShow() {},
    createExternalOnlyWindowOpenHandler() { return {}; },
    createAppWindowOpenHandler() { return {}; },
    attachOAuthLoadingOverlay() {},
    registerWindowHandlers() {},
    requestWindowCommandClose() {
      return true;
    },
    shouldCloseWindowFromInput,
    registerMainWindow() {
      throw new Error("peer window should not register as main");
    },
    unregisterMainWindow() {},
    registerAppContentWindow(win) {
      registeredContentWindows.push(win);
    },
    unregisterAppContentWindow(win) {
      unregisteredContentWindows.push(win);
    },
    applyWindowOpacityToWindow() {},
    closeSettingsWindow() {},
    hideSettingsWindow() {},
  });

  const win = await api.createWindow(
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
      isMac: true,
      electronDir: __dirname,
      route: "session-window",
      registerAsMainWindow: false,
    },
  );

  assert.deepEqual(registeredContentWindows, [win]);
  closeHandlers[0]?.();
  assert.deepEqual(unregisteredContentWindows, [win]);
});

test("peer session window close queries dirty editors before destroying the renderer", async () => {
  const closeHandlers = [];
  const queriedWebContents = [];
  let preventDefaultCount = 0;

  class BrowserWindowStub {
    constructor() {
      this.closeCalls = 0;
      this.webContents = {
        id: 1,
        on() {},
        setWindowOpenHandler() {},
        openDevTools() {},
        send() {},
        isDestroyed: () => false,
        isCrashed: () => false,
      };
    }
    on(channel, handler) {
      if (channel === "close") closeHandlers.push(handler);
    }
    once() {}
    close() {
      this.closeCalls += 1;
    }
    isDestroyed() { return false; }
    isMaximized() { return false; }
    isFullScreen() { return false; }
    getBounds() { return { width: 1000, height: 700 }; }
    setBackgroundColor() {}
    loadURL() { return Promise.resolve(); }
  }

  const api = createMainWindowApi({
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
    getGlobalShortcutBridge() {
      return { handleWindowClose: () => false };
    },
    debugLog() {},
    resolveFrontendBackgroundColor() { return null; },
    loadWindowState() { return null; },
    getDevRendererBaseUrl(url) { return url; },
    getWindowBoundsState() {
      return null;
    },
    queueWindowStateSave() {},
    saveWindowStateSync() {},
    setupDeferredShow() {},
    createExternalOnlyWindowOpenHandler() { return {}; },
    createAppWindowOpenHandler() { return {}; },
    attachOAuthLoadingOverlay() {},
    registerWindowHandlers() {},
    requestWindowCommandClose() {
      return true;
    },
    shouldCloseWindowFromInput,
    registerMainWindow() {
      throw new Error("peer window should not register as main");
    },
    unregisterMainWindow() {},
    registerAppContentWindow() {},
    unregisterAppContentWindow() {},
    queryDirtyEditors: async (webContents) => {
      queriedWebContents.push(webContents);
      return true;
    },
    applyWindowOpacityToWindow() {},
    closeSettingsWindow() {},
    hideSettingsWindow() {},
  });

  await api.createWindow(
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
      isMac: true,
      electronDir: __dirname,
      route: "session-window",
      registerAsMainWindow: false,
    },
  );

  closeHandlers[0]?.({
    preventDefault() {
      preventDefaultCount += 1;
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(preventDefaultCount, 1);
  assert.equal(queriedWebContents.length, 1);
});

test("main window close queries dirty editors before destroying the renderer", async () => {
  const closeHandlers = [];
  const queriedWebContents = [];
  let preventDefaultCount = 0;
  let savedStateCount = 0;

  class BrowserWindowStub {
    constructor() {
      this.closeCalls = 0;
      this.webContents = {
        id: 1,
        on() {},
        setWindowOpenHandler() {},
        openDevTools() {},
        send() {},
        isDestroyed: () => false,
        isCrashed: () => false,
      };
    }
    on(channel, handler) {
      if (channel === "close") closeHandlers.push(handler);
    }
    once() {}
    close() {
      this.closeCalls += 1;
    }
    isDestroyed() { return false; }
    isMaximized() { return false; }
    isFullScreen() { return false; }
    getBounds() { return { width: 1000, height: 700 }; }
    setBackgroundColor() {}
    setOpacity() {}
    loadURL() { return Promise.resolve(); }
  }

  const api = createMainWindowApi({
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
    getGlobalShortcutBridge() {
      return { handleWindowClose: () => false };
    },
    debugLog() {},
    resolveFrontendBackgroundColor() { return null; },
    loadWindowState() { return null; },
    getDevRendererBaseUrl(url) { return url; },
    getWindowBoundsState() {
      return { width: 1000, height: 700 };
    },
    queueWindowStateSave() {},
    saveWindowStateSync() {
      savedStateCount += 1;
    },
    setupDeferredShow() {},
    createExternalOnlyWindowOpenHandler() { return {}; },
    createAppWindowOpenHandler() { return {}; },
    attachOAuthLoadingOverlay() {},
    registerWindowHandlers() {},
    requestWindowCommandClose() {
      return true;
    },
    shouldCloseWindowFromInput,
    registerMainWindow() {},
    unregisterMainWindow() {},
    queryDirtyEditors: async (webContents) => {
      queriedWebContents.push(webContents);
      return true;
    },
    applyWindowOpacityToWindow() {},
    closeSettingsWindow() {},
    hideSettingsWindow() {},
  });

  await api.createWindow(
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
      isMac: true,
      electronDir: __dirname,
    },
  );

  closeHandlers[0]?.({
    preventDefault() {
      preventDefaultCount += 1;
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(preventDefaultCount, 1);
  assert.equal(queriedWebContents.length, 1);
  assert.equal(savedStateCount, 0);
});

test("window IPC handlers target the sender owner window", async () => {
  const handlers = new Map();
  const ipcMain = {
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
    on(channel, handler) {
      handlers.set(channel, handler);
    },
  };
  const calls = [];
  const titles = [];
  const win = {
    isDestroyed() {
      return false;
    },
    setTitle(title) {
      titles.push(title);
    },
    focus() {
      calls.push("focus");
    },
    webContents: {
      id: 101,
      isDestroyed() {
        return false;
      },
      focus() {
        calls.push("webContents.focus");
      },
    },
  };

  registerWindowHandlers(ipcMain, { themeSource: "light" });

  const result = await handlers.get("netcatty:window:focus")({
    sender: {
      id: 202,
      getOwnerBrowserWindow() {
        return win;
      },
    },
  });

  assert.equal(result, true);
  assert.deepEqual(calls, ["focus", "webContents.focus"]);
  const titleResult = await handlers.get("netcatty:window:setTitle")({
    sender: {
      id: 202,
      getOwnerBrowserWindow() {
        return win;
      },
    },
  }, "Prod SSH");

  assert.equal(titleResult, true);
  assert.deepEqual(titles, ["Prod SSH"]);

  const opacityCalls = [];
  registerMainWindow({
    isDestroyed() {
      return false;
    },
    setOpacity(value) {
      opacityCalls.push(value);
    },
    webContents: {
      id: 303,
      isDestroyed() {
        return false;
      },
    },
  });

  const opacityResult = await handlers.get("netcatty:setWindowOpacity")(null, 0.7);
  assert.equal(opacityResult, true);
  assert.deepEqual(opacityCalls, [0.7]);
});

test("resolveSettingsWindowBounds centers settings on the requesting window display", () => {
  const sourceWindow = {
    getBounds() {
      return { x: 2100, y: 80, width: 900, height: 700 };
    },
    isDestroyed() {
      return false;
    },
  };
  const electronModule = {
    screen: {
      getDisplayMatching(bounds) {
        assert.deepEqual(bounds, { x: 2100, y: 80, width: 900, height: 700 });
        return { workArea: { x: 1920, y: 0, width: 1440, height: 900 } };
      },
    },
  };

  assert.deepEqual(
    resolveSettingsWindowBounds(electronModule, {
      sourceWindow,
      settingsWidth: 980,
      settingsHeight: 720,
    }),
    { x: 2150, y: 90 },
  );
});

function createSendableWindowStub({ destroyed = false, webContentsDestroyed = false } = {}) {
  const sent = [];
  return {
    sent,
    win: {
      isDestroyed() {
        return destroyed;
      },
      webContents: {
        id: 7,
        isDestroyed() {
          return webContentsDestroyed;
        },
        send(channel, payload) {
          sent.push({ channel, payload });
        },
      },
    },
  };
}

test("sendWhenRendererReady delivers the payload once the renderer reports ready", async () => {
  const { win, sent } = createSendableWindowStub();
  const waited = [];

  const result = await sendWhenRendererReady(
    win,
    "netcatty:window:openSession",
    { title: "Prod" },
    {
      timeoutMs: 8000,
      waitForReady: async (target, opts) => {
        waited.push({ target, opts });
      },
    },
  );

  assert.deepEqual(result, { success: true });
  assert.equal(waited.length, 1);
  assert.equal(waited[0].target, win);
  assert.deepEqual(waited[0].opts, { timeoutMs: 8000 });
  assert.deepEqual(sent, [
    { channel: "netcatty:window:openSession", payload: { title: "Prod" } },
  ]);
});

test("sendWhenRendererReady reports failure without sending when readiness times out", async () => {
  const { win, sent } = createSendableWindowStub();

  const result = await sendWhenRendererReady(
    win,
    "netcatty:window:openSession",
    { title: "Prod" },
    {
      timeoutMs: 5,
      waitForReady: async () => {
        throw new Error("Renderer did not report ready before timeout.");
      },
    },
  );

  assert.equal(result.success, false);
  assert.equal(sent.length, 0);
});

test("sendWhenRendererReady reports failure without sending when the window is gone after readiness", async () => {
  const { win, sent } = createSendableWindowStub({ destroyed: true });

  const result = await sendWhenRendererReady(
    win,
    "netcatty:window:openSession",
    { title: "Prod" },
    {
      timeoutMs: 8000,
      waitForReady: async () => {},
    },
  );

  assert.equal(result.success, false);
  assert.equal(sent.length, 0);
});

test("sendWhenRendererReady can cancel after readiness before sending", async () => {
  const { win, sent } = createSendableWindowStub();

  const result = await sendWhenRendererReady(
    win,
    "netcatty:window:openSession",
    { title: "Prod" },
    {
      timeoutMs: 8000,
      waitForReady: async () => {},
      shouldSend: () => false,
      cancelReason: "disabled",
    },
  );

  assert.deepEqual(result, { success: false, reason: "disabled" });
  assert.equal(sent.length, 0);
});

test("sendWhenRendererReady reports cancellation instead of timeout after cancellation", async () => {
  const { win, sent } = createSendableWindowStub();

  const result = await sendWhenRendererReady(
    win,
    "netcatty:window:openSession",
    { title: "Prod" },
    {
      timeoutMs: 5,
      waitForReady: async () => {
        throw new Error("Renderer did not report ready before timeout.");
      },
      shouldSend: () => false,
      cancelReason: "disabled",
    },
  );

  assert.deepEqual(result, { success: false, reason: "disabled" });
  assert.equal(sent.length, 0);
});
