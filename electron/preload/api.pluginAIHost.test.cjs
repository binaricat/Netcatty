"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { createPreloadApi } = require("./api.cjs");

test("trusted AI preload uses dedicated typed channels and disposes subscriptions", async () => {
  const calls = []; const ipcRenderer = new EventEmitter();
  ipcRenderer.invoke = async (...args) => { calls.push(args); return true; };
  const api = createPreloadApi({ ipcRenderer, webUtils: {} });
  await api.setPluginAIHostReady(true);
  const reply = { requestId: "request", actionToken: "token", error: true };
  await api.respondPluginAIHost(reply);
  assert.deepEqual(calls, [["netcatty:plugins:ai-host-ready", true], ["netcatty:plugins:ai-host-response", reply]]);
  const received = []; const off = api.onPluginAIHostRequest((request) => received.push(request));
  const request = { kind: "model.select" };
  ipcRenderer.emit("netcatty:plugins:ai-host-request", {}, request); off();
  ipcRenderer.emit("netcatty:plugins:ai-host-request", {}, { kind: "context.select" });
  assert.deepEqual(received, [request]);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, "../plugins/runtime/browserPreload.cjs"), "utf8"), /ai-host-|PluginAIHost/);
});
