const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const {
  createAppLockController,
  createAppLockRuntimeBridge,
} = require("./appLockRuntimeBridge.cjs");
const {
  createAppLockPasswordVerifier,
  createAppLockSettingsStore,
} = require("./appLockSettingsStore.cjs");

function withPatchedTimers(run) {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  let nextTimerId = 1;
  const timers = new Map();

  global.setTimeout = (fn, delay = 0, ...args) => {
    const id = nextTimerId++;
    timers.set(id, {
      dueAt: Date.now() + Math.max(0, Number(delay) || 0),
      fn: () => fn(...args),
    });
    return id;
  };

  global.clearTimeout = (id) => {
    timers.delete(id);
  };

  const flushNextTimer = () => {
    const nextEntry = timers.entries().next().value;
    if (!nextEntry) return false;
    const [id, timer] = nextEntry;
    timers.delete(id);
    timer.fn();
    return true;
  };
  const flushDueTimers = () => {
    let flushed = 0;
    for (const [id, timer] of [...timers.entries()]) {
      if (timer.dueAt > Date.now()) continue;
      timers.delete(id);
      timer.fn();
      flushed += 1;
    }
    return flushed;
  };

  const getPendingTimerCount = () => timers.size;

  return Promise.resolve()
    .then(() => run({ flushNextTimer, flushDueTimers, getPendingTimerCount }))
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
      }),
    )
    .finally(() => {
      Date.now = originalDateNow;
    });
}

test("runtime bridge can initialize locked at startup", () => {
  const bridge = createAppLockRuntimeBridge();
  bridge.initialize({
    locked: true,
    reason: "startup",
    lastActivityAt: 1000,
  });
  const state = bridge.getState();
  assert.equal(state.initialized, true);
  assert.equal(state.locked, true);
  assert.equal(state.reason, "startup");
  assert.equal(state.lastActivityAt, 1000);
});

test("runtime bridge records shared activity timestamps", () => {
  const bridge = createAppLockRuntimeBridge();
  bridge.initialize({ locked: false, reason: null, lastActivityAt: 1000 });
  bridge.recordActivity(2500);
  assert.equal(bridge.getState().lastActivityAt, 2500);
});

test("runtime bridge reschedules the shared idle timer after activity", async () => {
  await withPatchedTimers(async ({ flushNextTimer, getPendingTimerCount }) => {
    await withPatchedDateNow(1000, async ({ setNow }) => {
      const bridge = createAppLockRuntimeBridge();
      const idleLocks = [];

      bridge.initialize({ locked: false, reason: null, lastActivityAt: 1000 });
      bridge.scheduleIdleTimer({
        timeoutMinutes: 1,
        canLock: () => true,
        onIdleLock: (state) => idleLocks.push(state),
      });

      assert.equal(getPendingTimerCount(), 1);

      setNow(30000);
      bridge.recordActivity(30000);
      assert.equal(getPendingTimerCount(), 1);

      setNow(61000);
      assert.equal(flushNextTimer(), true);
      assert.equal(bridge.getState().locked, false);
      assert.equal(idleLocks.length, 0);
      assert.equal(getPendingTimerCount(), 1);

      setNow(90000);
      assert.equal(flushNextTimer(), true);
      assert.equal(bridge.getState().locked, true);
      assert.equal(bridge.getState().reason, "idle");
      assert.equal(idleLocks.length, 1);
      assert.equal(getPendingTimerCount(), 0);
    });
  });
});

test("runtime bridge does not schedule idle timer when timeout is disabled", async () => {
  await withPatchedTimers(async ({ getPendingTimerCount }) => {
    const bridge = createAppLockRuntimeBridge();

    bridge.initialize({ locked: false, reason: null, lastActivityAt: 1000 });
    bridge.scheduleIdleTimer({
      timeoutMinutes: 0,
      canLock: () => true,
      onIdleLock: () => {
        throw new Error("idle lock should not run");
      },
    });

    assert.equal(getPendingTimerCount(), 0);
    assert.equal(bridge.getState().locked, false);
  });
});

