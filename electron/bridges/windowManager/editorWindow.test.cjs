const assert = require("node:assert/strict");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const { createEditorWindowApi } = require("./editorWindow.cjs");

const snapshot = (id) => ({ editorId: id, sessionId: "ssh", sftpTabId: "sftp", hostId: "host", remotePath: `/${id}`, fileName: id, content: `edited ${id}`, baselineContent: "original" });
const tick = () => new Promise((resolve) => setImmediate(resolve));
function harness() {
  const ipcMain = new EventEmitter();
  const windows = [];
  class BrowserWindow extends EventEmitter {
    constructor() {
      super();
      this.destroyed = false;
      this.sent = [];
      this.webContents = new EventEmitter();
      this.webContents.isDestroyed = () => this.destroyed;
      this.webContents.send = (channel, payload) => this.sent.push({ channel, payload });
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    loadURL() { return new Promise((resolve, reject) => { this.loaded = resolve; this.failed = reject; }); }
    setBackgroundColor() {}
    destroy() { this.destroyed = true; this.webContents.emit("destroyed"); this.emit("closed"); }
  }
  const source = { id: 99, isDestroyed: () => false, sent: [], send(channel, payload) { this.sent.push({ channel, payload }); } };
  const electron = { BrowserWindow, ipcMain, webContents: { fromId: () => source } };
  const api = createEditorWindowApi({ currentTheme: "dark", mainWindow: null, isQuitting: false,
    V8_CACHE_OPTIONS: "code", resolveFrontendBackgroundColor: () => "#000", resolveSettingsWindowBounds: () => ({}),
    registerAppContentWindow() {}, unregisterAppContentWindow() {}, notifyAppContentWindowClosed() {},
    createExternalOnlyWindowOpenHandler() {}, applyWindowOpacityToWindow() {}, showAndFocusWindow(win) { win.shown = true; },
  });
  const open = (id) => api.openEditorWindow(electron, { sourceWebContents: source }, snapshot(id));
  const ready = (win) => ipcMain.emit("netcatty:window:editorReady", { sender: win.webContents });
  const accept = (win, request, ok = true) => ipcMain.emit("netcatty:window:editorOpenTabResult", { sender: win.webContents }, { requestId: request.payload.requestId, ok });
  return { windows, source, ipcMain, open, ready, accept };
}

test("concurrent cold opens wait for load and the mounted receiver, then for each receipt", async (t) => {
  const h = harness();
  t.after(() => h.windows.forEach((win) => { if (!win.destroyed) win.destroy(); }));
  let completed = 0;
  const first = h.open("first").then((result) => { completed++; return result; });
  const second = h.open("second").then((result) => { completed++; return result; });
  const win = h.windows[0];
  assert.equal(h.windows.length, 1);
  assert.equal(win.sent.length, 0);
  win.loaded();
  await tick();
  assert.equal(win.sent.length, 0, "document load alone is not renderer readiness");
  h.ipcMain.emit("netcatty:window:editorReady", { sender: {} });
  await tick();
  assert.equal(win.sent.length, 0, "another window cannot claim readiness");
  h.ready(win);
  await tick();
  assert.equal(win.sent.length, 2);
  assert.equal(completed, 0);
  assert.equal(win.shown, undefined);
  h.accept(win, win.sent[1]);
  assert.deepEqual(await second, { success: true, reused: true });
  assert.equal(completed, 1);
  h.accept(win, win.sent[0]);
  assert.deepEqual(await first, { success: true, reused: false });
  assert.deepEqual(win.sent.map((request) => request.payload.content), ["edited first", "edited second"]);
  assert.equal(h.ipcMain.listenerCount("netcatty:window:editorOpenTabResult"), 0);
});

test("failed cold load leaves every unaccepted source tab intact", async () => {
  const h = harness();
  const first = h.open("first");
  const second = h.open("second");
  h.windows[0].failed(new Error("load failed"));
  assert.equal((await first).success, false);
  assert.equal((await second).success, false);
  assert.deepEqual(h.source.sent, [], "cleanup must not close tabs still owned by the source");
  assert.equal(h.ipcMain.listenerCount("netcatty:window:editorReady"), 0);
});

test("receiver rejection and window loss do not report successful delivery", async () => {
  const h = harness();
  const opening = h.open("first");
  const win = h.windows[0];
  win.loaded(); h.ready(win); await tick();
  h.accept(win, win.sent[0], false);
  assert.equal((await opening).success, false);
  const next = h.open("second");
  await tick(); win.destroy();
  assert.equal((await next).success, false);
  assert.deepEqual(h.source.sent, []);
  assert.equal(h.ipcMain.listenerCount("netcatty:window:editorOpenTabResult"), 0);
});
