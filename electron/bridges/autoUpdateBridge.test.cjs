const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

const BRIDGE_PATH = require.resolve("./autoUpdateBridge.cjs");
const WINDOW_MANAGER_PATH = require.resolve("./windowManager.cjs");
const GLOBAL_SHORTCUT_PATH = require.resolve("./globalShortcutBridge.cjs");
const DIRTY_EDITOR_GUARD_PATH = require.resolve("./dirtyEditorGuard.cjs");

// electron-updater pulls in native/electron-only code, so it can't be required
// in a plain `node --test` process. We intercept the bare `electron-updater`
// specifier and the bridge's lazy sibling requires at load time and hand back
// lightweight fakes. The patch stays installed for the whole test body because
// the bridge resolves electron-updater / windowManager / globalShortcutBridge
// lazily at IPC-invoke time, not at module load.
const ELECTRON_UPDATER_ID = "electron-updater";

/**
 * Run `fn` with electron-updater, windowManager, and globalShortcutBridge
 * replaced by the supplied fakes. The fakes are also exposed to `fn` so it can
 * assert on their interactions. Restores Module._load and the bridge cache on
 * exit so tests stay isolated.
 */
async function withMocks({ autoUpdater, autoUpdaterExports, windowManager, globalShortcutBridge, dirtyEditorGuard, browserWindows } = {}, fn) {
  const fakeAutoUpdater = autoUpdater || {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    logger: undefined,
    on() {},
    quitAndInstall() {},
  };
  const fakeWindowManager = windowManager || {
    calls: [],
    setQuittingForUpdate(value) {
      this.calls.push(value);
    },
    isQuittingForUpdate() {
      return this.calls[this.calls.length - 1] === true;
    },
  };
  const fakeGlobalShortcut = globalShortcutBridge || {
    cleanupCount: 0,
    cleanup() {
      this.cleanupCount += 1;
    },
  };
  // Default: no dirty-editor guard override. The bridge requires the real
  // dirtyEditorGuard.cjs (harmless — it only resolves ipcMain lazily, and the
  // install handler only reaches it when there's a reachable main window). Most
  // tests don't supply a main window, so the guard is never invoked.
  const fakeDirtyEditorGuard = dirtyEditorGuard;

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === ELECTRON_UPDATER_ID) {
      // autoUpdaterExports lets a test simulate a broken electron-updater
      // (e.g. {} with no autoUpdater) so getAutoUpdater() resolves to null.
      return autoUpdaterExports !== undefined
        ? autoUpdaterExports
        : { autoUpdater: fakeAutoUpdater };
    }
    if (parent && parent.filename === BRIDGE_PATH) {
      const resolved = path.resolve(path.dirname(BRIDGE_PATH), request);
      const withExt = resolved.endsWith(".cjs") ? resolved : `${resolved}.cjs`;
      if (withExt === WINDOW_MANAGER_PATH) return fakeWindowManager;
      if (withExt === GLOBAL_SHORTCUT_PATH) return fakeGlobalShortcut;
      if (withExt === DIRTY_EDITOR_GUARD_PATH && fakeDirtyEditorGuard) {
        return fakeDirtyEditorGuard;
      }
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  delete require.cache[BRIDGE_PATH];
  try {
    const bridge = require("./autoUpdateBridge.cjs");
    // Provide a minimal electronModule so readAutoUpdatePreference and
    // broadcastToAllWindows don't throw. getPath returns a throwaway dir; the
    // pref read falls back to its default when the file is absent.
    const fakeApp = {
      getPath: () => path.join("/", "tmp", "nc-autoupdate-test"),
      getVersion: () => "1.1.17",
    };
    bridge.init({
      electronModule: {
        app: fakeApp,
        // browserWindows lets a test observe broadcastToAllWindows (used by the
        // needs-save notice). Defaults to none.
        BrowserWindow: { getAllWindows: () => browserWindows || [] },
      },
    });
    // Await so the Module._load patch stays installed for the *entire* test
    // body, including after the now-async install handler yields on its first
    // `await` (otherwise the lazy windowManager/dirtyEditorGuard requires would
    // resolve the real modules once the finally below restored Module._load).
    return await fn({ bridge, fakeAutoUpdater, fakeWindowManager, fakeGlobalShortcut });
  } finally {
    Module._load = originalLoad;
    delete require.cache[BRIDGE_PATH];
  }
}

