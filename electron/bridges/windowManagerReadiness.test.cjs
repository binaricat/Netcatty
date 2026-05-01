const test = require("node:test");
const assert = require("node:assert/strict");

const { isWindowUsable, registerWindowHandlers, restoreWindowInputFocus } = require("./windowManager.cjs");

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

test("window focus IPC handler focuses the sender owner window", async () => {
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
  const win = {
    isDestroyed() {
      return false;
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
});
