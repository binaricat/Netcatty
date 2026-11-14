const assert = require("node:assert/strict");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const { finalizeSessionLogs } = require("./sessionLogShutdown.cjs");
const { createPreloadApi } = require("../preload/api.cjs");
const { handleBeforeQuit } = require("../main/appLockLifecycle.cjs");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");
const tick = () => new Promise((resolve) => setImmediate(resolve));

function renderer(ipcMain = new EventEmitter()) {
  const ipcRenderer = new EventEmitter();
  const webContents = { send: (channel, payload) => ipcRenderer.emit(channel, {}, payload) };
  ipcRenderer.send = (channel, payload) => ipcMain.emit(channel, { sender: webContents }, payload);
  const api = createPreloadApi({ ipcRenderer });
  return { api, ipcMain, ipcRenderer, webContents };
}

test("finalization waits for every terminal replay commit, including a hidden renderer", async () => {
  const h = renderer();
  const commits = [];
  const off = h.api.onFinalizeSessionLogs(() => { throw new Error("unmounted terminal"); });
  off();
  for (let i = 0; i < 2; i++) {
    h.api.onFinalizeSessionLogs(() => new Promise((resolve) => commits.push(resolve)));
  }
  let done = false;
  const pending = finalizeSessionLogs(h.webContents, h).then((result) => { done = true; return result; });
  await tick();
  assert.equal(done, false);
  commits[0](); await tick();
  assert.equal(done, false);
  commits[1]();
  assert.equal(await pending, true);
  assert.equal(h.ipcMain.listenerCount("app:session-logs-finalized"), 0);
});

test("empty renderers acknowledge immediately; failed captures acknowledge failure", async () => {
  const h = renderer();
  assert.equal(await finalizeSessionLogs(h.webContents, h), true);
  h.api.onFinalizeSessionLogs(() => { throw new Error("capture failed"); });
  assert.equal(await finalizeSessionLogs(h.webContents, h), false);
});

test("overlapping window close and app quit share the pending replay commit", async () => {
  const h = renderer();
  let finish;
  let captures = 0;
  h.api.onFinalizeSessionLogs(() => {
    captures++;
    return new Promise((resolve) => { finish = resolve; });
  });
  const first = finalizeSessionLogs(h.webContents, h);
  let secondDone = false;
  const second = finalizeSessionLogs(h.webContents, h).then((result) => { secondDone = true; return result; });
  await tick();
  assert.equal(captures, 1);
  assert.equal(secondDone, false);
  finish();
  assert.equal(await first, true);
  assert.equal(await second, true);
});

test("only the queried renderer and current request can acknowledge finalization", async () => {
  const ipcMain = new EventEmitter();
  let request;
  const webContents = { send: (_channel, payload) => { request = payload; } };
  let done = false;
  const pending = finalizeSessionLogs(webContents, { ipcMain }).then((result) => { done = true; return result; });
  ipcMain.emit("app:session-logs-finalized", { sender: {} }, { ...request, success: true });
  ipcMain.emit("app:session-logs-finalized", { sender: webContents }, { requestId: "old", success: true });
  await tick();
  assert.equal(done, false);
  ipcMain.emit("app:session-logs-finalized", { sender: webContents }, { ...request, success: true });
  assert.equal(await pending, true);
});

test("unresponsive and destroyed renderers do not strand quit or leak listeners", async () => {
  const ipcMain = new EventEmitter();
  assert.equal(await finalizeSessionLogs({ send() {} }, { ipcMain, timeoutMs: 1 }), false);
  assert.equal(await finalizeSessionLogs({ send() { throw new Error("destroyed"); } }, { ipcMain }), false);
  assert.equal(await finalizeSessionLogs({ isDestroyed: () => true }, { ipcMain }), false);
  assert.equal(ipcMain.listenerCount("app:session-logs-finalized"), 0);
});

test("unavailable finalize IPC returns immediately without scheduling timers or sending", async (t) => {
  const timer = t.mock.method(globalThis, "setTimeout");
  const ipcMain = new EventEmitter();
  const send = t.mock.fn();
  const on = t.mock.method(ipcMain, "on");
  for (const unavailableIpc of [undefined, null, {}, { on() {} }, { removeListener() {} }, { on: true, removeListener() {} }, { on() {}, removeListener: true }]) {
    assert.equal(await finalizeSessionLogs({ send }, { ipcMain: unavailableIpc }), false);
  }
  for (const webContents of [undefined, null, {}, { send: true }]) {
    assert.equal(await finalizeSessionLogs(webContents, { ipcMain }), false);
  }
  assert.equal(timer.mock.callCount(), 0);
  assert.equal(on.mock.callCount(), 0);
  assert.equal(send.mock.callCount(), 0);
});

