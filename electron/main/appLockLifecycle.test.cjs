const test = require("node:test");
const assert = require("node:assert/strict");

const {
  emitAppLockReopen,
  ensureAppLockForFreshSession,
  handleAppHide,
  handleActivateWithMainWindow,
  handleBeforeQuit,
  hasNoUsableAppContentWindows,
  shouldBackgroundLockOnHide,
  shouldCommitQuitWithoutDirtyCheck,
} = require("./appLockLifecycle.cjs");

test("shouldBackgroundLockOnHide locks only when app lock controller exists", () => {
  assert.equal(shouldBackgroundLockOnHide({ setLocked: () => {} }), true);
  assert.equal(shouldBackgroundLockOnHide(null), false);
});

test("ensureAppLockForFreshSession locks with startup by default", () => {
  const calls = [];
  assert.equal(
    ensureAppLockForFreshSession({
      setLocked(reason) {
        calls.push(reason);
      },
    }),
    true,
  );
  assert.deepEqual(calls, ["startup"]);
});

test("ensureAppLockForFreshSession accepts an explicit reason and ignores missing controllers", () => {
  const calls = [];
  assert.equal(
    ensureAppLockForFreshSession({
      setLocked(reason) {
        calls.push(reason);
      },
    }, "background"),
    true,
  );
  assert.deepEqual(calls, ["background"]);
  assert.equal(ensureAppLockForFreshSession(null), false);
  assert.equal(ensureAppLockForFreshSession({}), false);
});

test("hasNoUsableAppContentWindows treats empty or destroyed lists as no windows", () => {
  assert.equal(hasNoUsableAppContentWindows(undefined), true);
  assert.equal(hasNoUsableAppContentWindows([]), true);
  assert.equal(hasNoUsableAppContentWindows([null, { isDestroyed: () => true }]), true);
  assert.equal(hasNoUsableAppContentWindows([{ isDestroyed: () => false }]), false);
  assert.equal(hasNoUsableAppContentWindows([{ /* no isDestroyed */ }]), false);
  // Hidden prewarm windows do not count as a live session.
  assert.equal(
    hasNoUsableAppContentWindows([{
      isDestroyed: () => false,
      isVisible: () => false,
    }]),
    true,
  );
  assert.equal(
    hasNoUsableAppContentWindows([{
      isDestroyed: () => false,
      isVisible: () => true,
    }]),
    false,
  );
});

test("shouldCommitQuitWithoutDirtyCheck commits when no reachable main windows exist", () => {
  assert.equal(
    shouldCommitQuitWithoutDirtyCheck({
      reachableMainWindows: [],
      queryableWebContents: [{ id: 1 }],
    }),
    true,
  );
});

test("shouldCommitQuitWithoutDirtyCheck commits when no queryable webContents exist", () => {
  assert.equal(
    shouldCommitQuitWithoutDirtyCheck({
      reachableMainWindows: [{ id: 1 }],
      queryableWebContents: [],
    }),
    true,
  );
});

test("shouldCommitQuitWithoutDirtyCheck waits for dirty check when reachable renderers exist", () => {
  assert.equal(
    shouldCommitQuitWithoutDirtyCheck({
      reachableMainWindows: [{ id: 1 }],
      queryableWebContents: [{ id: 1 }],
    }),
    false,
  );
});

test("emitAppLockReopen sends reopen once per live unique webContents", () => {
  const sent = [];
  const sharedWebContents = {
    id: 7,
    send(channel) {
      sent.push(channel);
    },
  };
  const windows = [
    null,
    { isDestroyed: () => true, webContents: sharedWebContents },
    { isDestroyed: () => false, webContents: sharedWebContents },
    { isDestroyed: () => false, webContents: sharedWebContents },
    {
      isDestroyed: () => false,
      webContents: {
        id: 8,
        send(channel) {
          sent.push(channel);
        },
      },
    },
  ];

  emitAppLockReopen(windows);

  assert.deepEqual(sent, [
    "netcatty:app-lock:reopen",
    "netcatty:app-lock:reopen",
  ]);
});

test("handleAppHide locks the app in background when controller exists", () => {
  const calls = [];

  handleAppHide({
    setLocked(reason) {
      calls.push(reason);
    },
  });

  assert.deepEqual(calls, ["background"]);
});

test("handleAppHide ignores missing controllers", () => {
  assert.doesNotThrow(() => {
    handleAppHide(null);
  });
});

test("handleActivateWithMainWindow shows and focuses the main window, then emits reopen", () => {
  const calls = [];
  const mainWindow = {
    isDestroyed: () => false,
    isMinimized: () => true,
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
      id: 99,
      send(channel) {
        calls.push(`send:${channel}`);
      },
    },
  };
  const app = {
    focus() {
      calls.push("app.focus");
    },
  };
  const globalShortcutBridge = {
    clearPendingFullscreenHide(win) {
      calls.push(`clear:${win === mainWindow}`);
    },
  };

  const handled = handleActivateWithMainWindow({
    app,
    mainWindow,
    globalShortcutBridge,
    reopenWindows: [mainWindow],
  });

  assert.equal(handled, true);
  assert.deepEqual(calls, [
    "clear:true",
    "restore",
    "show",
    "focus",
    "send:netcatty:app-lock:reopen",
    "app.focus",
  ]);
});

