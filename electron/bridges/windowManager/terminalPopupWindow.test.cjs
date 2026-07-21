"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createAppContentWindowClosedHandler } = require("../../appWindowLifecycle.cjs");
const { createTerminalPopupWindowApi } = require("./terminalPopupWindow.cjs");
const { markAttachPopupClosePrepared } = require("../terminalAttachRestore.cjs");

test("terminal popups participate in the last app-content-window lifecycle", async () => {
  const appContentWindows = new Set();
  let quitCalls = 0;
  const lifecycleHandler = createAppContentWindowClosedHandler({
    app: { quit() { quitCalls += 1; } },
    platform: "win32",
    windowManager: {
      getAppContentWindows: () => [...appContentWindows],
      getIsQuitting: () => false,
    },
  });
  let popupWindow;

  class BrowserWindowStub {
    constructor() {
      popupWindow = this;
      this.handlers = new Map();
      this.webContents = {
        id: 42,
        on() {},
        send() {},
        setWindowOpenHandler() {},
      };
    }

    on(channel, handler) { this.handlers.set(channel, handler); }
    isDestroyed() { return false; }
    isVisible() { return true; }
    loadURL() { return Promise.resolve(); }
    setBackgroundColor() {}
  }

  const api = createTerminalPopupWindowApi({
    mainWindow: null,
    currentTheme: "light",
    V8_CACHE_OPTIONS: "bypassHeatCheck",
    resolveFrontendBackgroundColor() { return "#fff"; },
    resolveSettingsWindowBounds() { return { x: 10, y: 20 }; },
    createExternalOnlyWindowOpenHandler() { return {}; },
    applyWindowOpacityToWindow() {},
    getDevRendererBaseUrl(url) { return url; },
    showAndFocusWindow() {},
    registerAppContentWindow(win) { appContentWindows.add(win); },
    unregisterAppContentWindow(win) { appContentWindows.delete(win); },
    notifyAppContentWindowClosed() { lifecycleHandler(); },
  });

  const result = await api.openTerminalPopupWindow(
    {
      BrowserWindow: BrowserWindowStub,
      nativeTheme: { shouldUseDarkColors: false },
      shell: {},
    },
    {
      preload: "/tmp/preload.cjs",
      isDev: false,
      appIcon: null,
      isMac: false,
      electronDir: __dirname,
    },
    { popupId: "popup-1", title: "Terminal" },
  );

  assert.deepEqual(result, { success: true, popupId: "popup-1" });
  assert.deepEqual([...appContentWindows], [popupWindow]);
  await assert.rejects(api.openTerminalPopupWindow(
    { BrowserWindow: BrowserWindowStub, nativeTheme: {}, shell: {} },
    {
      preload: "/tmp/preload.cjs",
      isDev: false,
      appIcon: null,
      isMac: false,
      electronDir: __dirname,
    },
    { popupId: "popup-1" },
  ), /already active/);
  assert.equal(appContentWindows.size, 1);
  assert.equal(lifecycleHandler(), false);
  assert.equal(quitCalls, 0);

  popupWindow.handlers.get("closed")?.();
  assert.deepEqual([...appContentWindows], []);
  assert.equal(quitCalls, 1);
});

test("a terminal popup that fails to load releases app-content lifecycle state", async () => {
  const appContentWindows = new Set();
  let closeNotifications = 0;

  class FailingBrowserWindowStub {
    constructor() {
      this.destroyed = false;
      this.handlers = new Map();
      this.webContents = {
        id: 43,
        on() {},
        send() {},
        setWindowOpenHandler() {},
      };
    }

    on(channel, handler) { this.handlers.set(channel, handler); }
    isDestroyed() { return this.destroyed; }
    loadURL() { return Promise.reject(new Error("renderer unavailable")); }
    setBackgroundColor() {}
    destroy() {
      this.destroyed = true;
      this.handlers.get("closed")?.();
    }
  }

  const api = createTerminalPopupWindowApi({
    mainWindow: null,
    currentTheme: "light",
    V8_CACHE_OPTIONS: "bypassHeatCheck",
    resolveFrontendBackgroundColor() { return "#fff"; },
    resolveSettingsWindowBounds() { return {}; },
    createExternalOnlyWindowOpenHandler() { return {}; },
    applyWindowOpacityToWindow() {},
    getDevRendererBaseUrl(url) { return url; },
    showAndFocusWindow() {},
    registerAppContentWindow(win) { appContentWindows.add(win); },
    unregisterAppContentWindow(win) { appContentWindows.delete(win); },
    notifyAppContentWindowClosed() { closeNotifications += 1; },
  });

  await assert.rejects(api.openTerminalPopupWindow(
    {
      BrowserWindow: FailingBrowserWindowStub,
      nativeTheme: { shouldUseDarkColors: false },
      shell: {},
    },
    {
      preload: "/tmp/preload.cjs",
      isDev: false,
      appIcon: null,
      isMac: false,
      electronDir: __dirname,
    },
    { popupId: "failed-popup" },
  ), /renderer unavailable/);

  assert.deepEqual([...appContentWindows], []);
  assert.equal(closeNotifications, 1);
});