for (const failure of ["registration", "send", "cleanup"]) {
  test(`finalize IPC ${failure} errors do not reject or leave a pending timeout`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const warn = t.mock.method(console, "warn", () => {});
    const ipcMain = new EventEmitter();
    const webContents = { send() { throw new Error("send failed"); } };
    if (failure === "registration") {
      ipcMain.on = (channel, listener) => {
        EventEmitter.prototype.on.call(ipcMain, channel, listener);
        throw new Error("registration failed");
      };
    } else if (failure === "cleanup") {
      ipcMain.removeListener = (channel, listener) => {
        EventEmitter.prototype.removeListener.call(ipcMain, channel, listener);
        throw new Error("cleanup failed");
      };
    }
    let result;
    const pending = finalizeSessionLogs(webContents, { ipcMain }).then((success) => { result = success; });
    await tick();
    assert.equal(result, false, "failed setup must finish before the timeout");
    await pending;
    assert.equal(ipcMain.listenerCount("app:session-logs-finalized"), 0);
    assert.equal(warn.mock.callCount(), 1);
    t.mock.timers.tick(5000);
    assert.equal(warn.mock.callCount(), 1, "the cleared timeout must not run after finalization");
  });
}

test("tray quit finalizes only after the dirty guard accepts and waits before quitting", async () => {
  const h = renderer();
  let finishCapture;
  let captures = 0;
  let quits = 0;
  h.api.onFinalizeSessionLogs(() => {
    captures++;
    return new Promise((resolve) => { finishCapture = resolve; });
  });
  let shutdown;
  const options = {
    event: { preventDefault() {} }, mainWindows: [{ webContents: h.webContents }],
    queryDirtyEditors: async () => true,
    commitQuit: () => { shutdown = finalizeSessionLogs(h.webContents, h).then(() => { quits++; }); },
    dialog: { showMessageBoxSync() {} },
  };
  await handleBeforeQuit(options);
  assert.equal(captures, 0);
  await handleBeforeQuit({ ...options, queryDirtyEditors: async () => false });
  await tick();
  assert.equal(captures, 1);
  assert.equal(quits, 0);
  finishCapture(); await shutdown;
  assert.equal(quits, 1);
});

test("production quit commit awaits renderer logs and file streams before plugins and process exit", async () => {
  const source = readFileSync(require.resolve("../main.cjs"), "utf8");
  const start = source.indexOf("  const commitQuit = () => {");
  const end = source.indexOf('\n  app.on("before-quit"', start);
  assert.ok(start >= 0 && end > start);
  const calls = [];
  let finishCapture;
  let finishStreams;
  const hiddenWindow = { webContents: {} };
  const context = {
    console,
    getWindowManager: () => ({ setIsQuitting: () => calls.push("quitting"), getAppContentWindows: () => [hiddenWindow] }),
    electronModule: { ipcMain: {} },
    finalizeSessionLogs: (wc) => {
      assert.equal(wc, hiddenWindow.webContents);
      calls.push("capture");
      return new Promise((resolve) => { finishCapture = resolve; });
    },
    sessionLogStreamManager: { cleanupAll: () => {
      calls.push("streams");
      return new Promise((resolve) => { finishStreams = resolve; });
    } },
    appLockController: { setLocked: () => calls.push("lock") },
    runPluginShutdown: async () => { calls.push("plugins"); return { timedOut: false }; },
    app: { quit: () => calls.push("quit") },
    quitGuardChannelBusy: false, quitConfirmed: false,
  };
  vm.runInNewContext(`${source.slice(start, end)}; commitQuit();`, context);
  assert.deepEqual(calls, ["lock", "quitting", "capture"]);
  assert.equal(context.quitGuardChannelBusy, true);
  finishCapture(); await tick();
  assert.deepEqual(calls, ["lock", "quitting", "capture", "streams"]);
  assert.equal(context.quitConfirmed, false);
  finishStreams(); await tick();
  assert.deepEqual(calls, ["lock", "quitting", "capture", "streams", "plugins", "quit"]);
  assert.equal(context.quitConfirmed, true);
});
