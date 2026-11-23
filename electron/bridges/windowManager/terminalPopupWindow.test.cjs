"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createAppContentWindowClosedHandler } = require("../../appWindowLifecycle.cjs");
const { createTerminalPopupWindowApi } = require("./terminalPopupWindow.cjs");
const {
  failAttachPopupAuthorization,
  markAttachPopupAttached,
  markAttachPopupClosePrepared,
  markAttachPopupReady,
  setRestoreAttachedSessionOutput,
} = require("../terminalAttachRestore.cjs");

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

test("a system-manager shell popup is placed beside the panel instead of over it", async () => {
  let created = null;
  class PlacedBrowserWindowStub {
    constructor(options) {
      created = options;
      this.handlers = new Map();
      this.webContents = { id: 77, on() {}, send() {}, setWindowOpenHandler() {} };
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
    resolveSettingsWindowBounds() { return { x: 260, y: 160 }; },
    createExternalOnlyWindowOpenHandler() { return {}; },
    applyWindowOpacityToWindow() {},
    getDevRendererBaseUrl(url) { return url; },
    showAndFocusWindow() {},
    registerAppContentWindow() {},
    unregisterAppContentWindow() {},
    notifyAppContentWindowClosed() {},
  });

  await api.openTerminalPopupWindow(
    {
      BrowserWindow: PlacedBrowserWindowStub,
      nativeTheme: {},
      shell: {},
      screen: {
        getDisplayMatching() {
          return { workArea: { x: 0, y: 0, width: 1440, height: 900 } };
        },
      },
    },
    {
      preload: "/tmp/preload.cjs",
      isDev: false,
      appIcon: null,
      isMac: false,
      electronDir: __dirname,
      sourceWindow: {
        isDestroyed() { return false; },
        getContentBounds() { return { x: 0, y: 0, width: 1440, height: 900 }; },
        webContents: { getZoomFactor() { return 1; } },
      },
    },
    {
      popupId: "shell-popup",
      title: "pod: multi-box",
      avoidClientRect: { x: 1000, y: 40, width: 440, height: 860 },
    },
  );

  assert.ok(created);
  assert.ok(created.x + created.width <= 1000);
  assert.equal(created.width, 920);
  assert.notEqual(created.x, 260);
});