/**
 * A fake BrowserWindow for broadcastToAllWindows() (used by the needs-save
 * notice). Records every channel sent to its webContents so a test can assert
 * whether netcatty:update:needs-save was broadcast.
 */
function makeBroadcastWindow() {
  const sentChannels = [];
  return {
    sentChannels,
    isDestroyed() {
      return false;
    },
    webContents: {
      send(channel) {
        sentChannels.push(channel);
      },
    },
  };
}

/**
 * Build a fake windowManager that also exposes a main window whose webContents
 * the install handler can query for dirty editors. `sentChannels` records every
 * webContents.send() on the *main window* (i.e. the dirty-editor query), kept
 * separate from broadcast windows so tests can distinguish the two.
 */
function makeWindowManagerWithMainWindow() {
  const sentChannels = [];
  const webContents = {
    send(channel) {
      sentChannels.push(channel);
    },
    isDestroyed() {
      return false;
    },
    isCrashed() {
      return false;
    },
  };
  return {
    calls: [],
    sentChannels,
    webContents,
    setQuittingForUpdate(value) {
      this.calls.push(value);
    },
    isQuittingForUpdate() {
      return this.calls[this.calls.length - 1] === true;
    },
    getMainWindow() {
      return {
        webContents,
        isDestroyed() {
          return false;
        },
      };
    },
    getMainWindows() {
      return [this.getMainWindow()];
    },
  };
}

function makeWindowManagerWithMainWindows(count) {
  const windows = Array.from({ length: count }, (_unused, index) => {
    const sentChannels = [];
    const webContents = {
      id: index + 1,
      sentChannels,
      send(channel) {
        sentChannels.push(channel);
      },
      isDestroyed() {
        return false;
      },
      isCrashed() {
        return false;
      },
    };
    return {
      webContents,
      isDestroyed() {
        return false;
      },
    };
  });
  return {
    calls: [],
    windows,
    setQuittingForUpdate(value) {
      this.calls.push(value);
    },
    isQuittingForUpdate() {
      return this.calls[this.calls.length - 1] === true;
    },
    getMainWindow() {
      return windows[0] || null;
    },
    getMainWindows() {
      return windows;
    },
  };
}

/**
 * Minimal ipcMain stand-in that captures the handlers the bridge registers so a
 * test can invoke a single channel directly.
 */
function makeIpcMain() {
  const handlers = new Map();
  return {
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
    on() {},
    invoke(channel, ...args) {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`No handler registered for ${channel}`);
      return handler({}, ...args);
    },
    has(channel) {
      return handlers.has(channel);
    },
  };
}

test("install handler marks quitting-for-update before quitAndInstall", async () => {
  const order = [];
  const autoUpdater = {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    logger: undefined,
    on() {},
    quitAndInstall(isSilent, isForceRunAfter) {
      order.push("quitAndInstall");
      autoUpdater._installArgs = [isSilent, isForceRunAfter];
    },
  };
  const fakeWindowManager = {
    calls: [],
    setQuittingForUpdate(value) {
      order.push("setQuittingForUpdate");
      this.calls.push(value);
    },
    isQuittingForUpdate() {
      return this.calls[this.calls.length - 1] === true;
    },
  };

  await withMocks({ autoUpdater, windowManager: fakeWindowManager }, async ({ bridge, fakeGlobalShortcut }) => {
    const ipcMain = makeIpcMain();
    bridge.registerHandlers(ipcMain);
    await ipcMain.invoke("netcatty:update:install");

    // The flag must be set with `true`...
    assert.deepEqual(fakeWindowManager.calls, [true]);
    // ...and it must happen BEFORE quitAndInstall fires app.quit(), otherwise the
    // close-to-tray / before-quit guards would already be racing the quit (#1215).
    assert.equal(order[0], "setQuittingForUpdate");
    assert.ok(order.indexOf("setQuittingForUpdate") < order.indexOf("quitAndInstall"));
    // Tray cleanup still runs so the tray doesn't keep the process alive.
    assert.equal(fakeGlobalShortcut.cleanupCount, 1);
    assert.equal(order.includes("quitAndInstall"), true);
  });
});

