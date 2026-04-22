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
    }

    setToolTip() {}
    setContextMenu() {}
    destroy() {}

    on(eventName, handler) {
      this.handlers.set(eventName, handler);
    }
  }

  return {
    Tray: FakeTray,
    Menu: {},
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
      getAppPath() {
        return process.cwd();
      },
      quit() {},
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

async function enableCloseToTray(bridge, electronModule = createElectronStub()) {
  bridge.init({ electronModule });
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
      const { ipcMain } = await enableCloseToTray(bridge, electronModule);

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
      const { ipcMain } = await enableCloseToTray(bridge, electronModule);

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
      const { ipcMain } = await enableCloseToTray(bridge, electronModule);

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

test("handleWindowClose stays in close-to-tray mode even if hide fails", async () => {
  await withPlatform("darwin", async () => {
    const bridge = loadBridge();
    await enableCloseToTray(bridge);

    const win = new FakeWindow({ fullscreen: false });
    win.hide = function failingHide() {
      throw new Error("hide failed");
    };
    let prevented = false;

    const result = bridge.handleWindowClose({ preventDefault() { prevented = true; } }, win);

    assert.equal(result, true);
    assert.equal(prevented, true);
    assert.equal(win.visible, true);
  });
});