test("runtime bridge notifies subscribers on lock state changes", () => {
  const bridge = createAppLockRuntimeBridge();
  const snapshots = [];
  const unsubscribe = bridge.subscribe((state) => {
    snapshots.push(state);
  });

  bridge.initialize({ locked: false, reason: null, lastActivityAt: 1000 });
  bridge.lock("manual");
  bridge.unlock();
  unsubscribe();
  bridge.lock("manual");

  assert.deepEqual(
    snapshots.map((state) => [state.locked, state.reason]),
    [
      [false, null],
      [true, "manual"],
      [false, null],
    ],
  );
});

test("runtime bridge clearIdleTimer cancels pending idle locks", async () => {
  await withPatchedTimers(async ({ flushNextTimer, getPendingTimerCount }) => {
    const bridge = createAppLockRuntimeBridge();
    let locked = false;

    bridge.initialize({ locked: false, reason: null, lastActivityAt: 1000 });
    bridge.scheduleIdleTimer({
      timeoutMinutes: 1,
      canLock: () => true,
      onIdleLock: () => {
        locked = true;
      },
    });

    assert.equal(getPendingTimerCount(), 1);
    bridge.clearIdleTimer();
    assert.equal(getPendingTimerCount(), 0);
    assert.equal(flushNextTimer(), false);
    assert.equal(locked, false);
  });
});

test("runtime bridge unreferences the shared idle timer handle when supported", () => {
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  let unrefCalled = false;

  global.setTimeout = (fn) => {
    void fn;
    return {
      unref() {
        unrefCalled = true;
      },
    };
  };
  global.clearTimeout = () => {};

  try {
    const bridge = createAppLockRuntimeBridge();
    bridge.initialize({ locked: false, reason: null, lastActivityAt: 1000 });
    bridge.scheduleIdleTimer({
      timeoutMinutes: 1,
      canLock: () => true,
      onIdleLock: () => {},
    });

    assert.equal(unrefCalled, true);
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});

function createWindowCollector(name) {
  const sent = [];
  let devToolsOpened = false;
  let devToolsCloseCount = 0;
  let title = `${name}@host`;
  const win = new EventEmitter();
  const webContents = new EventEmitter();
  Object.assign(webContents, {
    id: `${name}-${Math.random()}`,
    isDestroyed() {
      return false;
    },
    send(channel, payload) {
      sent.push([channel, payload]);
    },
    isDevToolsOpened() {
      return devToolsOpened;
    },
    closeDevTools() {
      devToolsOpened = false;
      devToolsCloseCount += 1;
    },
  });
  Object.assign(win, {
    name,
    sent,
    openDevToolsForTest() {
      devToolsOpened = true;
      webContents.emit("devtools-opened");
    },
    getDevToolsCloseCount() {
      return devToolsCloseCount;
    },
    getTitle() {
      return title;
    },
    setTitle(nextTitle) {
      title = nextTitle;
    },
    isDestroyed() {
      return false;
    },
    webContents,
  });
  return win;
}

function createIpcMainHarness() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
  };
}

async function createControllerHarness(options = {}) {
  const settingsStore = createAppLockSettingsStore({
    filePath: "/tmp/app-lock-settings.json",
    readFile: async () => {
      const err = new Error("ENOENT");
      err.code = "ENOENT";
      throw err;
    },
    writeFile: async () => {},
  });
  await settingsStore.load();

  const runtimeBridge = createAppLockRuntimeBridge();
  runtimeBridge.initialize({
    locked: true,
    reason: "startup",
    lastActivityAt: 1000,
  });

  const mainWindowA = createWindowCollector("main-a");
  const mainWindowB = createWindowCollector("main-b");
  // Detached session window: app-content only (registerAsMainWindow:false).
  const sessionWindow = createWindowCollector("session");
  const settingsWindow = createWindowCollector("settings");
  const trayPanelWindow = createWindowCollector("tray");
  const popupWindowA = createWindowCollector("popup-a");
  const popupWindowB = createWindowCollector("popup-b");
  const systemAuthCalls = {
    status: 0,
    unlock: 0,
  };
  const systemAuthBridge = {
    async getStatus() {
      systemAuthCalls.status += 1;
      return {
        supported: true,
        available: true,
        platform: "darwin",
        label: "Touch ID",
        reason: null,
      };
    },
    async requestUnlock() {
      systemAuthCalls.unlock += 1;
      return { ok: true };
    },
  };
  const unlockFailureDelays = [];

  const controller = createAppLockController({
    settingsStore,
    runtimeBridge,
    systemAuthBridge,
    getMainWindows: () => [mainWindowA, mainWindowB],
    // Main windows are also app-content; include a session-only window that is
    // not in getMainWindows (mirrors openSession registerAsMainWindow:false).
    getAppContentWindows: () => [mainWindowA, mainWindowB, sessionWindow],
    getSettingsWindow: () => settingsWindow,
    getTrayPanelWindow: () => trayPanelWindow,
    getTerminalPopupWindows: () => [popupWindowA, popupWindowB],
    waitForUnlockFailureDelay: options.waitForUnlockFailureDelay ?? (async (delayMs) => {
      unlockFailureDelays.push(delayMs);
    }),
  });

  return {
    controller,
    runtimeBridge,
    settingsStore,
    systemAuthBridge,
    systemAuthCalls,
    unlockFailureDelays,
    windows: [
      mainWindowA,
      mainWindowB,
      sessionWindow,
      settingsWindow,
      trayPanelWindow,
      popupWindowA,
      popupWindowB,
    ],
  };
}

