"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createPreloadApi } = require("./api.cjs");

test("paste ID is opt-in and receipts use direct IPC with removable subscription", () => {
  const ipcRenderer = new EventEmitter();
  const sent = [];
  ipcRenderer.send = (...args) => sent.push(args);
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
