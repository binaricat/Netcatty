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
    close() { const event = { prevented: false, preventDefault() { this.prevented = true; } }; this.emit("close", event); if (!event.prevented) this.destroy(); }
    destroy() { this.destroyed = true; this.webContents.emit("destroyed"); this.emit("closed"); }
  }
  const source = Object.assign(new EventEmitter(), { id: 99, isDestroyed: () => false, sent: [], send(channel, payload) { this.sent.push({ channel, payload }); } });
  const sources = new Map([[source.id, source]]);
  const electron = { BrowserWindow, ipcMain, webContents: { fromId: (id) => sources.get(id) } };
  const context = { currentTheme: "dark", mainWindow: null, isQuitting: false,
    V8_CACHE_OPTIONS: "code", resolveFrontendBackgroundColor: () => "#000", resolveSettingsWindowBounds: () => ({}),
    registerAppContentWindow() {}, unregisterAppContentWindow() {}, notifyAppContentWindowClosed() {},
    createExternalOnlyWindowOpenHandler() {}, applyWindowOpacityToWindow() {}, showAndFocusWindow(win) { win.shown = true; },
  };
  const api = createEditorWindowApi(context);
  const open = (id, owner = source) => { sources.set(owner.id, owner); return api.openEditorWindow(electron, { sourceWebContents: owner }, snapshot(id)); };
  const ready = (win) => ipcMain.emit("netcatty:window:editorReady", { sender: win.webContents });
  const accept = (win, request, ok = true) => ipcMain.emit("netcatty:window:editorOpenTabResult", { sender: win.webContents }, { requestId: request.payload.requestId, ok });
  return { windows, source, ipcMain, open, ready, accept, api, electron, context };
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


test("close during cold start waits for the receiver and the open receipt", async () => {
  const h = harness();
  const opening = h.open("first");
  const closing = h.api.closeEditorTabs(h.electron, { editorIds: ["first"] });
  const win = h.windows[0];
  assert.equal(h.api.hasEditorTabsForSource(h.source), true, "pending transfers retain source ownership");
  assert.equal(win.sent.length, 0);
  win.loaded(); h.ready(win); await tick();
  assert.deepEqual(win.sent.map((request) => request.channel), ["netcatty:window:editorOpenTab"]);
  h.accept(win, win.sent[0]); await opening; await tick();
  const closeRequest = win.sent[1];
  assert.equal(closeRequest.channel, "netcatty:window:editorCloseTabs");
  h.ipcMain.emit("netcatty:window:editorCloseTabsResult", { sender: win.webContents }, { requestId: closeRequest.payload.requestId, cancelled: false, closedIds: ["first"] });
  assert.deepEqual(await closing, { success: true, cancelled: false, closedIds: ["first"] });
  assert.equal(h.api.hasEditorTabsForSource(h.source), false);
  assert.deepEqual(h.source.sent.at(-1), { channel: "netcatty:window:editorTabsClosed", payload: { editorIds: ["first"] } });
  win.destroy();
});

test("cancelling source-window close preserves its save and dock route and does not close other owners", async () => {
  const h = harness();
  const other = Object.assign(new EventEmitter(), { id: 100, isDestroyed: () => false, send() {} });
  const first = h.open("first");
  const second = h.open("second", other);
  const win = h.windows[0];
  win.loaded(); h.ready(win); await tick();
  for (const request of win.sent) h.accept(win, request);
  await Promise.all([first, second]);
  const closing = h.api.closeEditorTabsForSource(h.electron, h.source);
  await tick();
  const request = win.sent.at(-1);
  assert.deepEqual(request.payload.editorIds, ["first"]);
  h.ipcMain.emit("netcatty:window:editorCloseTabsResult", { sender: win.webContents }, { requestId: request.payload.requestId, cancelled: true, closedIds: [] });
  assert.equal((await closing).cancelled, true);
  assert.equal(h.api.hasEditorTabsForSource(h.source), true);
  assert.equal(h.api.hasEditorTabsForSource(other), true);
  const saving = h.api.saveEditorTab(h.electron, snapshot("first"));
  const saveRequest = h.source.sent.at(-1);
  assert.equal(saveRequest.channel, "netcatty:window:editorSaveRequest");
  h.ipcMain.emit("netcatty:window:editorSaveResult", { sender: h.source }, { requestId: saveRequest.payload.requestId, ok: true });
  assert.equal((await saving).ok, true);
  const docking = h.api.dockEditorTab(h.electron, snapshot("first"));
  const dockRequest = h.source.sent.at(-1);
  assert.equal(dockRequest.channel, "netcatty:window:editorDockRequest");
  h.ipcMain.emit("netcatty:window:editorDockResult", { sender: h.source }, { requestId: dockRequest.payload.requestId, ok: true });
  assert.equal((await docking).success, true);
  assert.equal(h.api.hasEditorTabsForSource(h.source), false);
  assert.equal(h.api.hasEditorTabsForSource(other), true);
  win.destroy();
});

test("a failed transfer vetoes a simultaneous source close without deleting its retained copy", async () => {
  const h = harness();
  const opening = h.open("first");
  const closing = h.api.closeEditorTabsForSource(h.electron, h.source);
  h.windows[0].failed(new Error("load failed"));
  assert.equal((await opening).success, false);
  assert.equal((await closing).cancelled, true);
  assert.deepEqual(h.source.sent, []);
});


test("native editor close uses renderer confirmation, preserves Cancel, and coalesces repeated close events", async () => {
  const h = harness();
  const opening = h.open("first");
  const win = h.windows[0];
  win.loaded(); h.ready(win); await tick();
  h.accept(win, win.sent[0]); await opening;
  win.close(); win.close(); await tick();
  assert.equal(win.isDestroyed(), false);
  const requests = () => win.sent.filter((request) => request.channel === "netcatty:window:editorCloseTabs");
  assert.equal(requests().length, 1);
  assert.deepEqual(requests()[0].payload.editorIds, ["first"]);
  assert.equal(requests()[0].payload.force, false);
  h.ipcMain.emit("netcatty:window:editorCloseTabsResult", { sender: win.webContents }, { requestId: requests()[0].payload.requestId, cancelled: true, closedIds: [] });
  await tick();
  assert.equal(win.isDestroyed(), false, "Cancel keeps the native window and its contents open");
  assert.equal(h.api.hasEditorTabsForSource(h.source), true);
  win.close(); await tick();
  assert.equal(requests().length, 2, "native close can be retried after Cancel");
  h.ipcMain.emit("netcatty:window:editorCloseTabsResult", { sender: win.webContents }, { requestId: requests()[1].payload.requestId, cancelled: false, closedIds: ["first"] });
  await tick();
  assert.equal(win.isDestroyed(), true, "Save/Discard completion permits native destruction");
  assert.equal(h.api.hasEditorTabsForSource(h.source), false);
});


test("editor module parses in strict mode without a with scope", () => {
  const source = require("node:fs").readFileSync(require.resolve("./editorWindow.cjs"), "utf8");
  assert.doesNotThrow(() => new Function("require", "module", "exports", '"use strict";\n' + source));
});

test("editor close reads the live quitting context instead of a captured value", async () => {
  const h = harness();
  const opening = h.open("first");
  const win = h.windows[0];
  win.loaded(); h.ready(win); await tick();
  h.accept(win, win.sent[0]); await opening;
  Object.defineProperty(h.context, "isQuitting", { get: () => true });
  win.close();
  assert.equal(win.isDestroyed(), true);
  assert.equal(win.sent.some((request) => request.channel === "netcatty:window:editorCloseTabs"), false);
});