test("system unlock setting confirms with system auth instead of current password when enabling", async () => {
  const { controller, systemAuthCalls } = await createControllerHarness();
  await controller.requestPasswordChange({ nextPassword: "alpha" });
  await controller.requestEnable();

  const saved = await controller.setSystemUnlockEnabled({ enabled: true });
  assert.equal(saved.systemUnlockEnabled, true);
  assert.equal(systemAuthCalls.unlock, 1);
});

test("system unlock auto prompt setting does not request system auth when already enabled", async () => {
  const { controller, systemAuthCalls } = await createControllerHarness();
  await controller.requestPasswordChange({ nextPassword: "alpha" });
  await controller.requestEnable();

  await controller.setSystemUnlockEnabled({ enabled: true });
  assert.equal(systemAuthCalls.unlock, 1);

  const enabledAutoPrompt = await controller.setSystemUnlockEnabled({
    enabled: true,
    autoPromptEnabled: true,
  });
  assert.equal(enabledAutoPrompt.systemUnlockEnabled, true);
  assert.equal(enabledAutoPrompt.systemUnlockAutoPromptEnabled, true);
  assert.equal(systemAuthCalls.unlock, 1);

  const disabledAutoPrompt = await controller.setSystemUnlockEnabled({
    enabled: true,
    autoPromptEnabled: false,
  });
  assert.equal(disabledAutoPrompt.systemUnlockEnabled, true);
  assert.equal(disabledAutoPrompt.systemUnlockAutoPromptEnabled, false);
  assert.equal(systemAuthCalls.unlock, 1);
});

test("system unlock setting cannot be disabled without password while locked", async () => {
  const { controller } = await createControllerHarness();
  await controller.requestPasswordChange({ nextPassword: "alpha" });
  await controller.requestEnable();
  await controller.setSystemUnlockEnabled({ enabled: true });
  controller.setLocked("manual");

  assert.deepEqual(
    await controller.setSystemUnlockEnabled({ enabled: false }),
    { ok: false, error: "locked" },
  );

  const saved = await controller.setSystemUnlockEnabled({ enabled: false, currentPassword: "alpha" });
  assert.equal(saved.systemUnlockEnabled, false);
});

test("system unlock result is rejected when the setting is disabled during verification", async () => {
  const { controller, systemAuthBridge } = await createControllerHarness();
  await controller.requestPasswordChange({ nextPassword: "alpha" });
  await controller.requestEnable();
  await controller.setSystemUnlockEnabled({ enabled: true });
  controller.setLocked("manual");

  let resolveSystemUnlock;
  systemAuthBridge.requestUnlock = async () => new Promise((resolve) => {
    resolveSystemUnlock = resolve;
  });
  const pendingUnlock = controller.requestSystemUnlock();
  for (let attempt = 0; attempt < 5 && !resolveSystemUnlock; attempt += 1) {
    await Promise.resolve();
  }
  assert.equal(typeof resolveSystemUnlock, "function");

  const disabled = await controller.setSystemUnlockEnabled({
    enabled: false,
    currentPassword: "alpha",
  });
  assert.equal(disabled.systemUnlockEnabled, false);
  resolveSystemUnlock({ ok: true });

  assert.deepEqual(await pendingUnlock, { ok: false, error: "disabled" });
  assert.equal(controller.getRuntimeState().locked, true);
});