test("popup close failures cannot leave a ghost app-content window", async () => {
  const appContentWindows = new Set();
  let closeNotifications = 0;
  let popupWindow;

  class CloseFailingBrowserWindowStub {
    constructor() {
      popupWindow = this;
      this.handlers = new Map();
      this.webContents = {
        id: 44,
        on() {},
        send() {},
        setWindowOpenHandler() {},
      };
    }

    on(channel, handler) { this.handlers.set(channel, handler); }
    isDestroyed() { return false; }
    loadURL() { return Promise.resolve(); }
    setBackgroundColor() {}
    close() { throw new Error("close failed"); }
    destroy() { throw new Error("destroy failed"); }
  }

  const api = createTerminalPopupWindowApi({
    mainWindow: null,
    currentTheme: "light",
    V8_CACHE_OPTIONS: "bypassHeatCheck",
    resolveFrontendBackgroundColor() { return "#fff"; },
    resolveSettingsWindowBounds() { return {}; },
    createExternalOnlyWindowOpenHandler() { return {}; },
    applyWindowOpacityToWindow() {},
    getDevRendererBaseUrl(url) { return url; },
    showAndFocusWindow() {},
    registerAppContentWindow(win) { appContentWindows.add(win); },
    unregisterAppContentWindow(win) { appContentWindows.delete(win); },
    notifyAppContentWindowClosed() { closeNotifications += 1; },
  });

  await api.openTerminalPopupWindow(
    { BrowserWindow: CloseFailingBrowserWindowStub, nativeTheme: {}, shell: {} },
    {
      preload: "/tmp/preload.cjs",
      isDev: false,
      appIcon: null,
      isMac: false,
      electronDir: __dirname,
    },
    { popupId: "close-failure" },
  );
  assert.deepEqual([...appContentWindows], [popupWindow]);
  assert.doesNotThrow(() => api.closeTerminalPopupWindow("close-failure"));
  assert.deepEqual([...appContentWindows], []);
  assert.equal(closeNotifications, 1);
});

test("attach popup waits for renderer handoff before closing", async () => {
  const sent = [];
  let popupWindow;
  class AttachBrowserWindowStub {
    constructor() {
      popupWindow = this;
      this.destroyed = false;
      this.handlers = new Map();
      this.webContents = {
        id: 45,
        on() {},
        send(channel, payload) { sent.push({ channel, payload }); },
        setWindowOpenHandler() {},
      };
    }
    on(channel, handler) { this.handlers.set(channel, handler); }
    isDestroyed() { return this.destroyed; }
    isVisible() { return true; }
    loadURL() { return Promise.resolve(); }
    setBackgroundColor() {}
    close() {
      let prevented = false;
      this.handlers.get("close")?.({ preventDefault() { prevented = true; } });
      if (!prevented) {
        this.destroyed = true;
        this.handlers.get("closed")?.();
      }
    }
    destroy() {
      this.destroyed = true;
      this.handlers.get("closed")?.();
    }
  }
  const api = createTerminalPopupWindowApi({
    mainWindow: null,
    currentTheme: "light",
    V8_CACHE_OPTIONS: "bypassHeatCheck",
    resolveFrontendBackgroundColor() { return "#fff"; },
    resolveSettingsWindowBounds() { return {}; },
    createExternalOnlyWindowOpenHandler() { return {}; },
    applyWindowOpacityToWindow() {},
    getDevRendererBaseUrl(url) { return url; },
    showAndFocusWindow() {},
    registerAppContentWindow() {},
    unregisterAppContentWindow() {},
    notifyAppContentWindowClosed() {},
  });

  await api.openTerminalPopupWindow(
    { BrowserWindow: AttachBrowserWindowStub, nativeTheme: {}, shell: {} },
    { preload: "/tmp/preload.cjs", isDev: false, appIcon: null, isMac: false, electronDir: __dirname },
    {
      popupId: "attach-popup",
      title: "Attach",
      attachSessionId: "session-1",
      sourceSession: { id: "session-1" },
    },
  );
  const config = sent.find((entry) => entry.channel === "netcatty:window:terminalPopupConfig")?.payload;
  assert.equal(typeof config.attachAuthorization, "string");

  api.closeTerminalPopupWindow("attach-popup");
  assert.equal(popupWindow.destroyed, false);
  assert.deepEqual(sent.at(-1), {
    channel: "netcatty:terminal-popup:prepare-close",
    payload: { sessionId: "session-1", authorization: config.attachAuthorization },
  });

  assert.equal(markAttachPopupClosePrepared(config.attachAuthorization, "session-1", 45), true);
  api.closeTerminalPopupWindow("attach-popup");
  assert.equal(popupWindow.destroyed, true);
});