test("install handler is a no-op when the updater fails to load", async () => {
  const fakeWindowManager = {
    calls: [],
    setQuittingForUpdate(value) {
      this.calls.push(value);
    },
    isQuittingForUpdate() {
      return false;
    },
  };
  // electron-updater exports no `autoUpdater` => getAutoUpdater() returns null,
  // so the handler must return early WITHOUT committing the app to a quit. Doing
  // so otherwise would leave isQuitting=true and break close-to-tray even though
  // no install actually started.
  await withMocks({ autoUpdaterExports: {}, windowManager: fakeWindowManager }, async ({ bridge, fakeGlobalShortcut }) => {
    const ipcMain = makeIpcMain();
    bridge.registerHandlers(ipcMain);
    await ipcMain.invoke("netcatty:update:install");

    assert.deepEqual(fakeWindowManager.calls, []);
    assert.equal(fakeGlobalShortcut.cleanupCount, 0);
  });
});

test("install handler rolls back quitting-for-update when quitAndInstall throws", async () => {
  const autoUpdater = {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    logger: undefined,
    on() {},
    quitAndInstall() {
      throw new Error("boom");
    },
  };
  const fakeWindowManager = {
    calls: [],
    setQuittingForUpdate(value) {
      this.calls.push(value);
    },
    isQuittingForUpdate() {
      return this.calls[this.calls.length - 1] === true;
    },
  };

  await withMocks({ autoUpdater, windowManager: fakeWindowManager }, async ({ bridge }) => {
    const ipcMain = makeIpcMain();
    bridge.registerHandlers(ipcMain);
    await ipcMain.invoke("netcatty:update:install");

    // First set true (commit), then reset to false on the synchronous throw so
    // the app doesn't get stuck bypassing close-to-tray / the quit guard (#1215).
    assert.deepEqual(fakeWindowManager.calls, [true, false]);
    assert.equal(fakeWindowManager.isQuittingForUpdate(), false);
  });
});

test("install handler watchdog clears quitting-for-update if the app never quits", async () => {
  const autoUpdater = {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    logger: undefined,
    on() {},
    // Returns without ever quitting the app (simulates a Squirrel follow-up
    // failure / stale download where app.quit() is never reached).
    quitAndInstall() {},
  };
  const fakeWindowManager = {
    calls: [],
    setQuittingForUpdate(value) {
      this.calls.push(value);
    },
    isQuittingForUpdate() {
      return this.calls[this.calls.length - 1] === true;
    },
  };

  // Capture the watchdog timer instead of waiting for the real delay.
  const originalSetTimeout = global.setTimeout;
  let watchdogFn = null;
  global.setTimeout = (fn) => {
    watchdogFn = fn;
    // Return a fake timer handle with an unref() no-op so the bridge can call it.
    return { unref() {} };
  };

  try {
    await withMocks({ autoUpdater, windowManager: fakeWindowManager }, async ({ bridge }) => {
      const ipcMain = makeIpcMain();
      bridge.registerHandlers(ipcMain);
      await ipcMain.invoke("netcatty:update:install");

      // Committed to quit, watchdog scheduled but not yet fired.
      assert.deepEqual(fakeWindowManager.calls, [true]);
      assert.equal(typeof watchdogFn, "function");

      // Fire the watchdog — the app is still alive, so it must clear the flag.
      watchdogFn();
      assert.deepEqual(fakeWindowManager.calls, [true, false]);
      assert.equal(fakeWindowManager.isQuittingForUpdate(), false);
    });
  } finally {
    global.setTimeout = originalSetTimeout;
  }
});

