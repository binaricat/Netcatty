const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

const BRIDGE_PATH = require.resolve("./autoUpdateBridge.cjs");
const WINDOW_MANAGER_PATH = require.resolve("./windowManager.cjs");
const GLOBAL_SHORTCUT_PATH = require.resolve("./globalShortcutBridge.cjs");

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
function withMocks({ autoUpdater, autoUpdaterExports, windowManager, globalShortcutBridge } = {}, fn) {
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
      electronModule: { app: fakeApp, BrowserWindow: { getAllWindows: () => [] } },
    });
    return fn({ bridge, fakeAutoUpdater, fakeWindowManager, fakeGlobalShortcut });
  } finally {
    Module._load = originalLoad;
    delete require.cache[BRIDGE_PATH];
  }
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

test("install handler marks quitting-for-update before quitAndInstall", () => {
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

  withMocks({ autoUpdater, windowManager: fakeWindowManager }, ({ bridge, fakeGlobalShortcut }) => {
    const ipcMain = makeIpcMain();
    bridge.registerHandlers(ipcMain);
    ipcMain.invoke("netcatty:update:install");

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

test("install handler is a no-op when the updater fails to load", () => {
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
  withMocks({ autoUpdaterExports: {}, windowManager: fakeWindowManager }, ({ bridge, fakeGlobalShortcut }) => {
    const ipcMain = makeIpcMain();
    bridge.registerHandlers(ipcMain);
    ipcMain.invoke("netcatty:update:install");

    assert.deepEqual(fakeWindowManager.calls, []);
    assert.equal(fakeGlobalShortcut.cleanupCount, 0);
  });
});

test("install handler rolls back quitting-for-update when quitAndInstall throws", () => {
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

  withMocks({ autoUpdater, windowManager: fakeWindowManager }, ({ bridge }) => {
    const ipcMain = makeIpcMain();
    bridge.registerHandlers(ipcMain);
    ipcMain.invoke("netcatty:update:install");

    // First set true (commit), then reset to false on the synchronous throw so
    // the app doesn't get stuck bypassing close-to-tray / the quit guard (#1215).
    assert.deepEqual(fakeWindowManager.calls, [true, false]);
    assert.equal(fakeWindowManager.isQuittingForUpdate(), false);
  });
});

test("install handler watchdog clears quitting-for-update if the app never quits", () => {
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
    withMocks({ autoUpdater, windowManager: fakeWindowManager }, ({ bridge }) => {
      const ipcMain = makeIpcMain();
      bridge.registerHandlers(ipcMain);
      ipcMain.invoke("netcatty:update:install");

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