test("system unlock succeeds only when enabled and locked", async () => {
  const { controller, runtimeBridge, systemAuthCalls } = await createControllerHarness();
  await controller.requestPasswordChange({ nextPassword: "alpha" });
  await controller.requestEnable();

  assert.deepEqual(await controller.requestSystemUnlock(), { ok: false, error: "disabled" });
  await controller.setSystemUnlockEnabled({ enabled: true });
  assert.deepEqual(await controller.requestSystemUnlock(), { ok: true });
  assert.equal(runtimeBridge.getState().locked, false);
  assert.equal(systemAuthCalls.unlock, 2);
  assert.deepEqual(await controller.requestSystemUnlock(), { ok: false, error: "not-locked" });
});

test("system unlock cancellation preserves locked runtime state", async () => {
  const { controller, runtimeBridge, systemAuthBridge } = await createControllerHarness();
  await controller.requestPasswordChange({ nextPassword: "alpha" });
  await controller.requestEnable();
  await controller.setSystemUnlockEnabled({ enabled: true, currentPassword: "alpha" });
  controller.setLocked("manual");
  systemAuthBridge.requestUnlock = async () => ({ ok: false, error: "cancelled" });

  assert.deepEqual(await controller.requestSystemUnlock(), { ok: false, error: "cancelled" });
  assert.equal(runtimeBridge.getState().locked, true);
});

test("system unlock IPC handlers are registered", async () => {
  const { controller } = await createControllerHarness();
  const ipcMain = createIpcMainHarness();
  controller.registerHandlers(ipcMain);

  assert.equal(ipcMain.handlers.has("netcatty:appLock:getSystemUnlockStatus"), true);
  assert.equal(ipcMain.handlers.has("netcatty:appLock:setSystemUnlockEnabled"), true);
  assert.equal(ipcMain.handlers.has("netcatty:appLock:requestSystemUnlock"), true);
  assert.equal(
    (await ipcMain.handlers.get("netcatty:appLock:getSystemUnlockStatus")()).label,
    "Touch ID",
  );
});

test("unlock request verifies against the latest persisted password verifier", async () => {
  const { controller } = await createControllerHarness();
  await controller.requestPasswordChange({ nextPassword: "alpha" });
  await controller.requestEnable();
  assert.deepEqual(await controller.requestUnlock("alpha"), {
    ok: true,
  });
  controller.setLocked("manual");

  await controller.requestPasswordChange({
    currentPassword: "alpha",
    nextPassword: "bravo",
  });
  controller.setLocked("manual");

  assert.deepEqual(await controller.requestUnlock("alpha"), {
    ok: false,
    error: "incorrect",
  });
  assert.deepEqual(await controller.requestUnlock("bravo"), {
    ok: true,
  });
});

test("incorrect password attempts back off and a successful unlock resets the delay", async () => {
  const { controller, unlockFailureDelays } = await createControllerHarness();
  await controller.requestPasswordChange({ nextPassword: "alpha" });
  controller.setLocked("manual");

  assert.deepEqual(await controller.requestUnlock("wrong-1"), { ok: false, error: "incorrect" });
  assert.deepEqual(await controller.requestUnlock("wrong-2"), { ok: false, error: "incorrect" });
  assert.deepEqual(unlockFailureDelays, [250, 500]);

  assert.deepEqual(await controller.requestUnlock("alpha"), { ok: true });
  controller.setLocked("manual");
  assert.deepEqual(await controller.requestUnlock("wrong-3"), { ok: false, error: "incorrect" });
  assert.deepEqual(unlockFailureDelays, [250, 500, 250]);
});

