const assert = require("node:assert/strict");
const test = require("node:test");
const { createPreloadApi } = require("./api.cjs");

function harness(pending = []) {
  const sent = [];
  const editorOpenTabState = { pending, listeners: new Set() };
  const api = createPreloadApi({ editorOpenTabState, ipcRenderer: { send: (...args) => sent.push(args) }, webUtils: {} });
  return { api, sent, editorOpenTabState };
}

test("editor receiver announces readiness after subscribing and acknowledges installed contents", () => {
  const h = harness();
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
  const h = harness();
  h.api.onEditorWindowOpenTab(() => { throw new Error("cannot install"); });
  for (const receive of h.editorOpenTabState.listeners) receive({ requestId: "open-2" });
  assert.deepEqual(h.sent.at(-1), ["netcatty:window:editorOpenTabResult", { requestId: "open-2", ok: false, error: "cannot install" }]);
});

test("queued tabs are installed by the mounted receiver before cleanup", () => {
  const h = harness([{ requestId: "queued", content: "unsaved" }]);
  let installed = 0;
  const off = h.api.onEditorWindowOpenTab(() => { installed++; });
  off();
  h.api.onEditorWindowOpenTab(() => { installed++; });
  assert.equal(installed, 1);
  assert.equal(h.editorOpenTabState.pending.length, 0);
});