test("handleActivateWithMainWindow refuses crashed main windows so activate can recreate them", () => {
  const calls = [];
  const mainWindow = {
    isDestroyed: () => false,
    destroy() {
      calls.push("destroy");
    },
    webContents: {
      isCrashed: () => true,
      id: 99,
      send(channel) {
        calls.push(`send:${channel}`);
      },
    },
  };

  const handled = handleActivateWithMainWindow({
    app: {
      focus() {
        calls.push("app.focus");
      },
    },
    mainWindow,
    globalShortcutBridge: {
      clearPendingFullscreenHide() {
        calls.push("clear");
      },
    },
    reopenWindows: [mainWindow],
  });

  assert.equal(handled, false);
  assert.deepEqual(calls, ["destroy"]);
});

test("handleBeforeQuit commits quit after clean dirty-editor check and locks background", async () => {
  const calls = [];
  const mainWindow = {
    isDestroyed: () => false,
    isVisible: () => true,
    isMinimized: () => false,
    webContents: {
      isDestroyed: () => false,
      isCrashed: () => false,
      id: 1,
    },
  };
  const event = {
    preventDefault() {
      calls.push("preventDefault");
    },
  };

  await handleBeforeQuit({
    event,
    mainWindows: [mainWindow],
    queryDirtyEditors: async () => false,
    appLockController: {
      setLocked(reason) {
        calls.push(`lock:${reason}`);
      },
    },
    windowManager: {
      setIsQuitting(value) {
        calls.push(`setIsQuitting:${value}`);
      },
      isQuittingForUpdate() {
        return false;
      },
    },
    app: {
      quit() {
        calls.push("app.quit");
      },
    },
    ipcMain: {},
    quitConfirmed: false,
    quitGuardChannelBusy: false,
    timeoutMs: 10,
    setQuitGuardChannelBusy(value) {
      calls.push(`quitGuardBusy:${value}`);
    },
    setQuitConfirmed(value) {
      calls.push(`quitConfirmed:${value}`);
    },
  });

  assert.deepEqual(calls, [
    "quitGuardBusy:true",
    "preventDefault",
    "quitGuardBusy:false",
    "lock:background",
    "setIsQuitting:true",
    "quitConfirmed:true",
    "app.quit",
  ]);
});

test("handleBeforeQuit cancels quit without locking when dirty editors exist", async () => {
  const calls = [];
  const mainWindow = {
    isDestroyed: () => false,
    isVisible: () => true,
    isMinimized: () => false,
    webContents: {
      isDestroyed: () => false,
      isCrashed: () => false,
      id: 1,
    },
  };
  const event = {
    preventDefault() {
      calls.push("preventDefault");
    },
  };

  await handleBeforeQuit({
    event,
    mainWindows: [mainWindow],
    queryDirtyEditors: async () => true,
    appLockController: {
      setLocked(reason) {
        calls.push(`lock:${reason}`);
      },
    },
    windowManager: {
      setIsQuitting(value) {
        calls.push(`setIsQuitting:${value}`);
      },
      isQuittingForUpdate() {
        return true;
      },
      setQuittingForUpdate(value) {
        calls.push(`setQuittingForUpdate:${value}`);
      },
      showAndFocusMainWindow(win) {
        calls.push(`showAndFocus:${win === mainWindow}`);
      },
    },
    app: {
      quit() {
        calls.push("app.quit");
      },
    },
    ipcMain: {},
    quitConfirmed: false,
    quitGuardChannelBusy: false,
    timeoutMs: 10,
    setQuitGuardChannelBusy(value) {
      calls.push(`quitGuardBusy:${value}`);
    },
    setQuitConfirmed(value) {
      calls.push(`quitConfirmed:${value}`);
    },
  });

  assert.deepEqual(calls, [
    "quitGuardBusy:true",
    "preventDefault",
    "quitGuardBusy:false",
    "showAndFocus:true",
    "setQuittingForUpdate:false",
  ]);
});

test("handleBeforeQuit focuses only dirty windows when multiple renderers reply", async () => {
  const calls = [];
  const cleanWindow = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      isCrashed: () => false,
      id: 1,
    },
  };
  const dirtyWindow = {
    isDestroyed: () => false,
    isMinimized: () => true,
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
      isDestroyed: () => false,
      isCrashed: () => false,
      id: 2,
    },
  };
  const event = {
    preventDefault() {
      calls.push("preventDefault");
    },
  };

  const result = await handleBeforeQuit({
    event,
    mainWindows: [cleanWindow, dirtyWindow],
    queryDirtyEditors: async (wc) => wc.id === 2,
    appLockController: {
      setLocked(reason) {
        calls.push(`lock:${reason}`);
      },
    },
    windowManager: {
      // No showAndFocusMainWindow — exercise the restore/show/focus fallback
      // used when the window manager helper is unavailable.
      setIsQuitting(value) {
        calls.push(`setIsQuitting:${value}`);
      },
      isQuittingForUpdate() {
        return false;
      },
    },
    app: {
      quit() {
        calls.push("app.quit");
      },
    },
    ipcMain: {},
    quitConfirmed: false,
    quitGuardChannelBusy: false,
    timeoutMs: 10,
    setQuitGuardChannelBusy(value) {
      calls.push(`quitGuardBusy:${value}`);
    },
    setQuitConfirmed(value) {
      calls.push(`quitConfirmed:${value}`);
    },
  });

  assert.equal(result.committed, false);
  assert.equal(result.skipped, "dirty");
  assert.deepEqual(calls, [
    "quitGuardBusy:true",
    "preventDefault",
    "quitGuardBusy:false",
    "restore",
    "show",
    "focus",
  ]);
});