test("parallel password attempts share one bounded in-flight verification", async () => {
  const delays = [];
  let releaseFirstDelay;
  const { controller } = await createControllerHarness({
    waitForUnlockFailureDelay: async (delayMs) => {
      delays.push(delayMs);
      if (delays.length === 1) {
        await new Promise((resolve) => {
          releaseFirstDelay = resolve;
        });
      }
    },
  });
  await controller.requestPasswordChange({ nextPassword: "alpha" });
  controller.setLocked("manual");

  const first = controller.requestUnlock("wrong-1");
  const second = controller.requestUnlock("wrong-2");
  const deadline = Date.now() + 1000;
  while (!releaseFirstDelay && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(releaseFirstDelay, "first attempt should reach backoff");
  assert.deepEqual(delays, [250], "second attempt must not start another backoff");

  releaseFirstDelay();
  assert.deepEqual(await Promise.all([first, second]), [
    { ok: false, error: "incorrect" },
    { ok: false, error: "incorrect" },
  ]);
  assert.deepEqual(delays, [250]);
});

test("background lock is skipped when automatic timeout is never", async () => {
  const { controller, runtimeBridge } = await createControllerHarness();
  await controller.requestPasswordChange({ nextPassword: "alpha" });
  await controller.requestUnlock("alpha");
  await controller.setTimeoutMinutes(0);

  const background = controller.setLocked("background");
  assert.equal(background.locked, false);
  assert.equal(runtimeBridge.getState().locked, false);
  assert.equal(runtimeBridge.getState().reason, null);

  const manual = controller.setLocked("manual");
  assert.equal(manual.locked, true);
  assert.equal(runtimeBridge.getState().reason, "manual");

  await controller.requestUnlock("alpha");
  const startup = controller.setLocked("startup");
  assert.equal(startup.locked, true);
  assert.equal(runtimeBridge.getState().reason, "startup");
});

test("background lock still applies when an inactivity timeout is set", async () => {
  const { controller, runtimeBridge } = await createControllerHarness();
  await controller.requestPasswordChange({ nextPassword: "alpha" });
  await controller.requestUnlock("alpha");
  await controller.setTimeoutMinutes(5);

  const background = controller.setLocked("background");
  assert.equal(background.locked, true);
  assert.equal(runtimeBridge.getState().reason, "background");
});

test("password unlock result is discarded after a newer lock transition", async () => {
  const { controller, runtimeBridge } = await createControllerHarness();
  await controller.requestPasswordChange({ nextPassword: "alpha" });
  controller.setLocked("manual");

  const pending = controller.requestUnlock("alpha");
  await Promise.resolve();
  controller.setLocked("background");

  assert.deepEqual(await pending, { ok: false, error: "incorrect" });
  assert.equal(runtimeBridge.getState().locked, true);
  assert.equal(runtimeBridge.getState().reason, "background");
});

test("an unlock request started while unlocked cannot unlock a later background lock", async () => {
  const { controller, runtimeBridge } = await createControllerHarness();
  await controller.requestPasswordChange({ nextPassword: "alpha" });
  await controller.requestUnlock("alpha");
  assert.equal(runtimeBridge.getState().locked, false);

  const pending = controller.requestUnlock("alpha");
  controller.setLocked("background");

  assert.deepEqual(await pending, { ok: false, error: "incorrect" });
  assert.equal(runtimeBridge.getState().locked, true);
  assert.equal(runtimeBridge.getState().reason, "background");
});

test("unlocked requests cannot queue ahead of a later legitimate unlock", async () => {
  const { controller, runtimeBridge, unlockFailureDelays } = await createControllerHarness();
  await controller.requestPasswordChange({ nextPassword: "alpha" });
  await controller.requestUnlock("alpha");

  const staleCalls = Array.from({ length: 20 }, () => controller.requestUnlock("garbage"));
  controller.setLocked("background");
  assert.deepEqual(await controller.requestUnlock("alpha"), { ok: true });
  assert.equal(runtimeBridge.getState().locked, false);
  assert.deepEqual(await Promise.all(staleCalls), Array.from(
    { length: 20 },
    () => ({ ok: false, error: "incorrect" }),
  ));
  assert.deepEqual(unlockFailureDelays, []);
});

test("password unlock result is discarded after the verifier changes", async () => {
  const { controller, runtimeBridge, settingsStore } = await createControllerHarness();
  await controller.requestPasswordChange({ nextPassword: "alpha" });
  controller.setLocked("manual");
  const replacementVerifier = await createAppLockPasswordVerifier("bravo");

  const pending = controller.requestUnlock("alpha");
  await Promise.resolve();
  await settingsStore.save({
    ...settingsStore.getSnapshot(),
    passwordVerifier: replacementVerifier,
  });

  assert.deepEqual(await pending, { ok: false, error: "incorrect" });
  assert.equal(runtimeBridge.getState().locked, true);
});

test("stale renderer cannot overwrite the latest verifier with a whole-object settings write", async () => {
  const { controller, settingsStore } = await createControllerHarness();
  await controller.requestPasswordChange({ nextPassword: "alpha" });
  await controller.requestEnable();

  const staleSnapshot = settingsStore.getSnapshot();
  assert.equal(staleSnapshot.enabled, true);
  assert.equal(typeof staleSnapshot.passwordVerifier?.hash, "string");

  await controller.requestPasswordChange({
    currentPassword: "alpha",
    nextPassword: "bravo",
  });

  const freshSnapshot = settingsStore.getSnapshot();
  assert.equal(freshSnapshot.enabled, true);
  assert.notEqual(freshSnapshot.passwordVerifier?.hash, staleSnapshot.passwordVerifier?.hash);

  assert.deepEqual(
    await controller.requestDisable("alpha"),
    { ok: false, error: "incorrect" },
  );

  assert.deepEqual(
    await controller.requestDisable("bravo"),
    {
      enabled: false,
      timeoutMinutes: freshSnapshot.timeoutMinutes,
      systemUnlockEnabled: false,
      systemUnlockAutoPromptEnabled: false,
      passwordVerifier: null,
    },
  );
});

test("runtime state broadcast fans out to all main windows, session app-content windows, settings, tray panel, and every popup window", async () => {
  const { controller, windows } = await createControllerHarness();
  await controller.requestPasswordChange({ nextPassword: "alpha" });
  await controller.requestEnable();

  const state = controller.setLocked("manual");
  for (const win of windows) {
    const runtimeMessages = win.sent.filter(([channel]) => channel === "netcatty:appLock:runtimeStateChanged");
    assert.equal(runtimeMessages.length, 1, `${win.name} should receive one runtime broadcast`);
    assert.deepEqual(runtimeMessages[0][1], state);
  }
  const sessionWindow = windows.find((win) => win.name === "session");
  assert.ok(sessionWindow, "harness must include a detached session window");
  assert.equal(
    sessionWindow.sent.filter(([channel]) => channel === "netcatty:appLock:runtimeStateChanged").length,
    1,
    "detached session windows must receive app-lock runtime broadcasts",
  );
});

test("unlocking an enabled app schedules the shared idle timer in controller flow", async () => {
  await withPatchedTimers(async ({ getPendingTimerCount }) => {
    const { controller, runtimeBridge } = await createControllerHarness();

    await controller.requestPasswordChange({ nextPassword: "alpha" });
    assert.equal(getPendingTimerCount(), 0);

    await controller.requestEnable();
    assert.equal(getPendingTimerCount(), 0);

    await controller.requestUnlock("alpha");
    assert.equal(getPendingTimerCount(), 1);
    controller.syncIdleTimer();
    await controller.requestDisable("alpha");
    runtimeBridge.clearIdleTimer();
  });
});

test("unlock and activity keep the shared idle timer armed", async () => {
  await withPatchedTimers(async ({ getPendingTimerCount }) => {
    await withPatchedDateNow(1000, async ({ setNow }) => {
      const { controller, runtimeBridge } = await createControllerHarness();

      await controller.requestPasswordChange({ nextPassword: "alpha" });
      await controller.requestEnable();
      controller.setLocked("manual");
      assert.equal(getPendingTimerCount(), 0);

      await controller.requestUnlock("alpha");
      assert.equal(getPendingTimerCount(), 1);

      setNow(5000);
      controller.reportActivity(5000);
      assert.equal(getPendingTimerCount(), 1);
      await controller.requestDisable("alpha");
      runtimeBridge.clearIdleTimer();
    });
  });
});

test("activity reported from any window postpones the shared idle lock", async () => {
  await withPatchedTimers(async ({ flushDueTimers, getPendingTimerCount }) => {
    await withPatchedDateNow(1000, async ({ setNow }) => {
      const { controller, runtimeBridge } = await createControllerHarness();

      await controller.requestPasswordChange({ nextPassword: "alpha" });
      await controller.setTimeoutMinutes(1);
      await controller.requestEnable();
      controller.setLocked("manual");
      await controller.requestUnlock("alpha");
      assert.equal(getPendingTimerCount(), 1);

      setNow(30000);
      controller.reportActivity(30000);
      assert.equal(runtimeBridge.getState().lastActivityAt, 30000);
      assert.equal(getPendingTimerCount(), 1);

      setNow(61000);
      assert.equal(flushDueTimers(), 0);
      assert.equal(runtimeBridge.getState().locked, false);
      assert.equal(getPendingTimerCount(), 1);

      setNow(90000);
      assert.equal(flushDueTimers(), 1);
      assert.equal(runtimeBridge.getState().locked, true);
      assert.equal(runtimeBridge.getState().reason, "idle");
      assert.equal(getPendingTimerCount(), 0);

      runtimeBridge.clearIdleTimer();
    });
  });
});

test("idle lock closes DevTools in every app window", async () => {
  await withPatchedTimers(async ({ flushDueTimers }) => {
    await withPatchedDateNow(1000, async ({ setNow }) => {
      const { controller, runtimeBridge, windows } = await createControllerHarness();

      await controller.requestPasswordChange({ nextPassword: "alpha" });
      await controller.setTimeoutMinutes(1);
      await controller.requestUnlock("alpha");
      windows.forEach((win) => win.openDevToolsForTest());

      setNow(61000);
      assert.equal(flushDueTimers(), 1);
      assert.equal(runtimeBridge.getState().locked, true);
      assert.equal(runtimeBridge.getState().reason, "idle");
      windows.forEach((win) => {
        assert.equal(win.getDevToolsCloseCount(), 1, `${win.name} DevTools should close on idle lock`);
      });
    });
  });
});

function emitSystemContextMenu(win) {
  let preventDefaultCount = 0;
  win.emit("system-context-menu", {
    preventDefault() {
      preventDefaultCount += 1;
    },
  });
  return preventDefaultCount;
}

test("lock suppresses the native system context menu on every app window", async () => {
  const { controller, windows } = await createControllerHarness();
  await controller.requestPasswordChange({ nextPassword: "alpha" });

  for (const win of windows) {
    assert.equal(
      emitSystemContextMenu(win),
      1,
      `${win.name} should hide the native window menu while locked`,
    );
  }

  await controller.requestUnlock("alpha");
  for (const win of windows) {
    assert.equal(
      emitSystemContextMenu(win),
      0,
      `${win.name} should keep the native window menu after unlock`,
    );
  }

  controller.setLocked("manual");
  for (const win of windows) {
    assert.equal(
      emitSystemContextMenu(win),
      1,
      `${win.name} should hide the native window menu after re-lock`,
    );
  }
});

test("newly opened windows suppress the native system context menu while locked", async () => {
  const { controller } = await createControllerHarness();
  const newWindow = createWindowCollector("new-session");
  controller.protectWindow(newWindow);

  assert.equal(emitSystemContextMenu(newWindow), 1);
});

test("startup lock immediately protects existing and newly opened windows", async () => {
  const existingWindow = createWindowCollector("existing");
  existingWindow.openDevToolsForTest();
  const settingsStore = createAppLockSettingsStore({
    filePath: "/tmp/app-lock-startup-window.json",
    readFile: async () => {
      const err = new Error("ENOENT");
      err.code = "ENOENT";
      throw err;
    },
    writeFile: async () => {},
  });
  await settingsStore.load();
  const runtimeBridge = createAppLockRuntimeBridge();
  runtimeBridge.initialize({ locked: true, reason: "startup", lastActivityAt: 1000 });
  const controller = createAppLockController({
    settingsStore,
    runtimeBridge,
    getMainWindows: () => [existingWindow],
  });

  assert.equal(existingWindow.getTitle(), "Netcatty");
  assert.equal(existingWindow.getDevToolsCloseCount(), 1);

  const newWindow = createWindowCollector("new-session");
  controller.protectWindow(newWindow);
  assert.equal(newWindow.getTitle(), "Netcatty");
  newWindow.openDevToolsForTest();
  assert.equal(newWindow.getDevToolsCloseCount(), 1);

  controller.setWindowTitle(newWindow, "new@host");
  assert.equal(newWindow.getTitle(), "Netcatty");
  runtimeBridge.unlock();
  assert.equal(newWindow.getTitle(), "new@host");
});

test("lock redacts window titles and unlock restores them", async () => {
  const { controller, windows } = await createControllerHarness();
  await controller.requestPasswordChange({ nextPassword: "alpha" });
  await controller.requestUnlock("alpha");
  const originalTitles = windows.map((win) => win.getTitle());

  controller.setLocked("manual");
  assert.deepEqual(windows.map((win) => win.getTitle()), windows.map(() => "Netcatty"));

  await controller.requestUnlock("alpha");
  assert.deepEqual(windows.map((win) => win.getTitle()), originalTitles);
});

test("disabling app lock clears the shared idle timer", async () => {
  await withPatchedTimers(async ({ getPendingTimerCount }) => {
    const { controller, runtimeBridge } = await createControllerHarness();

    await controller.requestPasswordChange({ nextPassword: "alpha" });
    await controller.requestEnable();
    await controller.requestUnlock("alpha");
    assert.equal(getPendingTimerCount(), 1);

    await controller.requestDisable("alpha");
    assert.equal(getPendingTimerCount(), 0);
    runtimeBridge.clearIdleTimer();
  });
});

test("disabling app lock removes the saved password verifier", async () => {
  const { controller } = await createControllerHarness();

  const saved = await controller.requestDisable("alpha");

  assert.equal(saved.enabled, false);
  assert.equal(saved.passwordVerifier, null);
});

test("resetting app lock requires the current password before clearing the verifier", async () => {
  const { controller, runtimeBridge } = await createControllerHarness();
  await controller.requestPasswordChange({ nextPassword: "alpha" });
  await controller.requestEnable();
  controller.setLocked("manual");

  assert.deepEqual(
    await controller.requestReset(),
    { ok: false, error: "empty-current" },
  );
  assert.deepEqual(
    await controller.requestReset("wrong"),
    { ok: false, error: "incorrect" },
  );
  assert.equal(controller.getSettings().passwordVerifier !== null, true);
  assert.equal(runtimeBridge.getState().locked, true);
});

test("resetting app lock clears the verifier, unlocks runtime, and broadcasts settings and runtime", async () => {
  const { controller, runtimeBridge, windows } = await createControllerHarness();
  await controller.requestPasswordChange({ nextPassword: "alpha" });
  await controller.requestEnable();
  controller.setLocked("manual");
  for (const win of windows) {
    win.sent.length = 0;
  }

  const saved = await controller.requestReset("alpha");

  assert.equal(saved.enabled, false);
  assert.equal(saved.passwordVerifier, null);
  assert.equal(runtimeBridge.getState().locked, false);
  assert.equal(runtimeBridge.getState().reason, null);
  for (const win of windows) {
    const settingsMessages = win.sent.filter(([channel]) => channel === "netcatty:appLock:settingsChanged");
    const runtimeMessages = win.sent.filter(([channel]) => channel === "netcatty:appLock:runtimeStateChanged");
    assert.equal(settingsMessages.length, 1, `${win.name} should receive one settings broadcast`);
    assert.equal(runtimeMessages.length, 1, `${win.name} should receive one runtime broadcast`);
    assert.equal(settingsMessages[0][1].passwordVerifier, null);
    assert.equal(runtimeMessages[0][1].locked, false);
  }
});

test("creating the first app lock password enables app lock", async () => {
  const { controller } = await createControllerHarness({
    enabled: false,
    passwordVerifier: null,
  });

  const saved = await controller.requestPasswordChange({
    nextPassword: "first secret",
  });

  assert.equal(saved.enabled, true);
  assert.equal(typeof saved.passwordVerifier?.hash, "string");
});

test("a queued password change cannot revive a concurrently disabled lock", async () => {
  const { controller } = await createControllerHarness();
  await controller.requestPasswordChange({ nextPassword: "alpha" });

  const disable = controller.requestDisable("alpha");
  const passwordChange = controller.requestPasswordChange({
    currentPassword: "alpha",
    nextPassword: "beta",
  });
  await Promise.all([passwordChange, disable]);

  const settings = controller.getSettings();
  assert.equal(settings.enabled, false);
  assert.equal(settings.passwordVerifier, null);
});