// ---------------------------------------------------------------------------
// #1215 P1: the install handler must check for unsaved editors BEFORE
// committing to a quit. On macOS quitAndInstall() closes the window first and
// only then fires before-quit, so the before-quit dirty guard can run after the
// window is gone and silently drop unsaved SFTP edits. Checking up front (while
// the renderer is alive) is the fix.
// ---------------------------------------------------------------------------

test("install handler aborts and notifies when the renderer reports dirty editors", async () => {
  const order = [];
  const autoUpdater = {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    logger: undefined,
    on() {},
    quitAndInstall() {
      order.push("quitAndInstall");
    },
  };
  const fakeWindowManager = makeWindowManagerWithMainWindow();
  const originalSetQuitting = fakeWindowManager.setQuittingForUpdate;
  fakeWindowManager.setQuittingForUpdate = function (value) {
    order.push("setQuittingForUpdate");
    originalSetQuitting.call(this, value);
  };
  // queryDirtyEditors reports unsaved work.
  let queriedWebContents = null;
  const fakeDirtyEditorGuard = {
    queryDirtyEditors(webContents) {
      order.push("queryDirtyEditors");
      queriedWebContents = webContents;
      return Promise.resolve(true);
    },
  };
  // Two windows (e.g. main + settings) so we can assert the needs-save notice is
  // broadcast to BOTH, not just the queried main window (#1215 review).
  const win1 = makeBroadcastWindow();
  const win2 = makeBroadcastWindow();

  await withMocks(
    {
      autoUpdater,
      windowManager: fakeWindowManager,
      dirtyEditorGuard: fakeDirtyEditorGuard,
      browserWindows: [win1, win2],
    },
    async ({ bridge, fakeGlobalShortcut }) => {
      const ipcMain = makeIpcMain();
      bridge.registerHandlers(ipcMain);
      await ipcMain.invoke("netcatty:update:install");

      // Dirty editors → the install must be fully aborted:
      // - no quitAndInstall, no setQuittingForUpdate, no tray cleanup
      assert.equal(order.includes("quitAndInstall"), false);
      assert.equal(order.includes("setQuittingForUpdate"), false);
      assert.deepEqual(fakeWindowManager.calls, []);
      assert.equal(fakeGlobalShortcut.cleanupCount, 0);
      // - every window is told to prompt the user to save (broadcast needs-save)
      assert.equal(win1.sentChannels.includes("netcatty:update:needs-save"), true);
      assert.equal(win2.sentChannels.includes("netcatty:update:needs-save"), true);
      // - the dirty check ran first, against the main window's webContents
      assert.equal(order[0], "queryDirtyEditors");
      assert.equal(queriedWebContents, fakeWindowManager.webContents);
    },
  );
});

test("install handler checks every main window before installing", async () => {
  const order = [];
  const autoUpdater = {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    logger: undefined,
    on() {},
    quitAndInstall() {
      order.push("quitAndInstall");
    },
  };
  const fakeWindowManager = makeWindowManagerWithMainWindows(2);
  const queriedWebContents = [];
  const fakeDirtyEditorGuard = {
    queryDirtyEditors(webContents) {
      order.push(`queryDirtyEditors:${webContents.id}`);
      queriedWebContents.push(webContents);
      return Promise.resolve(webContents.id === 2);
    },
  };
  const win = makeBroadcastWindow();

  await withMocks(
    {
      autoUpdater,
      windowManager: fakeWindowManager,
      dirtyEditorGuard: fakeDirtyEditorGuard,
      browserWindows: [win],
    },
    async ({ bridge, fakeGlobalShortcut }) => {
      const ipcMain = makeIpcMain();
      bridge.registerHandlers(ipcMain);
      await ipcMain.invoke("netcatty:update:install");

      assert.deepEqual(queriedWebContents, fakeWindowManager.windows.map((window) => window.webContents));
      assert.equal(order.includes("quitAndInstall"), false);
      assert.deepEqual(fakeWindowManager.calls, []);
      assert.equal(fakeGlobalShortcut.cleanupCount, 0);
      assert.equal(win.sentChannels.includes("netcatty:update:needs-save"), true);
    },
  );
});

