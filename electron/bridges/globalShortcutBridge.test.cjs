const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

function withPatchedTimers(run) {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  let nextTimerId = 1;
  const timers = new Map();

  global.setTimeout = (fn, _delay, ...args) => {
    const id = nextTimerId++;
    timers.set(id, () => fn(...args));
    return id;
  };

  global.clearTimeout = (id) => {
    timers.delete(id);
  };

  const flushNextTimer = () => {
    const nextEntry = timers.entries().next().value;
    if (!nextEntry) return false;
    const [id, fn] = nextEntry;
    timers.delete(id);
    fn();
    return true;
  };

  const getPendingTimerCount = () => timers.size;

  return Promise.resolve()
    .then(() => run({ flushNextTimer, getPendingTimerCount }))
    .finally(() => {
      global.setTimeout = originalSetTimeout;
      global.clearTimeout = originalClearTimeout;
    });
}

function withPatchedDateNow(initialValue, run) {
  const originalDateNow = Date.now;
  let currentValue = initialValue;

  Date.now = () => currentValue;

  return Promise.resolve()
    .then(() =>
      run({
        setNow(nextValue) {
          currentValue = nextValue;
        },
      }))
    .finally(() => {
      Date.now = originalDateNow;
    });
}

function loadBridge() {
  const bridgePath = require.resolve("./globalShortcutBridge.cjs");
  delete require.cache[bridgePath];
  return require("./globalShortcutBridge.cjs");
}

function createElectronStub() {
  class FakeTray {
    constructor() {
      this.handlers = new Map();
      this.contextMenu = null;
      this.contextMenuPopped = false;
    }

    setToolTip() {}
    setContextMenu(menu) {
      this.contextMenu = menu;
    }
    popUpContextMenu() {
      this.contextMenuPopped = true;
    }
    destroy() {}

    on(eventName, handler) {
      this.handlers.set(eventName, handler);
    }
  }

  return {
    Tray: FakeTray,
    Menu: {
      buildFromTemplate(template) {
        return { template };
      },
    },
    BrowserWindow: {
      getAllWindows() {
        return [];
      },
    },
    globalShortcut: {
      register() {
        return true;
      },
      unregister() {},
    },
    nativeImage: {
      createFromPath() {
        return {
          resize() {
            return this;
          },
          setTemplateImage() {},
          addRepresentation() {},
        };
      },
      createEmpty() {
        return {};
      },
    },
    app: {
      dock: {
        menu: null,
        setMenu(menu) {
          this.menu = menu;
        },
      },
      getAppPath() {
        return process.cwd();
      },
      quit() {},
    },
  };
}

