"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createPreloadApi } = require("./api.cjs");

function createMockIpc(overrides = {}) {
  const ipcRenderer = new EventEmitter();
  const invoked = [];
  const sent = [];
  ipcRenderer.invoke = overrides.invoke ?? (async (...args) => { invoked.push(args); });
  ipcRenderer.send = overrides.send ?? ((...args) => { sent.push(args); });
  return { ipcRenderer, invoked, sent };
}

test("backup write and export forward the serialized JSON payload unchanged", async () => {
  const { ipcRenderer, invoked } = createMockIpc();
  const api = createPreloadApi({ ipcRenderer, webUtils: {} });
  const payload = { json: "[]" };
  await api.aiSessionsBackupWrite(payload);
  await api.aiSessionsBackupExport(payload);
  assert.deepEqual(invoked, [
    ["netcatty:aiSessionsBackup:write", payload],
    ["netcatty:aiSessionsBackup:export", payload],
  ]);
  for (const [, argument] of invoked) assert.equal(typeof argument.json, "string");
});

test("password-availability subscription exposes no IPC payload and unsubscribes", () => {
  const { ipcRenderer } = createMockIpc();
  const api = createPreloadApi({ ipcRenderer, webUtils: {} });
  const calls = [];
  const unsubscribe = api.onCloudSyncSessionPasswordAvailable((...args) => calls.push(args));
  ipcRenderer.emit("netcatty:cloudSync:session:passwordAvailable", { sender: "private" }, "must-not-forward");
  assert.deepEqual(calls, [[]]);
  unsubscribe();
  ipcRenderer.emit("netcatty:cloudSync:session:passwordAvailable", {});
  assert.equal(calls.length, 1);
  assert.equal(ipcRenderer.listenerCount("netcatty:cloudSync:session:passwordAvailable"), 0);
});

function createEditorHarness(pending = []) {
  const { ipcRenderer, sent } = createMockIpc();
  const editorOpenTabState = { pending, listeners: new Set() };
  const api = createPreloadApi({ editorOpenTabState, ipcRenderer, webUtils: {} });
  return { api, sent, editorOpenTabState };
}

test("editor receiver announces readiness after subscribing and acknowledges installed contents", () => {
  const h = createEditorHarness();
  const received = [];
  const off = h.api.onEditorWindowOpenTab((payload) => {
    assert.equal(h.sent.length, 1, "receipt must follow installation");
    received.push(payload.content);
  });
  assert.deepEqual(h.sent, [["netcatty:window:editorReady"]]);
  const message = { requestId: "open-1", content: "unsaved" };
  for (const receive of h.editorOpenTabState.listeners) receive(message);
  assert.deepEqual(received, ["unsaved"]);
  assert.deepEqual(h.sent[1], ["netcatty:window:editorOpenTabResult", { requestId: "open-1", ok: true }]);
  off();
  assert.equal(h.editorOpenTabState.listeners.size, 0);
});

test("failed renderer installation sends a negative receipt", () => {
  const h = createEditorHarness();
  h.api.onEditorWindowOpenTab(() => { throw new Error("cannot install"); });
  for (const receive of h.editorOpenTabState.listeners) receive({ requestId: "open-2" });
  assert.deepEqual(h.sent.at(-1), [
    "netcatty:window:editorOpenTabResult",
    { requestId: "open-2", ok: false, error: "cannot install" },
  ]);
});

test("queued tabs are installed by the mounted receiver before cleanup", () => {
  const h = createEditorHarness([{ requestId: "queued", content: "unsaved" }]);
  let installed = 0;
  const off = h.api.onEditorWindowOpenTab(() => { installed += 1; });
  off();
  h.api.onEditorWindowOpenTab(() => { installed += 1; });
  assert.equal(installed, 1);
  assert.equal(h.editorOpenTabState.pending.length, 0);
});

test("browser requests survive before the lazy terminal receiver subscribes", () => {
  const { ipcRenderer } = createMockIpc();
  const api = createPreloadApi({ ipcRenderer, webUtils: {} });
  const first = { host: { id: "first" } };
  const second = { host: { id: "second" }, url: "http://localhost:3000/" };
  const delivered = [];
  ipcRenderer.emit("netcatty:host-browser:request-panel", {}, first);
  ipcRenderer.emit("netcatty:host-browser:request-panel", {}, second);
  const off = api.onHostBrowserPanelRequest((request) => delivered.push(request));
  assert.deepEqual(delivered, [first, second]);
  off();
  const third = { host: { id: "third" } };
  ipcRenderer.emit("netcatty:host-browser:request-panel", {}, third);
  const offAgain = api.onHostBrowserPanelRequest((request) => delivered.push(request));
  assert.deepEqual(delivered, [first, second, third], "queued requests must be consumed once");
  ipcRenderer.emit("netcatty:host-browser:request-panel", {}, first);
  assert.deepEqual(delivered, [first, second, third, first]);
  offAgain();
});