test("install handler proceeds to quitAndInstall when there are no dirty editors", async () => {
  const order = [];
  const autoUpdater = {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    logger: undefined,
    on() {},
    quitAndInstall() {
      order.push("quitAndInstall");
    },
  };
  const fakeWindowManager = makeWindowManagerWithMainWindow();
  const originalSetQuitting = fakeWindowManager.setQuittingForUpdate;
  fakeWindowManager.setQuittingForUpdate = function (value) {
    order.push("setQuittingForUpdate");
    originalSetQuitting.call(this, value);
  };
  // queryDirtyEditors reports a clean editor state.
  const fakeDirtyEditorGuard = {
    queryDirtyEditors() {
      order.push("queryDirtyEditors");
      return Promise.resolve(false);
    },
  };
  const win = makeBroadcastWindow();

  // Capture the watchdog so the test doesn't wait on the real 10s timer.
  const originalSetTimeout = global.setTimeout;
  global.setTimeout = () => ({ unref() {} });
  try {
    await withMocks(
      {
        autoUpdater,
        windowManager: fakeWindowManager,
        dirtyEditorGuard: fakeDirtyEditorGuard,
        browserWindows: [win],
      },
      async ({ bridge, fakeGlobalShortcut }) => {
        const ipcMain = makeIpcMain();
        bridge.registerHandlers(ipcMain);
        await ipcMain.invoke("netcatty:update:install");

        // Clean editors → install runs as before:
        // dirty check first, then commit-to-quit, then quitAndInstall.
        assert.equal(order[0], "queryDirtyEditors");
        assert.deepEqual(fakeWindowManager.calls, [true]);
        assert.ok(order.indexOf("setQuittingForUpdate") < order.indexOf("quitAndInstall"));
        assert.equal(order.includes("quitAndInstall"), true);
        assert.equal(fakeGlobalShortcut.cleanupCount, 1);
        // No needs-save broadcast when nothing is dirty.
        assert.equal(win.sentChannels.includes("netcatty:update:needs-save"), false);
      },
    );
  } finally {
    global.setTimeout = originalSetTimeout;
  }
});

test("install handler installs directly when no main window is reachable", async () => {
  const order = [];
  const autoUpdater = {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    logger: undefined,
    on() {},
    quitAndInstall() {
      order.push("quitAndInstall");
    },
  };
  // Default fake windowManager has no getMainWindow() → getMainWebContents()
  // returns null → there's no user to ask, so the install must proceed without
  // ever calling queryDirtyEditors (matches the before-quit fail-open path).
  let dirtyCheckCalled = false;
  const fakeDirtyEditorGuard = {
    queryDirtyEditors() {
      dirtyCheckCalled = true;
      return Promise.resolve(true);
    },
  };

  const originalSetTimeout = global.setTimeout;
  global.setTimeout = () => ({ unref() {} });
  try {
    await withMocks(
      { autoUpdater, dirtyEditorGuard: fakeDirtyEditorGuard },
      async ({ bridge, fakeWindowManager }) => {
        const ipcMain = makeIpcMain();
        bridge.registerHandlers(ipcMain);
        await ipcMain.invoke("netcatty:update:install");

        assert.equal(dirtyCheckCalled, false);
        assert.deepEqual(fakeWindowManager.calls, [true]);
        assert.equal(order.includes("quitAndInstall"), true);
      },
    );
  } finally {
    global.setTimeout = originalSetTimeout;
  }
});