function createAppLockControllerStub(initialState = { locked: false, reason: null }) {
  const listeners = new Set();
  const state = {
    locked: initialState.locked === true,
    reason: initialState.reason ?? null,
  };
  return {
    setLockedCalls: [],
    state,
    setLocked(reason) {
      this.setLockedCalls.push(reason);
      state.locked = true;
      state.reason = reason;
      for (const listener of listeners) {
        try {
          listener({ ...state });
        } catch {
          // ignore
        }
      }
      return { ...state };
    },
    getRuntimeState() {
      return { ...state };
    },
    unlock() {
      state.locked = false;
      state.reason = null;
      for (const listener of listeners) {
        try {
          listener({ ...state });
        } catch {
          // ignore
        }
      }
      return { ...state };
    },
    subscribe(listener) {
      if (typeof listener !== "function") return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function createIpcMainStub() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
  };
}

class FakeWindow extends EventEmitter {
  constructor({ fullscreen = false } = {}) {
    super();
    this.fullscreen = fullscreen;
    this.hideCalls = 0;
    this.showCalls = 0;
    this.focusCalls = 0;
    this.restoreCalls = 0;
    this.setFullScreenCalls = [];
    this.destroyed = false;
    this.minimized = false;
    this.visible = true;
    this.focused = true;
    this.sentMessages = [];
    this.webContents = {
      send: (channel, ...args) => {
        this.sentMessages.push([channel, ...args]);
      },
    };
  }

  isDestroyed() {
    return this.destroyed;
  }

  isFullScreen() {
    return this.fullscreen;
  }

  setFullScreen(nextValue) {
    this.setFullScreenCalls.push(nextValue);
    if (nextValue) {
      this.fullscreen = true;
    }
  }

  isMinimized() {
    return this.minimized;
  }

  restore() {
    this.restoreCalls += 1;
    this.minimized = false;
  }

  isVisible() {
    return this.visible;
  }

  isFocused() {
    return this.focused;
  }

  hide() {
    this.hideCalls += 1;
    this.visible = false;
    this.focused = false;
  }

  show() {
    this.showCalls += 1;
    this.visible = true;
    this.emit("show");
  }

  focus() {
    this.focusCalls += 1;
    this.focused = true;
  }
}

async function withPlatform(platform, run) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

async function enableCloseToTray(bridge, electronModule = createElectronStub(), extraDeps = {}) {
  bridge.init({
    electronModule,
    getMainWindow: () => electronModule.BrowserWindow.getAllWindows()[0] ?? null,
    ...extraDeps,
  });
  const ipcMain = createIpcMainStub();
  bridge.registerHandlers(ipcMain);
  await ipcMain.handlers.get("netcatty:tray:setCloseToTray")(null, { enabled: true });
  return { ipcMain, electronModule };
}

test("handleWindowClose allows normal close when close-to-tray is disabled", () => {
  const bridge = loadBridge();
  const win = new FakeWindow();
  let prevented = false;

  const result = bridge.handleWindowClose({ preventDefault() { prevented = true; } }, win);

  assert.equal(result, false);
  assert.equal(prevented, false);
  assert.equal(win.hideCalls, 0);
});

test("close-to-tray on a mac fullscreen window defers hide until after leave-full-screen and the trailing show", async () => {
  // Observed macOS sequence after the red close on a fullscreen window:
  //   setFullScreen(false) → (animation) → leave-full-screen → trailing show
  // Hiding before the trailing show causes macOS to pop the window back
  // during the final space transition. The fix waits for the trailing show
  // (or a fallback timer) before calling win.hide().
  await withPatchedTimers(async ({ flushNextTimer, getPendingTimerCount }) => {
    await withPlatform("darwin", async () => {
      const bridge = loadBridge();
      await enableCloseToTray(bridge);

      const win = new FakeWindow({ fullscreen: true });
      let prevented = false;

      const result = bridge.handleWindowClose({ preventDefault() { prevented = true; } }, win);

      assert.equal(result, true);
      assert.equal(prevented, true);
      assert.deepEqual(win.setFullScreenCalls, [false]);
      assert.equal(win.hideCalls, 0);
      // Watchdog timer is pending. No show listener yet — macOS's
      // pre-leave-full-screen internal `show` events must not trigger hide.
      assert.equal(getPendingTimerCount(), 1);
      assert.equal(win.listenerCount("show"), 0);

      // Spurious early show (mid-animation) does nothing.
      win.emit("show");
      assert.equal(win.hideCalls, 0);
      assert.equal(getPendingTimerCount(), 1);

      // leave-full-screen arrives. Watchdog cancelled; now we arm a `show`
      // listener + trailing-show fallback timer. Still no hide.
      win.fullscreen = false;
      win.emit("leave-full-screen");
      assert.equal(win.hideCalls, 0);
      assert.equal(getPendingTimerCount(), 1);
      assert.equal(win.listenerCount("show"), 1);

      // Trailing show from macOS finalizing the space transition runs the hide.
      win.emit("show");
      assert.equal(win.hideCalls, 1);
      assert.equal(win.listenerCount("show"), 0);
      assert.equal(win.listenerCount("leave-full-screen"), 0);
      assert.equal(win.listenerCount("closed"), 0);
      assert.equal(getPendingTimerCount(), 0);
    });
  });
});

test("fallback timer hides the window when the trailing show never arrives", async () => {
  await withPatchedTimers(async ({ flushNextTimer, getPendingTimerCount }) => {
    await withPlatform("darwin", async () => {
      const bridge = loadBridge();
      await enableCloseToTray(bridge);

      const win = new FakeWindow({ fullscreen: true });

      bridge.handleWindowClose({ preventDefault() {} }, win);
      win.fullscreen = false;
      win.emit("leave-full-screen");

      // Watchdog cleared; trailing-show fallback timer is pending.
      assert.equal(getPendingTimerCount(), 1);
      assert.equal(win.hideCalls, 0);
      assert.equal(win.listenerCount("show"), 1);

      // No show ever arrives. Fallback timer runs.
      flushNextTimer();

      assert.equal(win.hideCalls, 1);
      assert.equal(win.listenerCount("show"), 0);
      assert.equal(getPendingTimerCount(), 0);
    });
  });
});

test("watchdog forces the hide path if leave-full-screen never arrives", async () => {
  await withPatchedTimers(async ({ flushNextTimer, getPendingTimerCount }) => {
    await withPlatform("darwin", async () => {
      const bridge = loadBridge();
      await enableCloseToTray(bridge);

      const win = new FakeWindow({ fullscreen: true });

      bridge.handleWindowClose({ preventDefault() {} }, win);
      assert.equal(getPendingTimerCount(), 1);

      // Watchdog fires (simulates 5s with no leave-full-screen). It forces
      // the leave path — which arms the trailing-show listener + fallback.
      flushNextTimer();
      assert.equal(win.hideCalls, 0);
      assert.equal(getPendingTimerCount(), 1);
      assert.equal(win.listenerCount("show"), 1);

      // Trailing-show fallback fires → hide.
      flushNextTimer();
      assert.equal(win.hideCalls, 1);
      assert.equal(getPendingTimerCount(), 0);
    });
  });
});

test("app activate clears a pending fullscreen hide", async () => {
  // Regression for the close-to-tray + fullscreen bug where the internal
  // `show` emitted during the fullscreen exit animation was cancelling the
  // hide. main.cjs's app.on("activate") handler now calls into this bridge
  // to cancel the pending hide when the user actually re-activates the app.
  await withPatchedTimers(async ({ flushNextTimer, getPendingTimerCount }) => {
    await withPlatform("darwin", async () => {
      const bridge = loadBridge();
      await enableCloseToTray(bridge);

      const win = new FakeWindow({ fullscreen: true });

      const result = bridge.handleWindowClose({ preventDefault() {} }, win);
      assert.equal(result, true);
      assert.equal(getPendingTimerCount(), 1);

      bridge.clearPendingFullscreenHide(win);

      assert.equal(getPendingTimerCount(), 0);
      assert.equal(win.listenerCount("leave-full-screen"), 0);
      assert.equal(win.listenerCount("closed"), 0);
      assert.deepEqual(bridge.__testOnly?.getAppLockController?.().setLockedCalls ?? [], []);
      assert.equal(flushNextTimer(), false);
      assert.equal(win.hideCalls, 0);
    });
  });
});

test("focusing a visible window cancels a pending fullscreen hide", async () => {
  await withPatchedTimers(async ({ getPendingTimerCount }) => {
    await withPlatform("darwin", async () => {
      const bridge = loadBridge();
      const electronModule = createElectronStub();
      const win = new FakeWindow({ fullscreen: true });
      win.focused = false;
      electronModule.BrowserWindow.getAllWindows = () => [win];
      let toggleWindow = null;
      electronModule.globalShortcut.register = (_accelerator, handler) => {
        toggleWindow = handler;
        return true;
      };
      const { ipcMain } = await enableCloseToTray(bridge, electronModule, {
        getMainWindow: () => win,
      });

      await ipcMain.handlers.get("netcatty:globalHotkey:register")(null, { hotkey: "Ctrl + `" });
      const result = bridge.handleWindowClose({ preventDefault() {} }, win);
      assert.equal(result, true);
      assert.equal(getPendingTimerCount(), 1);

      toggleWindow();

      assert.equal(win.focusCalls, 1);
      assert.equal(getPendingTimerCount(), 0);
      assert.equal(win.listenerCount("leave-full-screen"), 0);
      assert.equal(win.listenerCount("closed"), 0);
    });
  });
});

test("openMainWindow cancels a pending fullscreen hide before showing the window", async () => {
  await withPatchedTimers(async ({ flushNextTimer, getPendingTimerCount }) => {
    await withPlatform("darwin", async () => {
      const bridge = loadBridge();
      const electronModule = createElectronStub();
      const win = new FakeWindow({ fullscreen: true });
      win.show = function showWithoutEmit() {
        this.showCalls += 1;
        this.visible = true;
      };
      electronModule.BrowserWindow.getAllWindows = () => [win];
      const { ipcMain } = await enableCloseToTray(bridge, electronModule, {
        getMainWindow: () => win,
      });

      const result = bridge.handleWindowClose({ preventDefault() {} }, win);
      assert.equal(result, true);
      assert.equal(getPendingTimerCount(), 1);

      await ipcMain.handlers.get("netcatty:trayPanel:openMainWindow")();

      assert.equal(win.showCalls, 1);
      assert.equal(getPendingTimerCount(), 0);

      const flushed = flushNextTimer();
      assert.equal(flushed, false);
      assert.equal(win.hideCalls, 0);
    });
  });
});

test("openMainWindow notifies renderer to lock on reopen", async () => {
  const bridge = loadBridge();
  const electronModule = createElectronStub();
  const win = new FakeWindow();
  electronModule.BrowserWindow.getAllWindows = () => [win];
  const { ipcMain } = await enableCloseToTray(bridge, electronModule);

  await ipcMain.handlers.get("netcatty:trayPanel:openMainWindow")();

  assert.deepEqual(win.sentMessages, [["netcatty:app-lock:reopen"]]);
});

test("tray session menu reveal cancels a pending fullscreen hide before focusing a session", async () => {
  await withPatchedTimers(async ({ flushNextTimer, getPendingTimerCount }) => {
    const bridge = loadBridge();
    const electronModule = createElectronStub();
    const appLockController = createAppLockControllerStub();
    const win = new FakeWindow({ fullscreen: true });
    win.show = function showWithoutEmit() {
      this.showCalls += 1;
      this.visible = true;
    };
    electronModule.BrowserWindow.getAllWindows = () => [win];
    bridge.init({
      electronModule,
      getMainWindow: () => win,
      getAppLockController: () => appLockController,
    });
    const ipcMain = createIpcMainStub();
    bridge.registerHandlers(ipcMain);

    await withPlatform("darwin", async () => {
      await ipcMain.handlers.get("netcatty:tray:setCloseToTray")(null, { enabled: true });
      const result = bridge.handleWindowClose({ preventDefault() {} }, win);
      assert.equal(result, true);
      assert.equal(getPendingTimerCount(), 1);
    });

    await withPlatform("linux", async () => {
      await ipcMain.handlers.get("netcatty:tray:updateMenuData")(null, {
        sessions: [{ id: "s1", label: "dev", hostLabel: "dev.example", status: "connected" }],
      });

      const sessionItem = bridge.getTray().contextMenu.template
        .filter((item) => typeof item.click === "function")
        .find((item) => String(item.label).includes("dev.example"));
      sessionItem.click();
      await Promise.resolve();

      assert.equal(win.showCalls, 1);
      assert.equal(getPendingTimerCount(), 0);
      assert.equal(win.listenerCount("leave-full-screen"), 0);
      assert.equal(win.listenerCount("closed"), 0);
      assert.equal(flushNextTimer(), false);
      assert.equal(win.hideCalls, 0);
      assert.deepEqual(appLockController.setLockedCalls, []);
      assert.deepEqual(win.sentMessages.slice(0, 2), [
        ["netcatty:app-lock:reopen"],
        ["netcatty:tray:focusSession", "s1"],
      ]);
    });
  });
});

test("tray port-forward menu reveal cancels a pending fullscreen hide before toggling", async () => {
  await withPatchedTimers(async ({ flushNextTimer, getPendingTimerCount }) => {
    const bridge = loadBridge();
    const electronModule = createElectronStub();
    const appLockController = createAppLockControllerStub();
    const win = new FakeWindow({ fullscreen: true });
    win.show = function showWithoutEmit() {
      this.showCalls += 1;
      this.visible = true;
    };
    electronModule.BrowserWindow.getAllWindows = () => [win];
    bridge.init({
      electronModule,
      getAppLockController: () => appLockController,
    });
    const ipcMain = createIpcMainStub();
    bridge.registerHandlers(ipcMain);

    await withPlatform("darwin", async () => {
      await ipcMain.handlers.get("netcatty:tray:setCloseToTray")(null, { enabled: true });
      const result = bridge.handleWindowClose({ preventDefault() {} }, win);
      assert.equal(result, true);
      assert.equal(getPendingTimerCount(), 1);
    });

    await withPlatform("linux", async () => {
      await ipcMain.handlers.get("netcatty:tray:updateMenuData")(null, {
        portForwardRules: [{
          id: "pf1",
          label: "ssh",
          type: "local",
          localPort: 8080,
          remoteHost: "host",
          remotePort: 80,
          status: "active",
        }],
      });

      const portForwardItem = bridge.getTray().contextMenu.template
        .filter((item) => typeof item.click === "function")
        .find((item) => String(item.label).includes("ssh"));
      portForwardItem.click();

      assert.equal(win.showCalls, 1);
      assert.equal(getPendingTimerCount(), 0);
      assert.equal(win.listenerCount("leave-full-screen"), 0);
      assert.equal(win.listenerCount("closed"), 0);
      assert.equal(flushNextTimer(), false);
      assert.equal(win.hideCalls, 0);
      assert.deepEqual(appLockController.setLockedCalls, []);
      assert.deepEqual(win.sentMessages.slice(0, 2), [
        ["netcatty:app-lock:reopen"],
        ["netcatty:tray:togglePortForward", "pf1", false],
      ]);
    });
  });
});

test("closing the window clears a pending fullscreen hide", async () => {
  await withPatchedTimers(async ({ flushNextTimer, getPendingTimerCount }) => {
    await withPlatform("darwin", async () => {
      const bridge = loadBridge();
      await enableCloseToTray(bridge);

      const win = new FakeWindow({ fullscreen: true });

      const result = bridge.handleWindowClose({ preventDefault() {} }, win);
      assert.equal(result, true);
      assert.equal(getPendingTimerCount(), 1);
      assert.equal(win.listenerCount("leave-full-screen"), 1);
      assert.equal(win.listenerCount("closed"), 1);

      win.destroyed = true;
      win.emit("closed");

      assert.equal(getPendingTimerCount(), 0);
      assert.equal(win.listenerCount("leave-full-screen"), 0);
      assert.equal(win.listenerCount("closed"), 0);
      assert.equal(flushNextTimer(), false);
      assert.equal(win.hideCalls, 0);
    });
  });
});

test("disabling close-to-tray clears a pending fullscreen hide", async () => {
  await withPatchedTimers(async ({ flushNextTimer, getPendingTimerCount }) => {
    await withPlatform("darwin", async () => {
      const bridge = loadBridge();
      const electronModule = createElectronStub();
      const win = new FakeWindow({ fullscreen: true });
      electronModule.BrowserWindow.getAllWindows = () => [win];
      const { ipcMain } = await enableCloseToTray(bridge, electronModule, {
        getMainWindow: () => win,
      });

      const result = bridge.handleWindowClose({ preventDefault() {} }, win);
      assert.equal(result, true);
      assert.equal(getPendingTimerCount(), 1);

      await ipcMain.handlers.get("netcatty:tray:setCloseToTray")(null, { enabled: false });

      assert.equal(getPendingTimerCount(), 0);
      assert.equal(win.listenerCount("leave-full-screen"), 0);
      assert.equal(win.listenerCount("closed"), 0);
      assert.equal(flushNextTimer(), false);
      assert.equal(win.hideCalls, 0);
    });
  });
});

test("handleWindowClose hides immediately when tray close is used outside fullscreen", async () => {
  await withPlatform("darwin", async () => {
    const bridge = loadBridge();
    await enableCloseToTray(bridge);

    const win = new FakeWindow({ fullscreen: false });
    let prevented = false;

    const result = bridge.handleWindowClose({ preventDefault() { prevented = true; } }, win);

    assert.equal(result, true);
    assert.equal(prevented, true);
    assert.deepEqual(win.setFullScreenCalls, []);
    assert.equal(win.hideCalls, 1);
  });
});

test("handleWindowClose locks app runtime before hiding to tray", async () => {
  await withPlatform("darwin", async () => {
    const bridge = loadBridge();
    const appLockController = createAppLockControllerStub();
    bridge.init({
      electronModule: createElectronStub(),
      getAppLockController: () => appLockController,
    });
    const ipcMain = createIpcMainStub();
    bridge.registerHandlers(ipcMain);
    await ipcMain.handlers.get("netcatty:tray:setCloseToTray")(null, { enabled: true });

    const win = new FakeWindow({ fullscreen: false });
    bridge.handleWindowClose({ preventDefault() {} }, win);

    assert.deepEqual(appLockController.setLockedCalls, ["background"]);
    assert.equal(win.hideCalls, 1);
  });
});

test("handleWindowClose stays in close-to-tray mode even if hide fails", async () => {
  await withPlatform("darwin", async () => {
    const bridge = loadBridge();
    const appLockController = createAppLockControllerStub();
    bridge.init({
      electronModule: createElectronStub(),
      getAppLockController: () => appLockController,
    });
    const ipcMain = createIpcMainStub();
    bridge.registerHandlers(ipcMain);
    await ipcMain.handlers.get("netcatty:tray:setCloseToTray")(null, { enabled: true });

    const win = new FakeWindow({ fullscreen: false });
    win.hide = function failingHide() {
      throw new Error("hide failed");
    };
    let prevented = false;

    const result = bridge.handleWindowClose({ preventDefault() { prevented = true; } }, win);

    assert.equal(result, true);
    assert.equal(prevented, true);
    assert.equal(win.visible, true);
    assert.deepEqual(appLockController.setLockedCalls, []);
  });
});

test("tray icon event registration is platform-dependent", async () => {
  // Test win32 platform
  await withPlatform("win32", async () => {
    const bridge = loadBridge();
    await enableCloseToTray(bridge);
    const trayInstance = bridge.getTray();
    assert.ok(trayInstance, "Tray instance should be created");
    assert.ok(trayInstance.handlers.has("click"), "win32 tray should have click handler");
    assert.ok(trayInstance.handlers.has("right-click"), "win32 tray should have right-click handler");
    assert.equal(trayInstance.contextMenu, null, "win32 tray should not set a context menu");
    bridge.cleanup();
  });

  // Test Linux platform
  await withPlatform("linux", async () => {
    const bridge = loadBridge();
    const { ipcMain } = await enableCloseToTray(bridge);
    const trayInstance = bridge.getTray();
    assert.ok(trayInstance, "Tray instance should be created");
    assert.ok(trayInstance.handlers.has("click"), "linux tray should have click handler");
    assert.ok(!trayInstance.handlers.has("right-click"), "linux tray should not use right-click handler");
    assert.ok(trayInstance.contextMenu, "linux tray should have a native context menu");
    const labels = trayInstance.contextMenu.template.map((item) => item.label);
    assert.ok(labels.includes("Open Main Window"), "linux context menu should include Open Main Window");
    assert.ok(labels.includes("Quit"), "linux context menu should include Quit");

    await ipcMain.handlers.get("netcatty:tray:updateMenuData")(null, {
      sessions: [{ id: "s1", label: "dev", hostLabel: "dev.example", status: "connected" }],
    });
    const updatedLabels = trayInstance.contextMenu.template
      .map((item) => item.label)
      .filter(Boolean);
    assert.ok(
      updatedLabels.some((label) => label.includes("dev.example")),
      "linux context menu should rebuild when tray menu data changes",
    );

    const win = new FakeWindow();
    win.minimized = true;
    const initializedElectronModule = {
        ...createElectronStub(),
        BrowserWindow: {
          getAllWindows() {
            return [win];
          },
        },
      };
    bridge.init({
      electronModule: initializedElectronModule,
      getMainWindow: () => win,
      getAppLockController: () => null,
    });
    await ipcMain.handlers.get("netcatty:tray:updateMenuData")(null, {
      sessions: [{ id: "s1", label: "dev", hostLabel: "dev.example", status: "connected" }],
      portForwardRules: [{ id: "pf1", label: "ssh", type: "local", localPort: 8080, remoteHost: "host", remotePort: 80, status: "active" }],
    });
    const clickableItems = bridge.getTray().contextMenu.template.filter((item) => typeof item.click === "function");
    const sessionItem = clickableItems.find((item) => String(item.label).includes("dev.example"));
    const portForwardItem = clickableItems.find((item) => String(item.label).includes("ssh"));

    sessionItem.click();
    await Promise.resolve();
    assert.deepEqual(win.sentMessages.slice(0, 2), [
      ["netcatty:app-lock:reopen"],
      ["netcatty:tray:focusSession", "s1"],
    ]);

    win.sentMessages = [];
    portForwardItem.click();
    assert.deepEqual(win.sentMessages.slice(0, 2), [
      ["netcatty:app-lock:reopen"],
      ["netcatty:tray:togglePortForward", "pf1", false],
    ]);
    bridge.cleanup();
  });

  // Locked runtime defers the toggle until unlock, while still reopening the window.
  await withPlatform("linux", async () => {
    const bridge = loadBridge();
    const appLockController = createAppLockControllerStub();
    const win = new FakeWindow();
    win.minimized = true;
    const initializedElectronModule = {
        ...createElectronStub(),
        BrowserWindow: {
          getAllWindows() {
            return [win];
          },
        },
      };
    bridge.init({
      electronModule: initializedElectronModule,
      getMainWindow: () => win,
      getAppLockController: () => appLockController,
    });
    const ipcMain = createIpcMainStub();
    bridge.registerHandlers(ipcMain);
    await ipcMain.handlers.get("netcatty:tray:setCloseToTray")(null, { enabled: true });
    await ipcMain.handlers.get("netcatty:tray:updateMenuData")(null, {
      portForwardRules: [{
        id: "pf1",
        label: "ssh",
        type: "local",
        localPort: 8080,
        remoteHost: "host",
        remotePort: 80,
        status: "active",
      }],
    });

    const portForwardItem = bridge.getTray().contextMenu.template
      .filter((item) => typeof item.click === "function")
      .find((item) => String(item.label).includes("ssh"));
    appLockController.setLocked("background");
    portForwardItem.click();

    assert.deepEqual(win.sentMessages, [
      ["netcatty:app-lock:reopen"],
    ], "toggle must not fire while runtime is locked");
    assert.equal(bridge.__getPendingPortForwardTogglesForTests().length, 1);

    appLockController.unlock();
    assert.deepEqual(win.sentMessages, [
      ["netcatty:app-lock:reopen"],
      ["netcatty:tray:togglePortForward", "pf1", false],
    ], "queued toggle flushes after unlock");
    assert.equal(bridge.__getPendingPortForwardTogglesForTests().length, 0);
    bridge.cleanup();
  });

  // Test other platform (darwin)
  await withPlatform("darwin", async () => {
    const bridge = loadBridge();
    await enableCloseToTray(bridge);
    const trayInstance = bridge.getTray();
    assert.ok(trayInstance, "Tray instance should be created");
    assert.ok(trayInstance.handlers.has("click"), "darwin tray should have click handler");
    assert.ok(!trayInstance.handlers.has("right-click"), "darwin tray should not have right-click handler");
    assert.equal(trayInstance.contextMenu, null, "darwin tray should not set a context menu");
    bridge.cleanup();
  });
});

test("native tray sends an explicit stop for a runtime-present error rule", async () => {
  await withPlatform("linux", async () => {
    const bridge = loadBridge();
    const electronModule = createElectronStub();
    const sentMessages = [];
    const win = new FakeWindow();
    win.webContents = {
      send(channel, ...args) {
        sentMessages.push([channel, ...args]);
      },
    };
    electronModule.BrowserWindow.getAllWindows = () => [win];
    const { ipcMain } = await enableCloseToTray(bridge, electronModule);

    await ipcMain.handlers.get("netcatty:tray:updateMenuData")(null, {
      portForwardRules: [{
        id: "cleanup-failed-rule",
        label: "Cleanup failed",
        type: "local",
        localPort: 8080,
        remoteHost: "127.0.0.1",
        remotePort: 80,
        status: "error",
        canStop: true,
      }],
    });

    const ruleItem = bridge.getTray().contextMenu.template.find(
      (item) => item.label?.includes("Cleanup failed"),
    );
    assert.ok(ruleItem);
    ruleItem.click();
    assert.deepEqual(sentMessages, [
      ["netcatty:app-lock:reopen"],
      ["netcatty:tray:togglePortForward", "cleanup-failed-rule", false],
    ]);
    bridge.cleanup();
  });
});

test("mac dock menu lists saved hosts and forwards connect actions", async () => {
  await withPlatform("darwin", async () => {
    const bridge = loadBridge();
    const electronModule = createElectronStub();
    const sentMessages = [];
    const win = new FakeWindow();
    win.webContents = {
      send(channel, ...args) {
        sentMessages.push([channel, ...args]);
      },
    };
    electronModule.BrowserWindow.getAllWindows = () => [win];

    bridge.init({
      electronModule,
      getMainWindow: () => win,
    });
    const ipcMain = createIpcMainStub();
    bridge.registerHandlers(ipcMain);

    await ipcMain.handlers.get("netcatty:tray:updateMenuData")(null, {
      hosts: [
        { id: "plain", label: "Plain Host", hostname: "plain.example" },
        { id: "pinned", label: "Pinned Host", hostname: "pinned.example", pinned: true },
        { id: "recent", label: "Recent Host", hostname: "recent.example", lastConnectedAt: 20 },
      ],
    });

    const dockTemplate = electronModule.app.dock.menu?.template ?? [];
    const connectionMenu = dockTemplate.find((item) => item.label === "New Connection");

    assert.ok(connectionMenu, "dock menu should expose a new connection submenu");
    assert.deepEqual(
      connectionMenu.submenu.map((item) => item.label),
      ["Pinned Host", "Recent Host", "Plain Host"],
    );

    await connectionMenu.submenu[0].click();

    assert.deepEqual(sentMessages, [
      ["netcatty:app-lock:reopen"],
      ["netcatty:trayPanel:connectToHost", "pinned"],
    ]);
  });
});

test("mac dock host connections wait until App Lock is unlocked", async () => {
  await withPlatform("darwin", async () => {
    const bridge = loadBridge();
    const electronModule = createElectronStub();
    const appLockController = createAppLockControllerStub();
    const sentMessages = [];
    const win = new FakeWindow();
    win.webContents = {
      send(channel, ...args) {
        sentMessages.push([channel, ...args]);
      },
    };
    electronModule.BrowserWindow.getAllWindows = () => [win];

    bridge.init({
      electronModule,
      getMainWindow: () => win,
      getAppLockController: () => appLockController,
    });
    const ipcMain = createIpcMainStub();
    bridge.registerHandlers(ipcMain);
    await ipcMain.handlers.get("netcatty:tray:updateMenuData")(null, {
      hosts: [{ id: "target", label: "Target Host", hostname: "target.example" }],
    });

    const unlockedTemplate = electronModule.app.dock.menu.template;
    const staleHostItem = unlockedTemplate
      .find((item) => item.label === "New Connection")
      .submenu[0];
    appLockController.setLocked("manual");

    const lockedTemplate = electronModule.app.dock.menu.template;
    const lockedConnectionMenu = lockedTemplate.find((item) => item.label === "New Connection");
    assert.equal(lockedConnectionMenu.enabled, false);
    assert.deepEqual(lockedConnectionMenu.submenu.map((item) => item.label), ["No Saved Hosts"]);

    await staleHostItem.click();
    assert.deepEqual(sentMessages, [["netcatty:app-lock:reopen"]]);

    appLockController.unlock();
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(sentMessages, [
      ["netcatty:app-lock:reopen"],
      ["netcatty:trayPanel:connectToHost", "target"],
    ]);
    bridge.cleanup();
  });
});

test("mac dock host click creates a main window when none exists", async () => {
  await withPlatform("darwin", async () => {
    const bridge = loadBridge();
    const electronModule = createElectronStub();
    const sentMessages = [];
    const createdWin = new FakeWindow();
    createdWin.webContents = {
      send(channel, ...args) {
        sentMessages.push([channel, ...args]);
      },
    };
    electronModule.BrowserWindow.getAllWindows = () => [];
    let createCalls = 0;

    bridge.init({
      electronModule,
      ensureMainWindow: async () => {
        createCalls += 1;
        return createdWin;
      },
    });
    const ipcMain = createIpcMainStub();
    bridge.registerHandlers(ipcMain);

    await ipcMain.handlers.get("netcatty:tray:updateMenuData")(null, {
      hosts: [
        { id: "target", label: "Target Host", hostname: "target.example" },
      ],
    });

    const dockTemplate = electronModule.app.dock.menu?.template ?? [];
    const connectionMenu = dockTemplate.find((item) => item.label === "New Connection");

    await connectionMenu.submenu[0].click();

    assert.equal(createCalls, 1);
    assert.deepEqual(sentMessages, [
      ["netcatty:app-lock:reopen"],
      ["netcatty:trayPanel:connectToHost", "target"],
    ]);
  });
});

test("mac dock host click waits for a newly created main window to be ready", async () => {
  await withPlatform("darwin", async () => {
    const bridge = loadBridge();
    const electronModule = createElectronStub();
    const sentMessages = [];
    const createdWin = new FakeWindow();
    createdWin.webContents = {
      send(channel, ...args) {
        sentMessages.push([channel, ...args]);
      },
    };
    electronModule.BrowserWindow.getAllWindows = () => [];
    let releaseReady;

    bridge.init({
      electronModule,
      ensureMainWindow: async () => createdWin,
      sendWhenRendererReady: async (win, channel, payload) => {
        assert.equal(win, createdWin);
        await new Promise((resolve) => {
          releaseReady = resolve;
        });
        win.webContents.send(channel, payload);
        return { success: true };
      },
    });
    const ipcMain = createIpcMainStub();
    bridge.registerHandlers(ipcMain);

    await ipcMain.handlers.get("netcatty:tray:updateMenuData")(null, {
      hosts: [
        { id: "target", label: "Target Host", hostname: "target.example" },
      ],
    });

    const dockTemplate = electronModule.app.dock.menu?.template ?? [];
    const connectionMenu = dockTemplate.find((item) => item.label === "New Connection");
    const clickPromise = connectionMenu.submenu[0].click();

    for (let i = 0; i < 5 && !releaseReady; i += 1) {
      await Promise.resolve();
    }
    assert.deepEqual(sentMessages, [["netcatty:app-lock:reopen"]]);

    releaseReady();
    await clickPromise;

    assert.deepEqual(sentMessages, [
      ["netcatty:app-lock:reopen"],
      ["netcatty:trayPanel:connectToHost", "target"],
    ]);
  });
});

test("mac dock host click waits for a tracked main window to be ready", async () => {
  await withPlatform("darwin", async () => {
    const bridge = loadBridge();
    const electronModule = createElectronStub();
    const sentMessages = [];
    const win = new FakeWindow();
    win.webContents = {
      send(channel, ...args) {
        sentMessages.push([channel, ...args]);
      },
    };
    electronModule.BrowserWindow.getAllWindows = () => [win];
    let releaseReady;
    let createCalls = 0;

    bridge.init({
      electronModule,
      getMainWindow: () => win,
      ensureMainWindow: async () => {
        createCalls += 1;
        return win;
      },
      sendWhenRendererReady: async (target, channel, payload) => {
        assert.equal(target, win);
        await new Promise((resolve) => {
          releaseReady = resolve;
        });
        target.webContents.send(channel, payload);
        return { success: true };
      },
    });
    const ipcMain = createIpcMainStub();
    bridge.registerHandlers(ipcMain);

    await ipcMain.handlers.get("netcatty:tray:updateMenuData")(null, {
      hosts: [
        { id: "target", label: "Target Host", hostname: "target.example" },
      ],
    });

    const dockTemplate = electronModule.app.dock.menu?.template ?? [];
    const connectionMenu = dockTemplate.find((item) => item.label === "New Connection");
    const clickPromise = connectionMenu.submenu[0].click();

    for (let i = 0; i < 5 && !releaseReady; i += 1) {
      await Promise.resolve();
    }
    assert.equal(createCalls, 0);
    assert.deepEqual(sentMessages, [["netcatty:app-lock:reopen"]]);

    releaseReady();
    await clickPromise;

    assert.deepEqual(sentMessages, [
      ["netcatty:app-lock:reopen"],
      ["netcatty:trayPanel:connectToHost", "target"],
    ]);
  });
});

test("mac dock open main window creates a main window when none exists", async () => {
  await withPlatform("darwin", async () => {
    const bridge = loadBridge();
    const electronModule = createElectronStub();
    const createdWin = new FakeWindow();
    electronModule.BrowserWindow.getAllWindows = () => [];
    let createCalls = 0;

    bridge.init({
      electronModule,
      ensureMainWindow: async () => {
        createCalls += 1;
        return createdWin;
      },
    });

    const dockTemplate = electronModule.app.dock.menu?.template ?? [];
    const openMainItem = dockTemplate.find((item) => item.label === "Open Main Window");

    await openMainItem.click();

    assert.equal(createCalls, 1);
    assert.equal(createdWin.showCalls, 1);
  });
});

test("tray panel open main window creates a main window when none exists", async () => {
  await withPlatform("darwin", async () => {
    const bridge = loadBridge();
    const electronModule = createElectronStub();
    const createdWin = new FakeWindow();
    electronModule.BrowserWindow.getAllWindows = () => [];
    let createCalls = 0;

    bridge.init({
      electronModule,
      ensureMainWindow: async () => {
        createCalls += 1;
        return createdWin;
      },
    });
    const ipcMain = createIpcMainStub();
    bridge.registerHandlers(ipcMain);

    await ipcMain.handlers.get("netcatty:trayPanel:openMainWindow")();

    assert.equal(createCalls, 1);
    assert.equal(createdWin.showCalls, 1);
  });
});

test("tray panel session jump waits for a newly created main window to be ready", async () => {
  await withPlatform("darwin", async () => {
    const bridge = loadBridge();
    const electronModule = createElectronStub();
    const sentMessages = [];
    const createdWin = new FakeWindow();
    createdWin.webContents = {
      send(channel, ...args) {
        sentMessages.push([channel, ...args]);
      },
    };
    electronModule.BrowserWindow.getAllWindows = () => [];
    let releaseReady;

    bridge.init({
      electronModule,
      ensureMainWindow: async () => createdWin,
      sendWhenRendererReady: async (win, channel, payload) => {
        assert.equal(win, createdWin);
        await new Promise((resolve) => {
          releaseReady = resolve;
        });
        win.webContents.send(channel, payload);
        return { success: true };
      },
    });
    const ipcMain = createIpcMainStub();
    bridge.registerHandlers(ipcMain);

    const jumpPromise = ipcMain.handlers.get("netcatty:trayPanel:jumpToSession")(null, "session-1");

    for (let i = 0; i < 5 && !releaseReady; i += 1) {
      await Promise.resolve();
    }
    assert.deepEqual(sentMessages, []);

    releaseReady();
    await jumpPromise;

    assert.deepEqual(sentMessages, [["netcatty:trayPanel:jumpToSession", "session-1"]]);
  });
});

test("tray panel session close forwards without focusing the main window", async () => {
  await withPlatform("darwin", async () => {
    const bridge = loadBridge();
    const electronModule = createElectronStub();
    const sentMessages = [];
    const mainWin = new FakeWindow();
    mainWin.visible = false;
    mainWin.focused = false;
    mainWin.webContents = {
      send(channel, ...args) {
        sentMessages.push([channel, ...args]);
      },
    };
    electronModule.BrowserWindow.getAllWindows = () => [mainWin];
    let createCalls = 0;

    bridge.init({
      electronModule,
      getMainWindow: () => mainWin,
      ensureMainWindow: async () => {
        createCalls += 1;
        return mainWin;
      },
      sendWhenRendererReady: async (win, channel, payload) => {
        assert.equal(win, mainWin);
        win.webContents.send(channel, payload);
        return { success: true };
      },
    });
    const ipcMain = createIpcMainStub();
    bridge.registerHandlers(ipcMain);

    const result = await ipcMain.handlers.get("netcatty:trayPanel:closeSession")(null, "session-1");

    assert.deepEqual(result, { success: true });
    assert.deepEqual(sentMessages, [["netcatty:trayPanel:closeSession", "session-1"]]);
    assert.equal(createCalls, 0);
    assert.equal(mainWin.showCalls, 0);
    assert.equal(mainWin.focusCalls, 0);
    assert.equal(mainWin.isVisible(), false);
  });
});

test("tray panel session close does not create a missing main window", async () => {
  await withPlatform("darwin", async () => {
    const bridge = loadBridge();
    const electronModule = createElectronStub();
    electronModule.BrowserWindow.getAllWindows = () => [];
    let createCalls = 0;

    bridge.init({
      electronModule,
      getMainWindow: () => null,
      ensureMainWindow: async () => {
        createCalls += 1;
        return new FakeWindow();
      },
    });
    const ipcMain = createIpcMainStub();
    bridge.registerHandlers(ipcMain);

    const result = await ipcMain.handlers.get("netcatty:trayPanel:closeSession")(null, "stale-session");

    assert.deepEqual(result, { success: false, error: "Main window is not available" });
    assert.equal(createCalls, 0);
  });
});

test("tray menu updates refresh an already open tray panel", async () => {
  await withPlatform("darwin", async () => {
    const bridge = loadBridge();
    const electronModule = createElectronStub();
    const sentMessages = [];

    class FakePanelWindow extends FakeWindow {
      constructor() {
        super();
        const webContents = new EventEmitter();
        webContents.send = (channel, ...args) => {
          sentMessages.push([channel, ...args]);
        };
        this.webContents = webContents;
      }

      async loadURL() {}
      getBounds() { return { width: 360, height: 520 }; }
      setBounds() {}
      destroy() { this.destroyed = true; }
    }

    FakePanelWindow.getAllWindows = () => [];
    electronModule.BrowserWindow = FakePanelWindow;
    electronModule.screen = {
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
    };

    const { ipcMain } = await enableCloseToTray(bridge, electronModule);
    const trayInstance = bridge.getTray();
    trayInstance.getBounds = () => ({ x: 100, y: 0, width: 24, height: 24 });
    trayInstance.handlers.get("click")();

    sentMessages.length = 0;
    const sessions = [{ id: "remaining", label: "Remaining", status: "connected" }];
    await ipcMain.handlers.get("netcatty:tray:updateMenuData")(null, { sessions });

    assert.deepEqual(sentMessages, [["netcatty:trayPanel:setMenuData", {
      sessions,
      portForwardRules: [],
      hosts: [],
    }]]);
    bridge.cleanup();
  });
});

test("toggleWindowVisibility show path delegates to showAndFocusMainWindow on win32", async () => {
  await withPlatform("win32", async () => {
    const windowManagerPath = require.resolve("./windowManager.cjs");
    const actualWindowManager = require(windowManagerPath);
    const showCalls = [];
    let appFocusCalls = 0;

    require.cache[windowManagerPath].exports = {
      ...actualWindowManager,
      showAndFocusMainWindow(win) {
        showCalls.push(win);
        return true;
      },
    };

    try {
      const bridge = loadBridge();
      const electronModule = createElectronStub();
      electronModule.app.focus = () => {
        appFocusCalls += 1;
      };
      const win = new FakeWindow();
      win.visible = false;
      win.focused = false;
      electronModule.BrowserWindow.getAllWindows = () => [win];
      let toggleWindow = null;
      electronModule.globalShortcut.register = (_accelerator, handler) => {
        toggleWindow = handler;
        return true;
      };
      const { ipcMain } = await enableCloseToTray(bridge, electronModule);
      await ipcMain.handlers.get("netcatty:globalHotkey:register")(null, { hotkey: "Ctrl + `" });

      assert.ok(toggleWindow, "expected global hotkey handler to register");
      toggleWindow();

      assert.equal(showCalls.length, 1);
      assert.equal(showCalls[0], win);
      assert.equal(appFocusCalls, 1);
      assert.equal(win.showCalls, 0, "should not call bare win.show()");
      assert.equal(win.focusCalls, 0, "should not call bare win.focus()");
    } finally {
      require.cache[windowManagerPath].exports = actualWindowManager;
    }
  });
});

test("openMainWindow delegates to showAndFocusMainWindow on win32", async () => {
  await withPlatform("win32", async () => {
    const windowManagerPath = require.resolve("./windowManager.cjs");
    const actualWindowManager = require(windowManagerPath);
    const showCalls = [];

    require.cache[windowManagerPath].exports = {
      ...actualWindowManager,
      showAndFocusMainWindow(win) {
        showCalls.push(win);
        return true;
      },
    };

    try {
      const bridge = loadBridge();
      const electronModule = createElectronStub();
      electronModule.app.focus = () => {};
      const win = new FakeWindow();
      win.visible = false;
      electronModule.BrowserWindow.getAllWindows = () => [win];
      const { ipcMain } = await enableCloseToTray(bridge, electronModule, {
        getMainWindow: () => win,
      });

      await ipcMain.handlers.get("netcatty:trayPanel:openMainWindow")();

      assert.equal(showCalls.length, 1);
      assert.equal(showCalls[0], win);
      assert.equal(win.showCalls, 0);
      assert.equal(win.focusCalls, 0);
    } finally {
      require.cache[windowManagerPath].exports = actualWindowManager;
    }
  });
});

test("toggleWindowVisibility focuses visible-but-unfocused windows via showAndFocusMainWindow", async () => {
  await withPlatform("win32", async () => {
    const windowManagerPath = require.resolve("./windowManager.cjs");
    const actualWindowManager = require(windowManagerPath);
    const showCalls = [];

    require.cache[windowManagerPath].exports = {
      ...actualWindowManager,
      showAndFocusMainWindow(win) {
        showCalls.push(win);
        return true;
      },
    };

    try {
      const bridge = loadBridge();
      const electronModule = createElectronStub();
      electronModule.app.focus = () => {};
      const win = new FakeWindow();
      win.visible = true;
      win.focused = false;
      electronModule.BrowserWindow.getAllWindows = () => [win];
      let toggleWindow = null;
      electronModule.globalShortcut.register = (_accelerator, handler) => {
        toggleWindow = handler;
        return true;
      };
      const { ipcMain } = await enableCloseToTray(bridge, electronModule);
      await ipcMain.handlers.get("netcatty:globalHotkey:register")(null, { hotkey: "Ctrl + `" });

      toggleWindow();

      assert.equal(showCalls.length, 1);
      assert.equal(win.hideCalls, 0);
    } finally {
      require.cache[windowManagerPath].exports = actualWindowManager;
    }
  });
});

function installFakeTrayPanelWindow(electronModule, { getBoundsSize } = {}) {
  class FakePanelWindow extends EventEmitter {
    constructor(opts = {}) {
      super();
      FakePanelWindow.instances.push(this);
      this.opts = opts;
      this.bounds = {
        x: 0,
        y: 0,
        width: opts.width,
        height: opts.height,
      };
      this.setBoundsCalls = [];
      this.destroyed = false;
      this.visible = false;
      const webContents = new EventEmitter();
      webContents.send = () => {};
      this.webContents = webContents;
    }

    async loadURL() {}
    getBounds() {
      if (getBoundsSize) return { ...this.bounds, ...getBoundsSize };
      return { ...this.bounds };
    }
    setBounds(next) {
      this.setBoundsCalls.push({ ...next });
      this.bounds = { ...this.bounds, ...next };
    }
    isDestroyed() {
      return this.destroyed;
    }
    show() {
      this.visible = true;
    }
    hide() {
      this.visible = false;
    }
    focus() {}
    destroy() {
      this.destroyed = true;
    }
  }

  FakePanelWindow.instances = [];
  FakePanelWindow.getAllWindows = () => [];
  electronModule.BrowserWindow = FakePanelWindow;
  return FakePanelWindow;
}

test("Windows right-click places the designed panel above the taskbar from event bounds", async () => {
  await withPlatform("win32", async () => {
    const { placeTrayPanel } = require("./trayPanelBounds.cjs");
    const bridge = loadBridge();
    const electronModule = createElectronStub();
    const FakePanelWindow = installFakeTrayPanelWindow(electronModule, {
      getBoundsSize: { width: 720, height: 1040 },
    });
    const workArea = { x: 0, y: 0, width: 1920, height: 1040 };
    const eventBounds = { x: 1680, y: 1044, width: 24, height: 24 };
    electronModule.screen = {
      getCursorScreenPoint: () => ({ x: 1690, y: 1050 }),
      getDisplayNearestPoint: () => ({ workArea }),
    };

    try {
      await enableCloseToTray(bridge, electronModule);
      const trayInstance = bridge.getTray();
      trayInstance.getBounds = () => ({ x: 0, y: 0, width: 0, height: 0 });
      trayInstance.handlers.get("right-click")({}, eventBounds);

      assert.equal(FakePanelWindow.instances.length, 1);
      assert.equal(FakePanelWindow.instances[0].opts.width, 360);
      assert.equal(FakePanelWindow.instances[0].opts.height, 520);
      assert.deepEqual(
        FakePanelWindow.instances[0].setBoundsCalls[0],
        placeTrayPanel({ anchor: eventBounds, workArea, width: 360, height: 520 }),
      );
    } finally {
      bridge.cleanup();
    }
  });
});

test("Windows right-click ignores a y=0 tray.getBounds lie and uses the cursor", async () => {
  await withPlatform("win32", async () => {
    const { placeTrayPanel } = require("./trayPanelBounds.cjs");
    const bridge = loadBridge();
    const electronModule = createElectronStub();
    const FakePanelWindow = installFakeTrayPanelWindow(electronModule);
    const workArea = { x: 0, y: 0, width: 1920, height: 1040 };
    const cursor = { x: 1700, y: 1040 };
    electronModule.screen = {
      getCursorScreenPoint: () => cursor,
      getDisplayNearestPoint: () => ({ workArea }),
    };

    try {
      await enableCloseToTray(bridge, electronModule);
      const trayInstance = bridge.getTray();
      trayInstance.getBounds = () => ({ x: 1680, y: 0, width: 24, height: 24 });
      trayInstance.handlers.get("right-click")({});

      assert.deepEqual(
        FakePanelWindow.instances[0].setBoundsCalls[0],
        placeTrayPanel({
          anchor: { x: cursor.x, y: cursor.y, width: 1, height: 1 },
          workArea,
          width: 360,
          height: 520,
        }),
      );
    } finally {
      bridge.cleanup();
    }
  });
});

test("Windows tray activation keeps event bounds when the cursor is on another monitor", async () => {
  await withPlatform("win32", async () => {
    const { placeTrayPanel } = require("./trayPanelBounds.cjs");
    const bridge = loadBridge();
    const electronModule = createElectronStub();
    const FakePanelWindow = installFakeTrayPanelWindow(electronModule);
    const workArea = { x: 0, y: 0, width: 1920, height: 1040 };
    const eventBounds = { x: 1680, y: 1044, width: 24, height: 24 };
    const nearestCalls = [];
    electronModule.screen = {
      getCursorScreenPoint: () => ({ x: 2600, y: 400 }),
      getDisplayNearestPoint: (point) => {
        nearestCalls.push(point);
        return { workArea };
      },
    };

    try {
      await enableCloseToTray(bridge, electronModule);
      const trayInstance = bridge.getTray();
      trayInstance.getBounds = () => ({ x: 0, y: 0, width: 0, height: 0 });
      trayInstance.handlers.get("right-click")({}, eventBounds);

      assert.deepEqual(nearestCalls[0], { x: eventBounds.x, y: eventBounds.y });
      assert.deepEqual(
        FakePanelWindow.instances[0].setBoundsCalls[0],
        placeTrayPanel({ anchor: eventBounds, workArea, width: 360, height: 520 }),
      );
    } finally {
      bridge.cleanup();
    }
  });
});

test("macOS tray click still opens the panel below a top menu-bar icon", async () => {
  await withPlatform("darwin", async () => {
    const { placeTrayPanel } = require("./trayPanelBounds.cjs");
    const bridge = loadBridge();
    const electronModule = createElectronStub();
    const FakePanelWindow = installFakeTrayPanelWindow(electronModule);
    const workArea = { x: 0, y: 25, width: 1440, height: 875 };
    const eventBounds = { x: 900, y: 0, width: 24, height: 24 };
    electronModule.screen = {
      getCursorScreenPoint: () => ({ x: 910, y: 8 }),
      getDisplayNearestPoint: () => ({ workArea }),
    };

    try {
      await enableCloseToTray(bridge, electronModule);
      const trayInstance = bridge.getTray();
      trayInstance.getBounds = () => eventBounds;
      trayInstance.handlers.get("click")({}, eventBounds);

      assert.deepEqual(
        FakePanelWindow.instances[0].setBoundsCalls[0],
        placeTrayPanel({ anchor: eventBounds, workArea, width: 360, height: 520 }),
      );
    } finally {
      bridge.cleanup();
    }
  });
});