test("moved-tab popup skips crash restoration and close handoff after its source window closes", async () => {
  const restored = [];
  setRestoreAttachedSessionOutput(async (sessionId) => {
    restored.push(sessionId);
    return { success: true, restored: true };
  });
  try {
    let sourceDestroyed = false;
    const sourceMessages = [];
    const sourceWindow = {
      isDestroyed() { return sourceDestroyed; },
      webContents: {
        send(channel, payload) { sourceMessages.push({ channel, payload }); },
      },
    };
    const otherMainWindow = {
      isDestroyed() { return false; },
      webContents: { send() {} },
    };

    const popupWindows = [];
    let attachOutcomeMode = "succeed";
    let shownCount = 0;
    class MovePopupWindowStub {
      constructor() {
        popupWindows.push(this);
        this.destroyed = false;
        this.handlers = new Map();
        this.webContentsHandlers = new Map();
        this.sent = [];
        const wcId = 90 + popupWindows.length;
        this.webContents = {
          id: wcId,
          on: (channel, handler) => { this.webContentsHandlers.set(channel, handler); },
          send: (channel, payload) => {
            this.sent.push({ channel, payload });
            if (channel === "netcatty:window:terminalPopupConfig" && payload?.attachAuthorization) {
              queueMicrotask(() => {
                if (attachOutcomeMode === "fail") {
                  failAttachPopupAuthorization(payload.attachAuthorization, payload.attachSessionId, wcId, "Session exited");
                } else if (attachOutcomeMode === "rebind-then-fail") {
                  markAttachPopupAttached(payload.attachAuthorization, payload.attachSessionId, wcId);
                  failAttachPopupAuthorization(payload.attachAuthorization, payload.attachSessionId, wcId, "Reattach failed");
                } else {
                  markAttachPopupAttached(payload.attachAuthorization, payload.attachSessionId, wcId);
                  markAttachPopupReady(payload.attachAuthorization, payload.attachSessionId, wcId);
                }
              });
            }
          },
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
      mainWindow: otherMainWindow,
      currentTheme: "light",
      V8_CACHE_OPTIONS: "bypassHeatCheck",
      resolveFrontendBackgroundColor() { return "#fff"; },
      resolveSettingsWindowBounds() { return {}; },
      createExternalOnlyWindowOpenHandler() { return {}; },
      applyWindowOpacityToWindow() {},
      getDevRendererBaseUrl(url) { return url; },
      showAndFocusWindow() { shownCount += 1; },
      registerAppContentWindow() {},
      unregisterAppContentWindow() {},
      notifyAppContentWindowClosed() {},
    });

    // 1) Renderer crash after sourceWindow is destroyed must NOT restore to another main window.
    await api.openTerminalPopupWindow(
      { BrowserWindow: MovePopupWindowStub, nativeTheme: {}, shell: {} },
      { preload: "/tmp/preload.cjs", isDev: false, appIcon: null, isMac: false, electronDir: __dirname, sourceWindow },
      { popupId: "move-crash", title: "Moved", attachSessionId: "s-crash", moveSession: true, sourceSession: { id: "s-crash" } },
    );
    sourceDestroyed = true;
    popupWindows[0].webContentsHandlers.get("render-process-gone")?.({}, { reason: "crashed" });
    assert.equal(popupWindows[0].destroyed, true);
    assert.deepEqual(restored, []);
    assert.deepEqual(sourceMessages, []);

    // 2) Normal close after sourceWindow is destroyed must NOT stall waiting on prepare-close.
    await api.openTerminalPopupWindow(
      { BrowserWindow: MovePopupWindowStub, nativeTheme: {}, shell: {} },
      { preload: "/tmp/preload.cjs", isDev: false, appIcon: null, isMac: false, electronDir: __dirname, sourceWindow },
      { popupId: "move-close", title: "Moved 2", attachSessionId: "s-close", moveSession: true, sourceSession: { id: "s-close" } },
    );
    api.closeTerminalPopupWindow("move-close");
    assert.equal(popupWindows[1].destroyed, true);
    assert.equal(
      popupWindows[1].sent.some((entry) => entry.channel === "netcatty:terminal-popup:prepare-close"),
      false,
    );
    assert.deepEqual(restored, []);

    // 3) Attachment failure during startup destroys the popup without showing it and returns failure.
    sourceDestroyed = false;
    attachOutcomeMode = "fail";
    const shownBeforeFail = shownCount;
    const failedResult = await api.openTerminalPopupWindow(
      { BrowserWindow: MovePopupWindowStub, nativeTheme: {}, shell: {} },
      { preload: "/tmp/preload.cjs", isDev: false, appIcon: null, isMac: false, electronDir: __dirname, sourceWindow },
      { popupId: "move-fail", title: "Moved 3", attachSessionId: "s-fail", moveSession: true, sourceSession: { id: "s-fail" } },
    );
    assert.deepEqual(failedResult, { success: false, error: "Session exited" });
    assert.equal(popupWindows[2].destroyed, true);
    assert.equal(shownCount, shownBeforeFail);

    // 4) Failure after rebindOutput (before renderer confirms reattach) still fails the move.
    attachOutcomeMode = "rebind-then-fail";
    const rebindFailResult = await api.openTerminalPopupWindow(
      { BrowserWindow: MovePopupWindowStub, nativeTheme: {}, shell: {} },
      { preload: "/tmp/preload.cjs", isDev: false, appIcon: null, isMac: false, electronDir: __dirname, sourceWindow },
      { popupId: "move-rebind-fail", title: "Moved 4", attachSessionId: "s-rebind-fail", moveSession: true, sourceSession: { id: "s-rebind-fail" } },
    );
    assert.deepEqual(rebindFailResult, { success: false, error: "Reattach failed" });
    assert.equal(popupWindows[3].destroyed, true);
    assert.equal(shownCount, shownBeforeFail);
  } finally {
    setRestoreAttachedSessionOutput(null);
  }
});

test("attach-closed notification waits until async output restoration succeeds", async () => {
  let restoreAttempt = 0;
  let resolveFirstRestore = null;
  setRestoreAttachedSessionOutput((sessionId) => {
    restoreAttempt += 1;
    if (restoreAttempt === 1) {
      return new Promise((resolve) => {
        resolveFirstRestore = () => resolve({ success: false, restored: false, error: "temporary" });
      });
    }
    return Promise.resolve({ success: true, restored: true, sessionId });
  });
  try {
    const sourceMessages = [];
    const sourceWindow = {
      isDestroyed() { return false; },
      webContents: { send(channel, payload) { sourceMessages.push({ channel, payload }); } },
    };
    let popupWin;
    class AsyncRestoreStub {
      constructor() {
        popupWin = this;
        this.destroyed = false;
        this.handlers = new Map();
        this.webContents = {
          id: 120,
          on() {},
          send(channel, payload) {
            if (channel === "netcatty:window:terminalPopupConfig" && payload?.attachAuthorization) {
              queueMicrotask(() => {
                markAttachPopupAttached(payload.attachAuthorization, payload.attachSessionId, 120);
                markAttachPopupReady(payload.attachAuthorization, payload.attachSessionId, 120);
              });
            }
          },
          setWindowOpenHandler() {},
        };
      }
      on(channel, handler) { this.handlers.set(channel, handler); }
      isDestroyed() { return this.destroyed; }
      isVisible() { return true; }
      loadURL() { return Promise.resolve(); }
      setBackgroundColor() {}
      destroy() {
        this.destroyed = true;
        this.handlers.get("closed")?.();
      }
    }

    const api = createTerminalPopupWindowApi({
      mainWindow: sourceWindow,
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
      { BrowserWindow: AsyncRestoreStub, nativeTheme: {}, shell: {} },
      { preload: "/tmp/preload.cjs", isDev: false, appIcon: null, isMac: false, electronDir: __dirname, sourceWindow },
      { popupId: "move-async-restore", title: "Moved", attachSessionId: "s-async", moveSession: true, sourceSession: { id: "s-async" } },
    );
    popupWin.destroy();
    await Promise.resolve();
    assert.deepEqual(sourceMessages, [], "must not unhide tab while restore is in flight");

    resolveFirstRestore();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(sourceMessages, [], "must not unhide tab after failed restore");

    // Scheduled automatic retry recovers without requiring another display-ready signal.
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(restoreAttempt, 2);
    assert.deepEqual(sourceMessages, [{
      channel: "netcatty:terminal-popup:attach-closed",
      payload: { sessionId: "s-async" },
    }]);
  } finally {
    setRestoreAttachedSessionOutput(null);
  }
});

test("reopening a moved tab cancels stale close notifications from an earlier crashed popup", async () => {
  let restoreAttempt = 0;
  setRestoreAttachedSessionOutput(() => {
    restoreAttempt += 1;
    if (restoreAttempt === 1) {
      return Promise.resolve({ success: false, restored: false, error: "temporary" });
    }
    return Promise.resolve({ success: true, restored: true });
  });
  try {
    const sourceMessages = [];
    const sourceWindow = {
      isDestroyed() { return false; },
      webContents: { send(channel, payload) { sourceMessages.push({ channel, payload }); } },
    };
    const popups = [];
    class ReopenStub {
      constructor() {
        popups.push(this);
        this.destroyed = false;
        this.handlers = new Map();
        const wcId = 130 + popups.length;
        this.webContents = {
          id: wcId,
          on() {},
          send(channel, payload) {
            if (channel === "netcatty:window:terminalPopupConfig" && payload?.attachAuthorization) {
              queueMicrotask(() => {
                markAttachPopupAttached(payload.attachAuthorization, payload.attachSessionId, wcId);
                markAttachPopupReady(payload.attachAuthorization, payload.attachSessionId, wcId);
              });
            }
          },
          setWindowOpenHandler() {},
        };
      }
      on(channel, handler) { this.handlers.set(channel, handler); }
      isDestroyed() { return this.destroyed; }
      isVisible() { return true; }
      loadURL() { return Promise.resolve(); }
      setBackgroundColor() {}
      destroy() {
        this.destroyed = true;
        this.handlers.get("closed")?.();
      }
    }

    const api = createTerminalPopupWindowApi({
      mainWindow: sourceWindow,
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
      { BrowserWindow: ReopenStub, nativeTheme: {}, shell: {} },
      { preload: "/tmp/preload.cjs", isDev: false, appIcon: null, isMac: false, electronDir: __dirname, sourceWindow },
      { popupId: "move-old", title: "Old", attachSessionId: "s-reopen", moveSession: true, sourceSession: { id: "s-reopen" } },
    );
    popups[0].destroy();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(sourceMessages, []);

    // Reopen before the old popup's retry timer fires.
    await api.openTerminalPopupWindow(
      { BrowserWindow: ReopenStub, nativeTheme: {}, shell: {} },
      { preload: "/tmp/preload.cjs", isDev: false, appIcon: null, isMac: false, electronDir: __dirname, sourceWindow },
      { popupId: "move-new", title: "New", attachSessionId: "s-reopen", moveSession: true, sourceSession: { id: "s-reopen" } },
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.deepEqual(sourceMessages, [], "stale popup must not unhide the tab while the new popup owns it");
    popups[1].destroy();
  } finally {
    setRestoreAttachedSessionOutput(null);
  }
});