test("local file drag exposes only the dedicated start and cancellation channels", async () => {
  const calls = [];
  const api = createPreloadApi({
    ipcRenderer: {
      invoke: async (...args) => { calls.push(args); return { started: true }; },
      send: (...args) => calls.push(args),
    },
    webUtils: {},
  });
  const payload = { requestId: "one", paths: ["/file"] };
  assert.deepEqual(await api.startLocalFileDrag(payload), { started: true });
  api.cancelLocalFileDrag("one");
  assert.deepEqual(calls, [
    ["netcatty:local:drag-start", payload],
    ["netcatty:local:drag-cancel", { requestId: "one" }],
  ]);
});

test("paste ID is opt-in and receipts use direct IPC with removable subscription", () => {
  const { ipcRenderer, sent } = createMockIpc();
  const api = createPreloadApi({ ipcRenderer, webUtils: {} });
  api.writeToSession("s", "secret", { automated: true, lineDelayMs: 100, pasteRequestId: "uuid" });
  assert.equal(sent[0][0], "netcatty:write");
  assert.equal(sent[0][1].pasteRequestId, "uuid");
  api.writeToSession("s", "x");
  api.writeToSession("s", "x", { pasteRequestId: 17 });
  assert.equal(sent[1][1].pasteRequestId, undefined);
  assert.equal(sent[2][1].pasteRequestId, undefined);
  const calls = [];
  const unsubscribe = api.onTerminalPasteWrite((...args) => calls.push(args));
  const receipt = { sessionId: "s", requestId: "uuid", index: 0, done: true };
  ipcRenderer.emit("netcatty:paste-write", { sender: "private" }, receipt);
  assert.deepEqual(calls, [[receipt]]);
  unsubscribe();
  ipcRenderer.emit("netcatty:paste-write", {}, receipt);
  assert.equal(calls.length, 1);
  assert.equal(ipcRenderer.listenerCount("netcatty:paste-write"), 0);
});

test("cancel-only bypasses urgent raw-interrupt port while ordinary interrupt preserves it", () => {
  const { ipcRenderer, sent } = createMockIpc();
  const urgent = [];
  const api = createPreloadApi({
    ipcRenderer,
    webUtils: {},
    terminalUrgentInputPorts: {
      postInterrupt(...args) { urgent.push(args); return true; },
    },
  });
  api.interruptSession("s", undefined, { cancelPendingWritesOnly: true });
  assert.deepEqual(sent, [["netcatty:interrupt", { sessionId: "s", trace: undefined, cancelPendingWritesOnly: true }]]);
  assert.deepEqual(urgent, []);
  api.interruptSession("s");
  assert.equal(urgent.length, 1);
  assert.equal(sent.length, 1);
});

test("trusted AI preload uses dedicated typed channels and disposes subscriptions", async () => {
  const calls = [];
  const { ipcRenderer } = createMockIpc({
    invoke: async (...args) => { calls.push(args); return true; },
  });
  const api = createPreloadApi({ ipcRenderer, webUtils: {} });
  await api.setPluginAIHostReady(true);
  const reply = { requestId: "request", actionToken: "token", error: true };
  await api.respondPluginAIHost(reply);
  assert.deepEqual(calls, [
    ["netcatty:plugins:ai-host-ready", true],
    ["netcatty:plugins:ai-host-response", reply],
  ]);
  const received = [];
  const off = api.onPluginAIHostRequest((request) => received.push(request));
  const request = { kind: "model.select" };
  ipcRenderer.emit("netcatty:plugins:ai-host-request", {}, request);
  off();
  ipcRenderer.emit("netcatty:plugins:ai-host-request", {}, { kind: "context.select" });
  assert.deepEqual(received, [request]);
  assert.doesNotMatch(
    fs.readFileSync(path.join(__dirname, "../plugins/runtime/browserPreload.cjs"), "utf8"),
    /ai-host-|PluginAIHost/,
  );
});

test("system theme subscription forwards light/dark without exposing the IPC event and unsubscribes", () => {
  const channel = "netcatty:system-theme-changed";
  const { ipcRenderer } = createMockIpc();
  const api = createPreloadApi({ ipcRenderer, webUtils: {} });
  const calls = [];
  const unsubscribe = api.onSystemThemeChanged((...args) => calls.push(args));
  ipcRenderer.emit(channel, { sender: "private" }, { isDark: true });
  ipcRenderer.emit(channel, { sender: "private" }, { isDark: false });
  assert.deepEqual(calls, [[{ isDark: true }], [{ isDark: false }]]);
  unsubscribe();
  ipcRenderer.emit(channel, {}, { isDark: true });
  assert.equal(calls.length, 2);
  assert.equal(ipcRenderer.listenerCount(channel), 0);
});

test("system theme subscription ignores malformed payloads", () => {
  const channel = "netcatty:system-theme-changed";
  const { ipcRenderer } = createMockIpc();
  const api = createPreloadApi({ ipcRenderer, webUtils: {} });
  const calls = [];
  const unsubscribe = api.onSystemThemeChanged((payload) => calls.push(payload));
  for (const payload of [undefined, null, {}, { isDark: "false" }, { isDark: 0 }]) {
    ipcRenderer.emit(channel, {}, payload);
  }
  unsubscribe();
  assert.deepEqual(calls, []);
});
