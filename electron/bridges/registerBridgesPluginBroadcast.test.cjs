"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("actual plugin broadcast skips destroyed WebContents while its BrowserWindow is still alive", () => {
  // Evaluate the actual registrar callback with narrow window fixtures. This
  // models the destruction-event ordering, not an installed Electron crash.
  const source = fs.readFileSync(path.join(__dirname, "../main/registerBridges.cjs"), "utf8");
  const callbacks = [...source.matchAll(/broadcast: \(channel, payload\) => \{([\s\S]*?)\n      \},/g)];
  assert.equal(callbacks.length, 1);
  const received = [];
  const deadWindow = { isDestroyed: () => true, get webContents() { throw Error("Destroyed BrowserWindow getter"); } };
  const closingWindow = { isDestroyed: () => false, webContents: {
    isDestroyed: () => true, send() { throw Error("Object has been destroyed"); },
  } };
  const liveWindow = { isDestroyed: () => false, webContents: {
    isDestroyed: () => false, send: (...args) => received.push(args),
  } };
  const broadcast = vm.runInNewContext(`(channel, payload) => {${callbacks[0][1]}\n}`, {
    electronModule: { BrowserWindow: { getAllWindows: () => [deadWindow, closingWindow, liveWindow] } },
  });
  const payload = { host: [], session: [] };
  assert.doesNotThrow(() => broadcast("netcatty:plugins:scope-catalog-changed", payload));
  assert.deepEqual(received, [["netcatty:plugins:scope-catalog-changed", payload]]);
});
